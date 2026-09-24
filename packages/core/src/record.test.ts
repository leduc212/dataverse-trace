import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expectedFor, type Observed } from './expected.ts';
import { MAX_INFERRED_CONFIDENCE, buildRecordStory, findSaves, parseRecordInput, type RecordStoryInput } from './record.ts';
import type { StepRegistration } from './records.ts';
import { T0, asyncOp, audit, flowProcess, flowRun, step, traceLog, trigger } from './test-builders.ts';

const record = { table: 'account', id: 'rec-1', name: 'Contoso' };
const input = (p: Partial<RecordStoryInput>): RecordStoryInput => ({
  record,
  audits: [],
  traceLogs: [],
  asyncOps: [],
  flowRuns: [],
  processes: [],
  steps: new Map<string, StepRegistration>(),
  ...p,
});

// One sync pipeline on account Update, 0–120 ms after T0; the audit is written at commit (T0 + 50).
const pipeline = (correlationId: string, offset = 0, user = 'user-1') => [
  traceLog({ correlationId, requestId: `${correlationId}-r`, start: T0 + offset, durationMs: 40, createdById: user }),
  traceLog({ correlationId, requestId: `${correlationId}-r`, start: T0 + offset, durationMs: 80, createdById: user }),
];

describe('findSaves', () => {
  it('turns audit rows into saves, one per transaction, newest first', () => {
    const saves = findSaves(
      input({
        audits: [
          audit({ id: 'a1', createdOn: T0, transactionId: 't1', changedColumns: ['name'] }),
          audit({ id: 'a2', createdOn: T0, transactionId: 't1', changedColumns: ['telephone1'] }),
          audit({ id: 'a3', createdOn: T0 + 60_000, transactionId: 't2' }),
          audit({ id: 'other-record', recordId: 'rec-2' }),
        ],
      }),
    );
    expect(saves.map((s) => s.auditIds)).toEqual([['a3'], ['a1', 'a2']]);
    expect(saves[1]!.changedColumns).toEqual(['name', 'telephone1']);
  });

  it('adds saves found through system jobs when audit is off', () => {
    const saves = findSaves(input({ traceLogs: pipeline('c1'), asyncOps: [asyncOp({ correlationId: 'c1', regarding: { table: 'account', id: 'REC-1' } })] }));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ source: 'systemJob', correlationId: 'c1', change: 'update', changedColumns: null });
  });
});

