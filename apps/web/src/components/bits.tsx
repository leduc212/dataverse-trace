import { formatDuration } from '@dvt/core';
import { ErrorCircleFilled } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

/** Duration with an inline bar on a log scale, so 20 ms and 20 s are both visible. */
export function DurationCell({ ms, maxMs = 30_000, error = false }: { ms: number; maxMs?: number; error?: boolean }) {
  const pct = Math.min(100, (Math.log10(1 + Math.max(ms, 0)) / Math.log10(1 + maxMs)) * 100);
  return (
    <span className="duration-cell">
      <span className="value num">{formatDuration(ms)}</span>
      <span className="track">
        <span className={`fill${error ? ' error' : ''}`} style={{ width: `${pct}%`, display: 'block' }} />
      </span>
    </span>
  );
}

export function ErrorMark({ title }: { title?: string }) {
  return (
    <span className="status-dot error-text" title={title}>
      <ErrorCircleFilled fontSize={14} />
    </span>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        {icon}
        <div className="title">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function KeyValues({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <Row key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v ?? '–'}</dd>
    </>
  );
}
