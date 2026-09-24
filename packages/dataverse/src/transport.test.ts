import { describe, expect, it, vi } from 'vitest';
import { FetchTransport, HttpError, getAll } from './transport.ts';

const ORIGIN = 'https://harbor.crm.dynamics.com';

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('No more fake responses');
    return next();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('FetchTransport', () => {
  it('sends same-origin requests with OData headers and Prefer options', async () => {
    const { fn, calls } = fakeFetch([json({ value: [] })]);
    const t = new FetchTransport({ origin: ORIGIN, fetch: fn });
    await t.get('plugintracelogs?$top=1', { maxPageSize: 500 });
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/data/v9.2/plugintracelogs?$top=1`);
    expect(calls[0]!.init!.credentials).toBe('same-origin');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['OData-Version']).toBe('4.0');
    expect(headers['Prefer']).toBe('odata.include-annotations="*",odata.maxpagesize=500');
  });

  it('omits the annotations preference when asked', async () => {
    const { fn, calls } = fakeFetch([json({})]);
    await new FetchTransport({ origin: ORIGIN, fetch: fn }).get('WhoAmI', { annotations: false });
    expect((calls[0]!.init!.headers as Record<string, string>)['Prefer']).toBeUndefined();
  });

  it('waits for Retry-After on 429 and retries', async () => {
    const { fn } = fakeFetch([json({}, 429, { 'Retry-After': '7' }), json({ ok: 1 })]);
    const sleep = vi.fn(async () => {});
    const onThrottle = vi.fn();
    const result = await new FetchTransport({ origin: ORIGIN, fetch: fn, sleep, onThrottle }).get<{ ok: number }>('x');
    expect(result.ok).toBe(1);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(onThrottle).toHaveBeenCalledWith(7000);
  });

  it('gives up after maxRetries and throws the error message from the body', async () => {
    const { fn } = fakeFetch([json({}, 429), json({}, 429), json({ error: { code: '0x80072322', message: 'Number of requests exceeded the limit' } }, 429)]);
    const t = new FetchTransport({ origin: ORIGIN, fetch: fn, sleep: async () => {}, maxRetries: 2 });
    await expect(t.get('x')).rejects.toMatchObject({ status: 429, code: '0x80072322', message: 'Number of requests exceeded the limit' });
  });

  it('throws HttpError on failures', async () => {
    const { fn } = fakeFetch([json({ error: { message: 'Principal user is missing prvReadPluginTraceLog privilege.' } }, 403)]);
    const error = await new FetchTransport({ origin: ORIGIN, fetch: fn }).get('plugintracelogs').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403 });
  });

  it('follows next links on the same origin and refuses other origins', async () => {
    const { fn, calls } = fakeFetch([json({ value: [1, 2], '@odata.nextLink': `${ORIGIN}/api/data/v9.2/x?$skiptoken=2` }), json({ value: [3] })]);
    const t = new FetchTransport({ origin: ORIGIN, fetch: fn });
    expect(await getAll<number>(t, 'x')).toEqual([1, 2, 3]);
    expect(calls[1]!.url).toBe(`${ORIGIN}/api/data/v9.2/x?$skiptoken=2`);
    await expect(t.get('https://evil.example/api/data/v9.2/x')).rejects.toThrow('another origin');
  });

  it('limits concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const fn = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = new FetchTransport({ origin: ORIGIN, fetch: fn, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 7 }, () => t.get('x')));
    expect(peak).toBe(2);
  });
});
