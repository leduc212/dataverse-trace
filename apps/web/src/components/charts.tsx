// Small SVG charts following the reference palette and mark specs: thin columns (≤24 px) with
// 4 px rounded data-ends and a 2 px surface gap between stacked segments, hairline recessive grid,
// a legend for ≥2 series, and a hover tooltip on every mark.
import { ErrorCircleRegular } from '@fluentui/react-icons';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatShortDateTime, formatDay } from '../format.ts';

export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Rounds up to a clean axis maximum: 1, 2, 5 × 10ⁿ. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/** A rect with 4 px rounded top corners and a square base. */
function topRounded(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

export function ChartTooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
      {tip.content}
    </div>
  );
}

export interface ColumnBucket {
  start: number;
  end: number;
  ok: number;
  errors: number;
}

interface StackedColumnsProps {
  buckets: ColumnBucket[];
  height?: number;
  gaps?: Array<[number, number]>;
  onSelect?: (bucket: ColumnBucket) => void;
  label: string;
}

/** Executions over time: succeeded (blue) with failures stacked on top (critical red). */
export function StackedColumns({ buckets, height = 120, gaps = [], onSelect, label }: StackedColumnsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const padLeft = 36;
  const padBottom = 18;
  const plotW = Math.max(0, width - padLeft);
  const plotH = height - padBottom;
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.ok + b.errors)));
  const first = buckets[0]?.start ?? 0;
  const last = buckets[buckets.length - 1]?.end ?? 1;
  const span = Math.max(1, last - first);
  const band = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => plotH - (v / max) * plotH;
  const xOf = (t: number) => padLeft + ((t - first) / span) * plotW;
  const showDay = span > 2 * 86_400_000;
  const tickTimes = buckets.length ? [first, first + span / 2, last] : [];

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className={f === 0 ? 'baseline' : 'gridline'} x1={padLeft} x2={width} y1={y(max * f)} y2={y(max * f)} />
              <text className="tick" x={padLeft - 6} y={y(max * f) + 4} textAnchor="end">
                {(max * f).toLocaleString('en-US')}
              </text>
            </g>
          ))}
          {gaps.map(([a, b]) => {
            const x1 = Math.max(padLeft, xOf(a));
            const x2 = Math.min(width, xOf(b));
            return x2 > x1 ? (
              <rect key={`${a}`} className="gap-band" x={x1} y={0} width={x2 - x1} height={plotH}>
                <title>No data collected (the app wasn't syncing for more than a day)</title>
              </rect>
            ) : null;
          })}
          {buckets.map((b, i) => {
            const cx = padLeft + i * band + (band - barW) / 2;
            const okH = plotH - y(b.ok);
            const errH = plotH - y(b.errors);
            const gap = b.ok > 0 && b.errors > 0 ? 2 : 0;
            return (
              <g key={b.start}>
                {b.ok > 0 && (b.errors > 0 ? <rect x={cx} y={y(b.ok)} width={barW} height={okH} fill="var(--viz-series-1)" /> : <path d={topRounded(cx, y(b.ok), barW, okH)} fill="var(--viz-series-1)" />)}
                {b.errors > 0 && <path d={topRounded(cx, y(b.ok) - gap - errH, barW, errH)} fill="var(--viz-critical)" />}
                <rect
                  x={padLeft + i * band}
                  y={0}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                  onClick={() => onSelect?.(b)}
                  onMouseMove={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({
                      x: Math.min(e.clientX - rect.left, width - 180),
                      y: e.clientY - rect.top,
                      content: (
                        <>
                          <div className="muted">
                            {formatShortDateTime(b.start)} – {formatShortDateTime(b.end)}
                          </div>
                          <div className="t-row">
                            <span className="legend">
                              <span className="key">
                                <span className="swatch" style={{ background: 'var(--viz-series-1)' }} />
                                Succeeded
                              </span>
                            </span>
                            <b>{b.ok.toLocaleString('en-US')}</b>
                          </div>
                          <div className="t-row">
                            <span className="legend">
                              <span className="key">
                                <span className="swatch" style={{ background: 'var(--viz-critical)' }} />
                                Failed
                              </span>
                            </span>
                            <b>{b.errors.toLocaleString('en-US')}</b>
                          </div>
                        </>
                      ),
                    });
                  }}
                />
              </g>
            );
          })}
          {tickTimes.map((t, i) => (
            <text key={i} className="tick" x={xOf(t)} y={height - 4} textAnchor={i === 0 ? 'start' : i === tickTimes.length - 1 ? 'end' : 'middle'}>
              {showDay ? formatDay(t) : formatShortDateTime(t)}
            </text>
          ))}
        </svg>
      )}
      <ChartTooltip tip={tip} />
    </div>
  );
}

