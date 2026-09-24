const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortDateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const isToday = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();

/** "14:03:21" today, "Sep 23, 14:03:21" otherwise. */
export const formatTime = (ts: number) => (isToday(ts) ? time.format(ts) : dateTime.format(ts));
export const formatShortDateTime = (ts: number) => shortDateTime.format(ts);
export const formatDay = (ts: number) => day.format(ts);

/** "12 s ago", "5 min ago", "3 h ago", or a date. */
export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'never';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return shortDateTime.format(ts);
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '–');

/** "Harbor.Plugins.PolicyErpSync" → "PolicyErpSync" for tight spaces. */
export const shortTypeName = (typeName: string) => typeName.split('.').pop() ?? typeName;

export const STAGE_LABELS: Record<number, string> = { 10: 'Pre-validation', 20: 'Pre-operation', 30: 'Main operation', 40: 'Post-operation' };

/** Auto-compacting count for stat tiles: 1,284 / 12.9K / 4.2M. */
export function compactCount(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