describe('buildRecordStory', () => {
  it('R5: links the save exactly when a system job in the operation is regarding the record', () => {
    const inp = input({
      audits: [audit()],
      traceLogs: [...pipeline('c1'), ...pipeline('c2')],
      asyncOps: [asyncOp({ correlationId: 'c1', regarding: { table: 'account', id: 'rec-1' }, createdOn: T0 + 100 })],
    });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    expect(story.correlationId).toBe('c1');
    expect(story.correlationConfidence).toBe(1);
    const link = story.trace.links.find((l) => l.from.startsWith('save:'))!;
    expect(link).toMatchObject({ rule: 'R5', confidence: 1, type: 'triggeredBy' });
  });

  it('I1: infers the operation from timing, table and message; high but never exact confidence when it is the only one', () => {
    const inp = input({ audits: [audit()], traceLogs: pipeline('c1') });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    expect(story.correlationId).toBe('c1');
    expect(story.correlationConfidence).toBe(MAX_INFERRED_CONFIDENCE);
    expect(story.trace.links.find((l) => l.rule === 'I1')!.evidence.map((e) => e.label).join(' | ')).toMatch(/inside this operation.*same table.*created by the user.*only operation/);
  });

  it('I1: lowers confidence when several operations on the table ran at the same time', () => {
    const inp = input({ audits: [audit()], traceLogs: [...pipeline('c1'), ...pipeline('c2')] });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    expect(story.correlationConfidence).toBeLessThan(0.5);
  });

  it('I1: ignores operations on other tables or outside the save time', () => {
    const inp = input({
      audits: [audit()],
      traceLogs: [traceLog({ correlationId: 'x', primaryEntity: 'contact' }), traceLog({ correlationId: 'y', start: T0 + 60_000 })],
    });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    expect(story.correlationId).toBeNull();
    expect(story.trace.caveats.map((c) => c.code)).toContain('noOperationFound');
  });

  it('I2: links a matching flow run with confidence and evidence, and its child flow exactly (R6)', () => {
    const parent = flowRun({ id: 'run-a', start: T0 + 3000 });
    const child = flowRun({ id: 'run-b', workflowId: 'child-flow', flowName: 'Child', parentRunId: parent.runId, start: T0 + 6000 });
    const inp = input({
      audits: [audit({ changedColumns: ['name'] })],
      traceLogs: pipeline('c1'),
      flowRuns: [parent, child],
      processes: [flowProcess({ flowTrigger: trigger({ filteringAttributes: ['name'] }) })],
    });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    const link = story.trace.links.find((l) => l.rule === 'I2')!;
    expect(link.to).toBe('flowrun:run-a');
    expect(link.confidence).toBeGreaterThan(0.8);
    expect(link.evidence.length).toBeGreaterThanOrEqual(3);
    expect(story.trace.links.find((l) => l.rule === 'R6')).toMatchObject({ from: 'flowrun:run-a', to: 'flowrun:run-b', confidence: 1 });
    expect(story.flows[0]).toMatchObject({ runId: 'run-a', shouldRun: true });
  });

  it("I2: explains why a flow didn't fire (filtering columns, filter expression, turned off)", () => {
    const inp = input({
      audits: [audit({ changedColumns: ['fax'], newValues: { fax: '1' } })],
      recordValues: { statecode: 1 },
      flowRuns: [flowRun({ workflowId: 'f1' }), flowRun({ workflowId: 'f2' }), flowRun({ workflowId: 'f3' })],
      processes: [
        flowProcess({ id: 'f1', name: 'Filtered', flowTrigger: trigger({ filteringAttributes: ['name'] }) }),
        flowProcess({ id: 'f2', name: 'Expression', flowTrigger: trigger({ filterExpression: 'statecode eq 0' }) }),
        flowProcess({ id: 'f3', name: 'Off', active: false }),
      ],
    });
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    const byName = Object.fromEntries(story.flows.map((f) => [f.processName, f]));
    expect(byName['Filtered']).toMatchObject({ shouldRun: false, runId: null });
    expect(byName['Filtered']!.reasons[0]).toContain('filters on name');
    expect(byName['Expression']!.reasons.join()).toContain('is false');
    expect(byName['Off']!.reasons).toEqual(['the flow is turned off']);
    expect(story.trace.spans.some((s) => s.kind === 'flowRun')).toBe(false);
  });

  it('I2: splits confidence when other saves of the same table could have triggered the run', () => {
    const run = flowRun({ start: T0 + 3000 });
    const alone = input({ audits: [audit()], traceLogs: pipeline('c1'), flowRuns: [run], processes: [flowProcess()] });
    const crowded = { ...alone, traceLogs: [...pipeline('c1'), ...pipeline('c2', 900, 'user-2'), ...pipeline('c3', 1500, 'user-3')] };
    const a = buildRecordStory(findSaves(alone)[0]!, alone).flows[0]!.confidence!;
    const b = buildRecordStory(findSaves(crowded)[0]!, crowded).flows[0]!.confidence!;
    expect(b).toBeLessThan(a / 2);
  });

  it('never links a run that started well before the save or after the window', () => {
    const inp = input({
      audits: [audit()],
      flowRuns: [flowRun({ start: T0 - 60_000 }), flowRun({ start: T0 + 10 * 60_000 })],
      processes: [flowProcess()],
    });
    expect(buildRecordStory(findSaves(inp)[0]!, inp).flows[0]!.runId).toBeNull();
  });

  it('confidence stays in (0, 1] and every inferred link has evidence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ offset: fc.integer({ min: -5000, max: 400_000 }) }), { maxLength: 6 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { maxLength: 4 }),
        (runs, pipelines) => {
          const inp = input({
            audits: [audit()],
            traceLogs: pipelines.flatMap((o, i) => pipeline(`c${i}`, o)),
            flowRuns: runs.map((r, i) => flowRun({ id: `r${i}`, start: T0 + r.offset })),
            processes: [flowProcess()],
          });
          const story = buildRecordStory(findSaves(inp)[0]!, inp);
          for (const l of story.trace.links) {
            expect(l.confidence).toBeGreaterThan(0);
            expect(l.confidence).toBeLessThanOrEqual(1);
            expect(l.evidence.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });
});

describe('expectedFor', () => {
  const steps = [
    step({ id: 'pre', stage: 10, rank: 1, filteringAttributes: ['name'], pluginTypeName: 'Validate' }),
    step({ id: 'post', stage: 40, rank: 1, filteringAttributes: null, pluginTypeName: 'Audit' }),
    step({ id: 'async', stage: 40, mode: 'async', filteringAttributes: ['fax'], pluginTypeName: 'Notify' }),
    step({ id: 'off', stage: 20, enabled: false, pluginTypeName: 'Disabled' }),
    step({ id: 'other', primaryEntity: 'contact', pluginTypeName: 'Contact' }),
  ];
  const processes = [
    flowProcess({ id: 'f1', name: 'Flow', flowTrigger: trigger({ filteringAttributes: ['name'] }) }),
    { ...flowProcess({ id: 'wf', name: 'Background WF', category: 'workflow', categoryCode: 0, primaryEntity: 'account', mode: 'background', triggerOnUpdateAttributes: ['name'], activationIds: ['act-1'] }), flowTrigger: null },
    { ...flowProcess({ id: 'br', name: 'Rule', category: 'businessRule', categoryCode: 2, primaryEntity: 'account' }), flowTrigger: null },
  ];

  it('lists registrations in execution order with should-run reasons', () => {
    const items = expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps, processes });
    expect(items.map((i) => i.name)).toEqual(['Validate', 'Disabled', 'Audit', 'Notify', 'Background WF', 'Flow', 'Rule']);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['Validate']!.shouldRun).toBe(true);
    expect(byName['Notify']!.shouldRun).toBe(false);
    expect(byName['Disabled']!.reasons).toEqual(['the step is disabled']);
    expect(byName['Rule']!.shouldRun).toBe('unknown');
    expect(items.every((i) => i.ran === 'unknown' || i.shouldRun === false || i.kind === 'businessRule')).toBe(true);
  });

  it('marks what ran, and explains what should have but did not', () => {
    const observed: Observed = {
      steps: new Map([['pre', ['plugintracelog:1']]]),
      workflowActivationIds: new Set(['act-1']),
      flows: new Map([['f1', { spanId: 'flowrun:x', confidence: 0.83 }]]),
      traceSetting: 2,
    };
    const items = expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps, processes, observed });
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['Validate']).toMatchObject({ ran: 'yes', spanIds: ['plugintracelog:1'] });
    expect(byName['Audit']!.ran).toBe('no');
    expect(byName['Audit']!.ranDetail).toContain('no trace');
    expect(byName['Background WF']!.ran).toBe('yes');
    expect(byName['Flow']).toMatchObject({ ran: 'yes', confidence: 0.83 });
    const exceptionsOnly = expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps, processes, observed: { ...observed, traceSetting: 1 } });
    expect(exceptionsOnly.find((i) => i.name === 'Audit')!.ran).toBe('unknown');
  });
});

