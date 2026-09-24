import { describe, expect, it } from 'vitest';
import { expectedFor, type Observed } from './expected.ts';
import type { ProcessDefinition } from './records.ts';
import { T0, flowProcess, step, trigger } from './test-builders.ts';

const workflow = (p: Partial<ProcessDefinition> = {}): ProcessDefinition => ({
  ...flowProcess(),
  id: 'wf-1',
  name: 'Risk',
  category: 'workflow',
  categoryCode: 0,
  primaryEntity: 'account',
  mode: 'background',
  flowTrigger: null,
  activationIds: ['act-1'],
  modifiedOn: T0,
  ...p,
});

const observed = (p: Partial<Observed> = {}): Observed => ({ steps: new Map(), workflowActivationIds: new Set(), flows: new Map(), traceSetting: 2, ...p });
const byName = (items: ReturnType<typeof expectedFor>) => new Map(items.map((i) => [i.name, i]));

describe('expectedFor: plug-in steps', () => {
  it('orders sync steps by stage and rank, async steps after them, and skips other messages and tables', () => {
    const items = expectedFor({
      table: 'account',
      change: 'update',
      changedColumns: ['name'],
      processes: [],
      steps: [
        step({ id: 'post', pluginTypeName: 'Post', stage: 40, rank: 1 }),
        step({ id: 'pre', pluginTypeName: 'Pre', stage: 20, rank: 2 }),
        step({ id: 'async', pluginTypeName: 'Async', stage: 40, rank: 1, mode: 'async' }),
        step({ id: 'create', pluginTypeName: 'OnCreate', messageName: 'Create' }),
        step({ id: 'contact', pluginTypeName: 'OnContact', primaryEntity: 'contact' }),
        step({ id: 'any', pluginTypeName: 'AnyTable', primaryEntity: null, stage: 10 }),
      ],
    });
    expect(items.map((i) => i.name)).toEqual(['AnyTable', 'Pre', 'Post', 'Async']);
    expect(items[0]!.reasons).toContain('registered for all tables');
    expect(items[3]!.phase).toBe('Async step');
  });

  it('explains disabled steps, and reports how often a step ran', () => {
    const items = byName(
      expectedFor({
        table: 'account',
        change: 'update',
        changedColumns: ['name'],
        processes: [],
        steps: [step({ id: 'off', pluginTypeName: 'Off', enabled: false }), step({ id: 'twice', pluginTypeName: 'Twice' })],
        observed: observed({ steps: new Map([['twice', ['s1', 's2']]]) }),
      }),
    );
    expect(items.get('Off')).toMatchObject({ shouldRun: false, reasons: ['the step is disabled'], ran: 'no' });
    expect(items.get('Twice')).toMatchObject({ ran: 'yes', ranDetail: 'ran 2 times', spanIds: ['s1', 's2'] });
  });

  it('says why a step that should have run left no trace', () => {
    const steps = [step({ id: 's', pluginTypeName: 'S' })];
    const base = { table: 'account', change: 'update' as const, changedColumns: ['name'], processes: [], steps };
    expect(expectedFor(base)[0]).toMatchObject({ ran: 'unknown', ranDetail: 'no save selected' });
    expect(expectedFor({ ...base, observed: observed({ traceSetting: 0 }) })[0]!.ranDetail).toBe('trace logging is Off');
    expect(expectedFor({ ...base, observed: observed({ traceSetting: 1 }) })[0]!.ranDetail).toMatch(/only failures/);
    expect(expectedFor({ ...base, observed: observed() })[0]).toMatchObject({ ran: 'no', ranDetail: expect.stringMatching(/no trace was found/) });
  });
});