export function StackedLegend() {
  return (
    <div className="legend">
      <span className="key">
        <span className="swatch" style={{ background: 'var(--viz-series-1)' }} />
        Succeeded
      </span>
      <span className="key">
        <span className="swatch" style={{ background: 'var(--viz-critical)' }} />
        <ErrorCircleRegular fontSize={12} />
        Failed
      </span>
    </div>
  );
}

const SEQ_STEPS = 8;

/** Executions per day × hour, sequential blue (light = few, dark = many). */
export function Heatmap({ days, counts, errors, max }: { days: string[]; counts: number[][]; errors: number[][]; max: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const labelW = 72;
  const cell = Math.max(6, Math.min(22, Math.floor((width - labelW) / 24)));
  const gap = 2;
  const height = days.length * (cell + gap) + 18;
  const step = (v: number) => (v === 0 ? 0 : Math.min(SEQ_STEPS - 1, 1 + Math.floor(((v - 1) / Math.max(max, 1)) * (SEQ_STEPS - 1))));
  const dayLabel = (key: string) => formatDay(new Date(`${key}T12:00:00`).getTime());
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
      {width > 0 && days.length > 0 && (
        <svg width={width} height={height} role="img" aria-label="Executions per day and hour">
          {days.map((d, r) => (
            <g key={d}>
              <text className="tick" x={labelW - 6} y={r * (cell + gap) + cell / 2 + 4} textAnchor="end">
                {dayLabel(d)}
              </text>
              {counts[r]!.map((v, h) => (
                <rect
                  key={h}
                  x={labelW + h * (cell + gap)}
                  y={r * (cell + gap)}
                  width={cell}
                  height={cell}
                  rx={2}
                  fill={`var(--viz-seq-${step(v)})`}
                  onMouseMove={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({
                      x: Math.min(e.clientX - rect.left, width - 170),
                      y: e.clientY - rect.top,
                      content: (
                        <>
                          <div className="muted">
                            {dayLabel(d)}, {String(h).padStart(2, '0')}:00–{String(h + 1).padStart(2, '0')}:00
                          </div>
                          <div className="t-row">
                            Executions <b>{v.toLocaleString('en-US')}</b>
                          </div>
                          <div className="t-row">
                            Failed <b>{errors[r]![h]!.toLocaleString('en-US')}</b>
                          </div>
                        </>
                      ),
                    });
                  }}
                />
              ))}
            </g>
          ))}
          {[0, 6, 12, 18].map((h) => (
            <text key={h} className="tick" x={labelW + h * (cell + gap)} y={height - 4}>
              {String(h).padStart(2, '0')}:00
            </text>
          ))}
        </svg>
      )}
      <ChartTooltip tip={tip} />
    </div>
  );
}

export function HeatmapScale({ max }: { max: number }) {
  return (
    <div className="legend">
      <span className="muted">Fewer</span>
      {Array.from({ length: SEQ_STEPS }, (_, i) => (
        <span key={i} className="swatch" style={{ background: `var(--viz-seq-${i})` }} />
      ))}
      <span className="muted">More (max {max.toLocaleString('en-US')} per hour)</span>
    </div>
  );
}

/** Tiny trend line in the de-emphasis hue, with the latest point in the accent. */
export function Sparkline({ values, width = 90, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const lastI = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--viz-muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(lastI)} cy={y(values[lastI]!)} r={3} fill="var(--viz-series-1)" stroke="var(--viz-surface)" strokeWidth={1.5} />
    </svg>
  );
}
