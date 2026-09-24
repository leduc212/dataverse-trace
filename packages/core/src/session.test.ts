import { describe, expect, it } from 'vitest';
import { assembleTrace } from './correlate.ts';
import { DEFAULT_REDACTION, NO_REDACTION, createSession, maskText, parseSession, redactSession, sessionFileName, validateSession } from './session.ts';
import { T0, traceLog } from './test-builders.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const CORR = '5d8e6c2a-1b3f-4a7e-9c0d-2f4b6a8c0e1f';
const USER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const trace = assembleTrace(CORR, {
  traceLogs: [
    traceLog({ id: 'a', correlationId: CORR, requestId: 'r1', start: T0, durationMs: 40, typeName: 'Harbor.Validate' }),
    traceLog({ id: 'b', correlationId: CORR, requestId: 'r2', depth: 2, start: T0 + 10, durationMs: 20, primaryEntity: 'contact', typeName: 'Harbor.Nested' }),
  ],
  asyncOps: [],
  steps: new Map(),
})!;
trace.anchor = { table: 'account', id: '11111111-2222-4333-8444-555555555555', name: 'Contoso Ltd', exact: true };
trace.spans[0]!.name = 'Update Contoso Ltd by Jamie Ortiz';

const session = createSession({
  exportedAt: T0,
  appVersion: '0.2.0',
  kind: 'trace',
  title: 'Update Contoso Ltd',
  environment: 'harbor.crm.dynamics.com',
  trace,
  steps: {},
  texts: { 'plugintracelog:a': `Entered Harbor.Validate, Initiating User: ${USER}\nMailed jamie@harbor.example about 123456.78` },
});

describe('session files', () => {
  it('round-trips through JSON and validates', () => {
    const parsed = parseSession(JSON.stringify(session));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.session).toEqual(session);
  });

  it('rejects other files, newer versions and broken structure with clear reasons', () => {
    expect(parseSession('not json')).toMatchObject({ ok: false });
    expect(validateSession({ format: 'x' })).toEqual({ ok: false, errors: ['This is not a Dataverse Trace session file.'] });
    expect(validateSession({ ...session, version: 99 })).toMatchObject({ ok: false, errors: [expect.stringContaining('version 99')] });
    const broken = clone(session);
    (broken.trace.spans[0] as unknown as Record<string, unknown>)['start'] = 'yesterday';
    broken.trace.links.push({ from: 'nope', to: broken.trace.spans[0]!.id, type: 'childOf', confidence: 2, rule: 'R1', evidence: [] });
    const result = validateSession(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('trace.spans[0].start must be a number');
      expect(result.errors.some((e) => e.includes("from doesn't name a span"))).toBe(true);
      expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
    }
    const html = clone(session);
    (html.trace.spans[0]!.attrs as Record<string, unknown>)['x'] = { nested: true };
    expect(validateSession(html).ok).toBe(false);
  });

  it('masks emails, GUIDs and long numbers in text', () => {
    expect(maskText(`a ${USER} b jamie@harbor.example c 123456 d 42`)).toBe('a [guid] b [email] c [number] d 42');
  });

  it('redacts names, hosts and ids consistently, keeping links intact', () => {
    const red = redactSession(session, DEFAULT_REDACTION, { users: ['Jamie Ortiz'], records: ['Contoso Ltd'] });
    const json = JSON.stringify(red);
    for (const secret of ['Jamie Ortiz', 'Contoso', 'harbor.crm.dynamics.com', CORR, USER, 'jamie@harbor.example']) expect(json).not.toContain(secret);
    expect(red.trace.spans[0]!.name).toBe('Update Record 1 by User 1');
    expect(red.environment).toBeNull();
    expect(red.redaction).toEqual(DEFAULT_REDACTION);
    // Still a valid session whose links point at real spans.
    expect(validateSession(red).ok).toBe(true);
    expect(red.trace.key).toBe(red.trace.spans[0]!.correlationId);
  });

  it('can leave trace text out, or keep everything', () => {
    expect(redactSession(session, { ...DEFAULT_REDACTION, traceText: 'remove' }).texts).toBeUndefined();
    const kept = redactSession(session, NO_REDACTION);
    expect({ ...kept, redaction: null }).toEqual(session);
  });

  it('names export files after the title and date', () => {
    expect(sessionFileName(session)).toBe('dvtrace-update-contoso-ltd-2026-09-24.dvtrace.json');
  });
});
