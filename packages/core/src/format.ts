/** 0 → "0 ms", 850 → "850 ms", 1234 → "1.23 s", 61_000 → "1m 01s", 3_723_000 → "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '−' : '';
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  if (abs < 10_000) return `${sign}${(abs / 1000).toFixed(2)} s`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(abs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${sign}${h}h ${String(m).padStart(2, '0')}m` : `${sign}${m}m ${String(s).padStart(2, '0')}s`;
}

/** 1234 → "1,234". */
export const formatCount = (n: number): string => n.toLocaleString('en-US');

/** 0.0183 → "1.8 %". */
export const formatPercent = (ratio: number): string =>
  ratio === 0 ? '0 %' : ratio < 0.001 ? '<0.1 %' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)} %`;
