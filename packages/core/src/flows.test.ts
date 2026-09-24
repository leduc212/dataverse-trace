import { describe, expect, it } from 'vitest';
import { annotateSubscriptions, changeKindOf, matchFilteringAttributes, parseFlowTrigger, subscriptionMatches, toSubscription } from './flows.ts';

const clientdata = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    properties: {
      connectionReferences: {},
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        triggers: {
          'When_a_row_is_added,_modified_or_deleted': {
            type: 'OpenApiConnectionWebhook',
            inputs: { host: { operationId: 'SubscribeWebhookTrigger' }, parameters },
            ...extra,
          },
        },
        actions: {},
      },
    },
    schemaVersion: '1.0.0.0',
  });

describe('parseFlowTrigger', () => {
  it('reads table, change kinds, filtering columns, filter expression and scope', () => {
    const t = parseFlowTrigger(
      clientdata({
        'subscriptionRequest/message': 4,
        'subscriptionRequest/entityname': 'Account',
        'subscriptionRequest/scope': 4,
        'subscriptionRequest/filteringattributes': 'name, telephone1',
        'subscriptionRequest/filterexpression': 'statecode eq 0',
      }),
    );
    expect(t).toEqual({
      table: 'account',
      changes: ['create', 'update'],
      filteringAttributes: ['name', 'telephone1'],
      filterExpression: 'statecode eq 0',
      scope: 4,
      conditions: [],
      delayed: false,
    });
  });

  it('keeps trigger conditions (which we cannot evaluate) and delays', () => {
    const t = parseFlowTrigger(
      clientdata(
        { 'subscriptionRequest/message': 3, 'subscriptionRequest/entityname': 'contact', 'subscriptionRequest/postponeuntil': '@addMinutes(utcNow(),5)' },
        { conditions: [{ expression: "@equals(triggerOutputs()?['body/statecode'], 0)" }] },
      ),
    )!;
    expect(t.conditions).toHaveLength(1);
    expect(t.delayed).toBe(true);
    expect(t.filteringAttributes).toBeNull();
  });

  it('returns null for non-Dataverse triggers, unknown messages and broken JSON', () => {
    expect(parseFlowTrigger(clientdata({ 'subscriptionRequest/message': 9, 'subscriptionRequest/entityname': 'account' }))).toBeNull();
    expect(parseFlowTrigger(JSON.stringify({ properties: { definition: { triggers: { manual: { type: 'Request', inputs: {} } } } } }))).toBeNull();
    expect(parseFlowTrigger('{not json')).toBeNull();
    expect(parseFlowTrigger(null)).toBeNull();
  });
});

describe('matchFilteringAttributes', () => {
  it('matches only updates, and says why', () => {
    expect(matchFilteringAttributes('create', ['name'], ['x']).match).toBe(true);
    expect(matchFilteringAttributes('update', null, ['x']).match).toBe(true);
    expect(matchFilteringAttributes('update', ['name', 'fax'], ['fax'])).toEqual({ match: true, reason: 'changed fax, which it filters on' });
    expect(matchFilteringAttributes('update', ['name'], ['fax']).match).toBe(false);
    expect(matchFilteringAttributes('update', ['name'], null).match).toBe('unknown');
  });

  it('maps message names', () => {
    expect([changeKindOf('Update'), changeKindOf('create'), changeKindOf('Assign'), changeKindOf(null)]).toEqual(['update', 'create', null, null]);
  });
});

describe('live trigger subscriptions', () => {
  const t = { table: 'account', changes: ['update' as const], filteringAttributes: ['name', 'telephone1'], filterExpression: 'revenue gt 1000', scope: 4, conditions: [], delayed: false };

  it('reads callbackregistration values', () => {
    expect(toSubscription('Account', 3, 'telephone1, name', ' revenue gt 1000 ')).toEqual({ table: 'account', changes: ['update'], filteringAttributes: ['telephone1', 'name'], filterExpression: 'revenue gt 1000' });
    expect(toSubscription('account', 99, null, null)).toBeNull();
  });

  it('matches table, changes, columns (in any order) and filter (ignoring spacing and case)', () => {
    expect(subscriptionMatches(t, toSubscription('account', 3, 'telephone1,name', 'Revenue  gt 1000')!)).toBe(true);
    expect(subscriptionMatches(t, toSubscription('account', 4, 'telephone1,name', 'revenue gt 1000')!)).toBe(false);
    expect(subscriptionMatches(t, toSubscription('account', 3, 'name', 'revenue gt 1000')!)).toBe(false);
    expect(subscriptionMatches(t, toSubscription('contact', 3, 'telephone1,name', 'revenue gt 1000')!)).toBe(false);
    expect(subscriptionMatches({ ...t, filteringAttributes: null, filterExpression: null }, toSubscription('account', 3, null, '')!)).toBe(true);
  });

  it('annotates active flows only, and claims nothing when subscriptions are unreadable', () => {
    const flow = { id: 'f', name: 'F', category: 'flow' as const, categoryCode: 5, active: true, primaryEntity: null, mode: null, scope: null, triggerOnCreate: false, triggerOnDelete: false, triggerOnUpdateAttributes: null, activationIds: [], flowTrigger: t, modifiedOn: 0 };
    const sub = toSubscription('account', 3, 'name,telephone1', 'revenue gt 1000')!;
    expect(annotateSubscriptions([flow], [sub])[0]!.subscription).toBe('found');
    expect(annotateSubscriptions([flow], [])[0]!.subscription).toBe('missing');
    expect(annotateSubscriptions([{ ...flow, active: false }], [])[0]!.subscription).toBeNull();
    expect(annotateSubscriptions([flow], null)[0]!.subscription).toBeNull();
  });
});
