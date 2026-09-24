import { mapAsyncOperation, mapTraceLog } from '@dvt/dataverse';
import { assembleTrace, computeStepStats, type StepRegistration } from '@dvt/core';
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
    const expectedParent: Record<string, string> = {
      'Harbor.Plugins.AccountRollup': 'Harbor.Plugins.PolicyPostCreate',
      'Harbor.Plugins.AccountContactCount': 'Harbor.Plugins.ContactSyncToAccount',
      'Harbor.Plugins.ContactAudit': 'Harbor.Plugins.AccountContactCount',
      'Harbor.Plugins.ContactSyncToAccount': 'Harbor.Plugins.AccountContactCount',
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
        const isCorrect = spanName.get(link!.from) === expectedParent[spanName.get(childStep.to)!];
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
});
