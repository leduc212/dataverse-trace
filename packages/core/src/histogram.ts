// Mergeable log-scale duration histogram (64 buckets, 1 ms … ~21 min, each bucket ×1.25), so
// percentiles over long ranges can be computed from hourly rollups instead of raw rows.

export const BUCKETS = 64;
const GROWTH = 1.25;
const LOG_GROWTH = Math.log(GROWTH);

export type Histogram = Uint32Array;

export const createHistogram = (): Histogram => new Uint32Array(BUCKETS);

/** Bucket index for a duration in ms. Bucket 0 holds values below 1 ms. */
export function bucketOf(ms: number): number {
  if (!(ms >= 1)) return 0;
  return Math.min(BUCKETS - 1, 1 + Math.floor(Math.log(ms) / LOG_GROWTH));
}

/** Upper bound (ms) of a bucket. */
export const bucketUpper = (index: number): number => (index === 0 ? 1 : GROWTH ** index);

export function record(h: Histogram, ms: number): void {
  h[bucketOf(ms)]!++;
}

export function merge(into: Histogram, from: Histogram): Histogram {
  for (let i = 0; i < BUCKETS; i++) into[i]! += from[i]!;
  return into;
}

export const count = (h: Histogram): number => h.reduce((a, b) => a + b, 0);

/** Approximate quantile (0–1): the upper bound of the bucket holding it (error ≤ 25 %). */
export function histogramQuantile(h: Histogram, q: number): number | null {
  const total = count(h);
  if (total === 0) return null;
  const target = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += h[i]!;
    if (seen >= target) return bucketUpper(i);
  }
  return bucketUpper(BUCKETS - 1);
}

/**
 * Estimated quantile (0–1), interpolated geometrically inside the bucket that holds it. Still within
 * the bucket's bounds, but it moves smoothly as counts shift instead of jumping 25 % at a time, so
 * two periods can be compared.
 */
export function histogramQuantileInterpolated(h: Histogram, q: number): number | null {
  const total = count(h);
  if (total === 0) return null;
  const target = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const n = h[i]!;
    if (n > 0 && seen + n >= target) {
      const f = (target - seen) / n;
      if (i === 0) return f;
      const lower = bucketUpper(i - 1);
      return lower * (bucketUpper(i) / lower) ** f;
    }
    seen += n;
  }
  return bucketUpper(BUCKETS - 1);
}

/** Exact quantile (nearest-rank) of an ascending-sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}
