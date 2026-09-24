import { auditChanges, mapAsyncOperation, mapAudit, mapFlowRun, mapProcesses, mapTraceLog } from '@dvt/dataverse';
import { assembleTrace, buildRecordStory, computeStepStats, findSaves, type AuditRecord, type StepRegistration } from '@dvt/core';
import { describe, expect, it } from 'vitest';
import { generateDemo } from './generator.ts';

const NOW = Date.UTC(2026, 8, 24, 15, 0, 0);
const demo = generateDemo({ now: NOW });
const logs = demo.traceLogs.map(mapTraceLog);
const jobs = demo.asyncOperations.map(mapAsyncOperation);
const DAY = 86_400_000;

describe('generateDemo', () => {
  it('is deterministic for the same seed and time', () => {
    const again = generateDemo({ now: NOW });
    expect(again.traceLogs.length).toBe(demo.traceLogs.length);
    expect(again.traceLogs[123]).toEqual(demo.traceLogs[123]);
    expect(generateDemo({ now: NOW, seed: 7 }).traceLogs[0]).not.toEqual(demo.traceLogs[0]);
  });

  it('produces a realistic volume, all in the past, with whole-second timestamps', () => {
    expect(logs.length).toBeGreaterThan(10_000);
    expect(logs.length).toBeLessThan(80_000);
    expect(logs.every((l) => l.start <= NOW)).toBe(true);
    expect(demo.traceLogs.every((r) => /:\d{2}Z$/.test(String(r['performanceexecutionstarttime'])))).toBe(true);
    expect(logs.every((l) => l.precision === 's')).toBe(true);
  });

  it('includes a recursive loop that reaches depth 8 and fails', () => {
    const deep = logs.filter((l) => l.depth === 8);
    expect(deep.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...logs.map((l) => l.depth))).toBe(8);
    expect(deep.every((l) => l.exception?.includes('Recursive update'))).toBe(true);
  });

  it('includes failed async jobs with retries', () => {
    const failed = jobs.filter((j) => j.statusCode === 31);
    expect(failed.length).toBeGreaterThan(5);
    expect(failed.every((j) => j.retryCount === 3 && j.regarding?.table === 'hbr_claim')).toBe(true);
  });

  it('makes PolicyErpSync slower in the last 5 days', () => {
    const erp = (from: number, to: number) =>
      computeStepStats(logs.filter((l) => l.typeName === 'Harbor.Plugins.PolicyErpSync' && l.start >= from && l.start < to))[0]!;
    const before = erp(NOW - 14 * DAY, NOW - 6 * DAY);
    const after = erp(NOW - 4 * DAY, NOW);
    expect(after.p95).toBeGreaterThan(before.p95 * 2);
    expect(after.p95).toBeGreaterThan(2000);
  });

  it('makes ContactAudit (no filtering attributes) noisy in the last day', () => {
    const audit = logs.filter((l) => l.typeName === 'Harbor.Plugins.ContactAudit' && l.start > NOW - DAY);
    expect(audit.length).toBeGreaterThan(200);
    const step = demo.steps.find((s) => String(s['name']).startsWith('Harbor.Plugins.ContactAudit'))!;
    expect(step['filteringattributes']).toBeNull();
  });

  it('R3 finds the true parent of every nested request in the demo (ground truth from the generator)', () => {
    // Which step issues the update that causes each nested step.
    // AccountContactCount runs for the account update issued by either step, but only one of
    // them is in a given operation, so the true parent is unambiguous.
    const expectedParent: Record<string, string[]> = {
      'Harbor.Plugins.AccountRollup': ['Harbor.Plugins.PolicyPostCreate'],
      'Harbor.Plugins.AccountContactCount': ['Harbor.Plugins.ContactSyncToAccount', 'Harbor.Plugins.PolicyPostCreate'],
      'Harbor.Plugins.ContactAudit': ['Harbor.Plugins.AccountContactCount'],
      'Harbor.Plugins.ContactSyncToAccount': ['Harbor.Plugins.AccountContactCount'],
    };
    const steps = new Map<string, StepRegistration>();
    const byCorrelation = new Map<string, typeof logs>();
    for (const l of logs) {
      if (!l.correlationId) continue;
      const list = byCorrelation.get(l.correlationId) ?? [];
      list.push(l);
      byCorrelation.set(l.correlationId, list);
    }
    let nestedRequests = 0;
    let exact = 0;
    let correct = 0;
    let exactCorrect = 0;
    for (const [correlationId, rows] of byCorrelation) {
      if (!rows.some((r) => r.depth > 1 && r.mode === 'sync')) continue;
      const trace = assembleTrace(correlationId, { traceLogs: rows, asyncOps: [], steps })!;
      const spanName = new Map(trace.spans.map((s) => [s.id, s.name]));
      for (const request of trace.spans.filter((s) => s.kind === 'request' && (s.depth ?? 0) > 1)) {
        nestedRequests++;
        const link = trace.links.find((l) => l.to === request.id && l.type === 'childOf');
        expect(link, `request ${request.name} at depth ${request.depth} has no parent`).toBeDefined();
        const childStep = trace.links.find((l) => l.from === request.id)!;
        const isCorrect = expectedParent[spanName.get(childStep.to)!]!.includes(spanName.get(link!.from)!);
        if (isCorrect) correct++;
        if (link!.confidence === 1) {
          exact++;
          if (isCorrect) exactCorrect++;
        }
      }
    }
    expect(nestedRequests).toBeGreaterThan(100);
    // Links shown as exact must never be wrong; ambiguous ones are flagged with lower confidence.
    expect(exactCorrect).toBe(exact);
    expect(correct / nestedRequests).toBeGreaterThan(0.95);
    expect(exact / nestedRequests).toBeGreaterThan(0.9);
  });

  it('builds consistent traces: nested requests fit inside their parent step', () => {
    const steps = new Map<string, StepRegistration>();
    const create = logs.find((l) => l.typeName === 'Harbor.Plugins.PolicyPostCreate')!;
    const trace = assembleTrace(create.correlationId!, { traceLogs: logs, asyncOps: jobs, steps })!;
    const nested = trace.spans.find((s) => s.kind === 'request' && s.depth === 2)!;
    const parentLink = trace.links.find((l) => l.to === nested.id && l.type === 'childOf')!;
    expect(parentLink.from).toBe(`plugintracelog:${create.id}`);
    expect(trace.spans.some((s) => s.kind === 'systemJob' && s.name === 'Calculate policy risk')).toBe(true);
    expect(trace.spans.some((s) => s.kind === 'workflowActivity')).toBe(true);
  });

  it('audits only committed saves, and runs plugin steps only when their filtering attributes changed', () => {
    const audits: AuditRecord[] = demo.audits.map((r) => ({ ...mapAudit(r), ...auditChanges(demo.auditDetails[String(r['auditid'])]!) }));
    expect(audits.length).toBeGreaterThan(5000);
    const runs = demo.flowRuns.map(mapFlowRun);
    const ran = (a: AuditRecord) => {
      const record = { table: a.table, id: a.recordId, name: '' };
      const save = findSaves({ record, audits: [a], traceLogs: [], asyncOps: [] })[0]!;
      const story = buildRecordStory(save, { record, audits: [a], traceLogs: logs.filter((l) => Math.abs(l.start - a.createdOn) < 60_000), asyncOps: [], flowRuns: runs, processes: [], steps: new Map(), now: NOW });
      return story.trace.spans.map((s) => s.name).join('|');
    };
    const updates = audits.filter((a) => a.table === 'hbr_policy' && a.operation === 'update');
    const quiet = updates.filter((a) => a.changedColumns!.every((c) => c === 'hbr_description')).slice(0, 60);
    const premium = updates.filter((a) => a.changedColumns!.includes('hbr_premium')).slice(0, 60);
    expect(quiet.length).toBe(60);
    // A description-only save runs no plug-in steps, so no operation is found for it.
    expect(quiet.filter((a) => /Policy(Validate|ErpSync)/.test(ran(a))).length).toBeLessThan(3);
    expect(premium.filter((a) => /PolicyValidate/.test(ran(a))).length).toBeGreaterThan(50);
    // Rejected saves (PolicyValidate threw) rolled back: no audit row at that time for any policy.
    const rejected = logs.filter((l) => l.typeName === 'Harbor.Plugins.PolicyValidate' && l.exception);
    expect(rejected.length).toBeGreaterThan(5);
  });

  it('I2 links flow runs to the save that triggered them (ground truth from the generator)', () => {
    const sorted = [...logs].sort((a, b) => a.start - b.start);
    const runs = demo.flowRuns.map(mapFlowRun);
    const processes = mapProcesses(demo.workflows, new Map(demo.workflows.map((w) => [String(w['workflowid']).toLowerCase(), w['clientdata']])));
    const audits: AuditRecord[] = demo.audits.map((r) => ({ ...mapAudit(r), ...auditChanges(demo.auditDetails[String(r['auditid'])]!) }));
    const byRecord = new Map<string, AuditRecord[]>();
    for (const a of audits) {
      const list = byRecord.get(a.recordId) ?? [];
      list.push(a);
      byRecord.set(a.recordId, list);
    }
    const sortedJobs = [...jobs].sort((a, b) => a.createdOn - b.createdOn);
    // Rows within ±10 minutes of `t`, from rows sorted by `time`.
    const near = <T>(rows: T[], time: (r: T) => number, t: number) => {
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (time(rows[mid]!) < t - 600_000) lo = mid + 1;
        else hi = mid;
      }
      const out: T[] = [];
      for (let i = lo; i < rows.length && time(rows[i]!) < t + 600_000; i++) out.push(rows[i]!);
      return out;
    };
    let linked = 0;
    let confident = 0;
    let confidentCorrect = 0;
    let correct = 0;
    for (const [recordId, list] of [...byRecord].slice(0, 600)) {
      const record = { table: list[0]!.table, id: recordId, name: '' };
      const saves = findSaves({ record, audits: list, traceLogs: [], asyncOps: [] });
      for (const save of saves) {
        const story = buildRecordStory(save, {
          saves,
          record,
          audits: list,
          traceLogs: near(sorted, (l) => l.start, save.time),
          asyncOps: near(sortedJobs, (j) => j.createdOn, save.time),
          flowRuns: runs,
          processes,
          steps: new Map(),
          now: NOW,
        });
        for (const f of story.flows) {
          if (!f.runId) continue;
          const truth = demo.truth.flowRunSaves[f.runId];
          const ok = truth !== undefined && truth.recordId === recordId && Math.floor(truth.time / 1000) === Math.floor(save.time / 1000);
          linked++;
          if (ok) correct++;
          if (f.confidence! >= 0.5) {
            confident++;
            if (ok) confidentCorrect++;
          }
        }
      }
    }
    expect(linked).toBeGreaterThan(500);
    // Links shown as likely (≥ 50 %) are almost always right; weaker ones are shown as such.
    expect(confidentCorrect / confident).toBeGreaterThan(0.97);
    expect(correct / linked).toBeGreaterThan(0.85);
  }, 30_000);

  it('scenario 7: three status changes within two seconds give lower-confidence flow links', () => {
    const policyId = Object.keys(demo.records['hbr_policy']!)[0]!;
    const audits: AuditRecord[] = demo.audits
      .filter((r) => r['_objectid_value'] === policyId)
      .map((r) => ({ ...mapAudit(r), ...auditChanges(demo.auditDetails[String(r['auditid'])]!) }));
    const record = { table: 'hbr_policy', id: policyId, name: '' };
    const burst = findSaves({ record, audits, traceLogs: [], asyncOps: [] }).filter((s) => Math.abs(s.time - (NOW - 2 * 3_600_000 - 17 * 60_000)) < 5000);
    expect(burst).toHaveLength(3);
    const runs = demo.flowRuns.map(mapFlowRun);
    const processes = mapProcesses(demo.workflows, new Map(demo.workflows.map((w) => [String(w['workflowid']).toLowerCase(), w['clientdata']])));
    const saves = findSaves({ record, audits, traceLogs: [], asyncOps: [] });
    const outcomes = burst.map((save) => {
      const story = buildRecordStory(save, { saves, record, audits, traceLogs: logs, asyncOps: jobs, flowRuns: runs, processes, steps: new Map(), now: NOW });
      return story.flows.find((f) => f.processName.startsWith('Notify'))!;
    });
    expect(outcomes.every((o) => o.confidence! < 0.8)).toBe(true);
    // Paired one-to-one: three saves, three different runs.
    expect(new Set(outcomes.map((o) => o.runId)).size).toBe(3);
  });
});
