// How the app talks to Dataverse. In an environment, FetchTransport sends same-origin requests that
// carry the user's session cookie (no tokens). Demo mode swaps in a MockTransport with the same shape.

export interface RequestOptions {
  /** Ask for formatted values and lookup annotations (`Prefer: odata.include-annotations="*"`). */
  annotations?: boolean;
  /** `Prefer: odata.maxpagesize=N`. */
  maxPageSize?: number;
  signal?: AbortSignal;
}

export interface Transport {
  /** GET a path relative to `/api/data/v9.2/` (or an absolute `@odata.nextLink`); returns parsed JSON. */
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  /**
   * PATCH a record. The app's only write: switching the trace-log setting during watch mode, after
   * the user explicitly agrees (and always restoring it).
   */
  patch(path: string, body: Record<string, unknown>): Promise<void>;
}

export interface ODataPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const isForbidden = (e: unknown) => e instanceof HttpError && (e.status === 401 || e.status === 403);

/** Yields each page of a collection query, following `@odata.nextLink`. */
export async function* pages<T>(transport: Transport, path: string, options: RequestOptions = {}): AsyncGenerator<T[]> {
  let next: string | undefined = path;
  while (next) {
    options.signal?.throwIfAborted();
    const page: ODataPage<T> = await transport.get<ODataPage<T>>(next, options);
    yield page.value;
    next = page['@odata.nextLink'];
  }
}

export async function getAll<T>(transport: Transport, path: string, options: RequestOptions = {}): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages<T>(transport, path, options)) all.push(...page);
  return all;
}

export interface FetchTransportOptions {
  /** Origin of the environment, e.g. `https://contoso.crm.dynamics.com`. */
  origin: string;
  maxConcurrent?: number;
  maxRetries?: number;
  /** Called when the service asks us to wait (429/503 with Retry-After). */
  onThrottle?: (waitMs: number) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FetchTransport implements Transport {
  readonly #base: string;
  readonly #origin: string;
  readonly #maxConcurrent: number;
  readonly #maxRetries: number;
  readonly #onThrottle: ((waitMs: number) => void) | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(options: FetchTransportOptions) {
    this.#origin = options.origin.replace(/\/$/, '');
    this.#base = `${this.#origin}/api/data/v9.2/`;
    this.#maxConcurrent = options.maxConcurrent ?? 4;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#onThrottle = options.onThrottle;
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active++;
  }

  #release(): void {
    this.#active--;
    this.#queue.shift()?.();
  }

  #url(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      if (!path.startsWith(`${this.#origin}/`)) throw new Error(`Refusing to call another origin: ${path}`);
      return path;
    }
    return this.#base + path.replace(/^\//, '');
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const prefer: string[] = [];
    if (options.annotations !== false) prefer.push('odata.include-annotations="*"');
    if (options.maxPageSize) prefer.push(`odata.maxpagesize=${options.maxPageSize}`);
    const response = await this.#send('GET', path, undefined, prefer, options.signal);
    return (await response.json()) as T;
  }

  async patch(path: string, body: Record<string, unknown>): Promise<void> {
    await this.#send('PATCH', path, body, [], undefined);
  }

  async #send(method: 'GET' | 'PATCH', path: string, body: Record<string, unknown> | undefined, prefer: string[], signal: AbortSignal | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0' };
    if (prefer.length) headers['Prefer'] = prefer.join(',');
    if (body) headers['Content-Type'] = 'application/json';
    // PATCH to a record id must never create one: If-Match: * makes it update-only.
    if (method === 'PATCH') headers['If-Match'] = '*';
    const url = this.#url(path);

    for (let attempt = 0; ; attempt++) {
      await this.#acquire();
      let response: Response;
      try {
        const init: RequestInit = { method, credentials: 'same-origin', headers };
        if (body) init.body = JSON.stringify(body);
        if (signal) init.signal = signal;
        response = await this.#fetch(url, init);
      } finally {
        this.#release();
      }
      if ((response.status === 429 || response.status === 503) && attempt < this.#maxRetries) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 300) * 1000 : 2 ** attempt * 1000;
        this.#onThrottle?.(waitMs);
        await this.#sleep(waitMs);
        signal?.throwIfAborted();
        continue;
      }
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`.trim();
        let code: string | undefined;
        try {
          const err = (await response.json()) as { error?: { message?: string; code?: string } };
          if (err.error?.message) message = err.error.message;
          code = err.error?.code;
        } catch {
          // Not JSON; keep the status line.
        }
        throw new HttpError(response.status, message, code);
      }
      return response;
    }
  }
}
