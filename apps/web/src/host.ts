import type { HostInfo } from './shared/api.ts';

/** Dataverse hosts: *.crm.dynamics.com, *.crm4.dynamics.com, … (commercial cloud). */
const DATAVERSE_HOST = /\.crm\d*\.dynamics\.com$/i;

/**
 * Where is the app running? Inside a Dataverse environment it reads that environment with the
 * signed-in user's session. Anywhere else (GitHub Pages, localhost) it runs the demo.
 * `?demo=1` forces the demo, even inside an environment.
 */
export function detectHost(location: Location = window.location): HostInfo {
  const forceDemo = new URLSearchParams(location.search).get('demo') === '1';
  if (!forceDemo && DATAVERSE_HOST.test(location.hostname)) {
    return { kind: 'environment', origin: location.origin, envKey: location.hostname.toLowerCase() };
  }
  return { kind: 'demo' };
}

/** Link to a record form in the model-driven app, or `null` in the demo. */
export function recordUrl(host: HostInfo | null, table: string, id: string): string | null {
  if (host?.kind !== 'environment') return null;
  return `${host.origin}/main.aspx?etn=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}&pagetype=entityrecord`;
}
