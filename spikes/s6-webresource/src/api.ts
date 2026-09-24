// Same-origin Dataverse Web API access. Works in the page and in the worker because both are served
// from the environment's origin, so the browser attaches the existing session cookie. No tokens.

export const API_ROOT = `${self.location.origin}/api/data/v9.2/`;

export interface ODataCollection<T = Record<string, unknown>> {
  value: T[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getJson<T>(path: string, { annotations = true } = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'OData-Version': '4.0',
    'OData-MaxVersion': '4.0',
  };
  if (annotations) headers['Prefer'] = 'odata.include-annotations="*"';
  const response = await fetch(API_ROOT + path, { credentials: 'same-origin', headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message += `: ${body.error.message}`;
    } catch {
      // Body wasn't JSON; the status line is enough.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export const formatted = (row: Record<string, unknown>, column: string): string | undefined =>
  row[`${column}@OData.Community.Display.V1.FormattedValue`] as string | undefined;

/** True when an ISO timestamp string carries fractional seconds, e.g. `…:12.345Z`. */
export const hasFractionalSeconds = (value: unknown): boolean =>
  typeof value === 'string' && /T\d{2}:\d{2}:\d{2}\.\d+/.test(value);
