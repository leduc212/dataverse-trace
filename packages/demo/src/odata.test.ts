import { describe, expect, it } from 'vitest';
import { evaluate, parseFilter, parseRequest, project, sortRows } from './odata.ts';

const row = {
  id: '11111111-2222-3333-4444-555555555555',
  name: "O'Brien",
  mode: 1,
  createdon: '2026-09-24T08:00:05Z',
  statuscode: 30,
  deleted: false,
  nothing: null,
};

describe('parseFilter + evaluate', () => {
  it.each([
    ['mode eq 1', true],
    ['mode ne 1', false],
    ["name eq 'o''brien'", true],
    ['createdon ge 2026-09-24T08:00:05.000Z', true],
    ['createdon gt 2026-09-24T08:00:05Z', false],
    ['createdon lt 2026-09-24T09:00:00Z and mode eq 1', true],
    ['(statuscode eq 31 or statuscode eq 30) and mode eq 1', true],
    ['not (mode eq 1)', false],
    ['deleted eq false', true],
    ['nothing eq null', true],
    ['nothing ne null', false],
    ['id eq 11111111-2222-3333-4444-555555555555', true],
    ["Microsoft.Dynamics.CRM.In(PropertyName='id',PropertyValues=['99999999-2222-3333-4444-555555555555','11111111-2222-3333-4444-555555555555'])", true],
    ["Microsoft.Dynamics.CRM.In(PropertyName='mode',PropertyValues=[2,3])", false],
  ])('%s → %s', (filter, expected) => expect(evaluate(parseFilter(filter), row)).toBe(expected));

  it('rejects unsupported syntax', () => {
    expect(() => parseFilter('contains(name,"x")')).toThrow();
    expect(() => parseFilter('mode has 1')).toThrow('Unsupported operator');
  });
});

describe('parseRequest', () => {
  it('parses resource, options and absolute next links', () => {
    const r = parseRequest(
      "https://x.crm.dynamics.com/api/data/v9.2/sdkmessageprocessingsteps?$select=name,rank&$filter=rank%20gt%201&$orderby=rank desc,name&$top=5&$expand=sdkmessageid($select=name),plugintypeid($select=typename,assemblyname)&$skiptoken=10",
    );
    expect(r).toMatchObject({
      resource: 'sdkmessageprocessingsteps',
      select: ['name', 'rank'],
      orderBy: [
        { field: 'rank', desc: true },
        { field: 'name', desc: false },
      ],
      top: 5,
      expand: ['sdkmessageid', 'plugintypeid'],
      skip: 10,
    });
  });

  it('parses navigation paths', () => {
    expect(parseRequest('systemusers(ABC)/systemuserroles_association?$select=roleid')).toMatchObject({ resource: 'systemusers', key: 'abc', navigation: 'systemuserroles_association' });
  });

  it('throws on options it does not support', () => {
    expect(() => parseRequest('accounts?$apply=groupby((name))')).toThrow('Unsupported');
  });
});

describe('project and sortRows', () => {
  const raw = { a: 1, b: 2, 'a@OData.Community.Display.V1.FormattedValue': 'one', nav: { x: 1 } };

  it('keeps selected columns, their annotations when asked, and expanded navigation', () => {
    expect(project(raw, parseRequest('t?$select=a&$expand=nav'), true)).toEqual({ a: 1, 'a@OData.Community.Display.V1.FormattedValue': 'one', nav: { x: 1 } });
    expect(project(raw, parseRequest('t?$select=a'), false)).toEqual({ a: 1 });
    expect(project(raw, parseRequest('t'), false)).toEqual({ a: 1, b: 2 });
  });

  it('sorts by several keys, nulls first ascending', () => {
    const rows = [{ k: 2, n: 'b' }, { k: null, n: 'z' }, { k: 1, n: 'c' }, { k: 2, n: 'a' }];
    expect(sortRows(rows, [{ field: 'k', desc: false }, { field: 'n', desc: false }]).map((r) => r.n)).toEqual(['z', 'c', 'a', 'b']);
  });
});