describe('expectedFor: classic workflows and business rules', () => {
  const change = (c: 'create' | 'update' | 'delete', p: Partial<ProcessDefinition>, columns: string[] | null = ['name']) =>
    expectedFor({ table: 'account', change: c, changedColumns: columns, steps: [], processes: [workflow(p)] })[0]!;

  it('follows the workflow triggers for create, update columns and delete', () => {
    expect(change('create', { triggerOnCreate: true })).toMatchObject({ shouldRun: true, reasons: ['starts when a record is created'] });
    expect(change('create', { triggerOnCreate: false })).toMatchObject({ shouldRun: false, reasons: ["doesn't start on create"] });
    expect(change('delete', { triggerOnDelete: true })).toMatchObject({ shouldRun: true, reasons: ['starts when a record is deleted'] });
    expect(change('delete', { triggerOnDelete: false }).shouldRun).toBe(false);
    expect(change('update', { triggerOnUpdateAttributes: null })).toMatchObject({ shouldRun: false, reasons: ["doesn't start on updates"] });
    expect(change('update', { triggerOnUpdateAttributes: ['name'] })).toMatchObject({ shouldRun: true, reasons: [expect.stringContaining('changed name')] });
    expect(change('update', { triggerOnUpdateAttributes: ['revenue'] }).reasons[0]).toMatch(/starts when these change: revenue/);
    expect(change('update', { triggerOnUpdateAttributes: ['revenue'] }, null).shouldRun).toBe('unknown');
    expect(change('create', { active: false })).toMatchObject({ shouldRun: false, reasons: ["the workflow isn't activated"] });
  });

  it('places real-time workflows in the transaction and background ones after it', () => {
    expect(change('create', { triggerOnCreate: true, mode: 'realtime' }).phase).toBe('Real-time workflow');
    expect(change('create', { triggerOnCreate: true }).phase).toBe('Background workflow');
  });

  it('marks a workflow as run when a system job used one of its activations', () => {
    const items = expectedFor({
      table: 'account',
      change: 'create',
      changedColumns: null,
      steps: [],
      processes: [workflow({ triggerOnCreate: true })],
      observed: observed({ workflowActivationIds: new Set(['act-1']) }),
    });
    expect(items[0]).toMatchObject({ ran: 'yes', ranDetail: 'a system job ran for it' });
  });

  it('real-time workflows leave no system job, so "not seen" stays unknown', () => {
    const items = expectedFor({ table: 'account', change: 'create', changedColumns: null, steps: [], processes: [workflow({ triggerOnCreate: true, mode: 'realtime' })], observed: observed() });
    expect(items[0]).toMatchObject({ ran: 'unknown', ranDetail: 'runs without leaving a trace' });
  });

  it('lists business rules as unknown (active) or not expected (inactive)', () => {
    const rule = (active: boolean) => expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps: [], processes: [workflow({ category: 'businessRule', active })] })[0]!;
    expect(rule(true)).toMatchObject({ kind: 'businessRule', shouldRun: 'unknown', ran: 'unknown' });
    expect(rule(false)).toMatchObject({ shouldRun: false, ran: 'no' });
  });

  it('ignores processes on other tables', () => {
    expect(expectedFor({ table: 'contact', change: 'create', changedColumns: null, steps: [], processes: [workflow({ triggerOnCreate: true })] })).toEqual([]);
  });
});

describe('expectedFor: cloud flows', () => {
  const flow = (p: Partial<ProcessDefinition>, values?: Record<string, unknown>, obs?: Observed) =>
    expectedFor({ table: 'account', change: 'update', changedColumns: ['name'], steps: [], processes: [flowProcess(p)], ...(values ? { recordValues: values } : {}), ...(obs ? { observed: obs } : {}) })[0];

  it('evaluates the filter expression against the record', () => {
    const t = trigger({ filterExpression: 'revenue gt 1000' });
    expect(flow({ flowTrigger: t }, { revenue: 5000 })).toMatchObject({ shouldRun: true, reasons: [expect.any(String), 'filter "revenue gt 1000" is true'] });
    expect(flow({ flowTrigger: t }, { revenue: 5 })).toMatchObject({ shouldRun: false, ran: 'no' });
    expect(flow({ flowTrigger: t }, {})!.shouldRun).toBe('unknown');
  });

  it("can't evaluate trigger conditions, and says so", () => {
    expect(flow({ flowTrigger: trigger({ conditions: ['@equals(1,1)'] }) })).toMatchObject({ shouldRun: 'unknown', reasons: [expect.any(String), "1 trigger condition(s) can't be checked"] });
  });

  it('shows a linked run with its confidence, and explains missing runs', () => {
    expect(flow({}, undefined, observed({ flows: new Map([['flow-1', { spanId: 'x', confidence: 0.7 }]]) }))).toMatchObject({ ran: 'yes', confidence: 0.7, spanIds: ['x'] });
    expect(flow({}, undefined, observed())!.ranDetail).toMatch(/no matching run/);
    expect(flow({ active: false })).toMatchObject({ shouldRun: false, reasons: ['the flow is turned off'] });
    expect(flow({ flowTrigger: trigger({ table: 'contact' }) })).toBeUndefined();
  });
});