describe('parseRecordInput', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  it.each([
    [`https://harbor.crm.dynamics.com/main.aspx?appid=1&pagetype=entityrecord&etn=account&id=${id}`, { table: 'account', id }],
    [`https://harbor.crm.dynamics.com/main.aspx?etn=Account&id=%7B${id.toUpperCase()}%7D`, { table: 'account', id }],
    [`https://harbor.crm.dynamics.com/main.aspx#etn=contact&id=${id}`, { table: 'contact', id }],
    [`hbr_policy:${id}`, { table: 'hbr_policy', id }],
    [`hbr_policy ${id}`, { table: 'hbr_policy', id }],
    [`{${id}}`, { table: null, id }],
    ['https://harbor.crm.dynamics.com/main.aspx?etn=account', null],
    ['Contoso', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(parseRecordInput(input)).toEqual(expected);
  });
});

describe('I2 pairing and live subscriptions', () => {
  it('pairs saves of the same record with runs one-to-one, so one run never explains two saves', () => {
    const inp = input({
      audits: [
        audit({ id: 'first', createdOn: T0, transactionId: 't1', changedColumns: ['name'], newValues: { name: 'A' } }),
        audit({ id: 'second', createdOn: T0 + 1000, transactionId: 't2', changedColumns: ['name'], newValues: { name: 'B' } }),
      ],
      flowRuns: [flowRun({ id: 'run-a', start: T0 + 3000 }), flowRun({ id: 'run-b', start: T0 + 5000 })],
      processes: [flowProcess()],
    });
    const saves = findSaves(inp);
    const runs = saves.map((s) => buildRecordStory(s, { ...inp, saves }).flows[0]!.runId);
    expect(new Set(runs).size).toBe(2);
    // Without the other saves, both would claim the nearest run.
    expect(saves.map((s) => buildRecordStory(s, inp).flows[0]!.runId)).toEqual(['run-a', 'run-a']);
  });

  it('explains when the only run went to another save', () => {
    const inp = input({
      audits: [
        audit({ id: 'first', createdOn: T0, transactionId: 't1', changedColumns: ['name'] }),
        audit({ id: 'second', createdOn: T0 + 1000, transactionId: 't2', changedColumns: ['name'] }),
      ],
      flowRuns: [flowRun({ id: 'run-a', start: T0 + 1500 })],
      processes: [flowProcess()],
    });
    const saves = findSaves(inp);
    const outcomes = saves.map((s) => buildRecordStory(s, { ...inp, saves }).flows[0]!);
    expect(outcomes.filter((o) => o.runId === 'run-a')).toHaveLength(1);
    expect(outcomes.find((o) => !o.runId)!.reasons.join(' ')).toMatch(/matched to other saves/);
  });

  it('flags flows without a live trigger subscription as "can\'t tell", and says so', () => {
    const inp = input({ audits: [audit({ changedColumns: ['name'] })], processes: [flowProcess({ subscription: 'missing' })] });
    const outcome = buildRecordStory(findSaves(inp)[0]!, inp).flows[0]!;
    expect(outcome.shouldRun).toBe('unknown');
    expect(outcome.reasons.join(' ')).toMatch(/no live trigger subscription/);
    const items = expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps: [], processes: [flowProcess({ subscription: 'missing' })] });
    expect(items[0]!.shouldRun).toBe('unknown');
  });
});
