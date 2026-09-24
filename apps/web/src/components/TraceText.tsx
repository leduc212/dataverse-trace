import { Button, Input, Switch, Tooltip } from '@fluentui/react-components';
import { ArrowDownRegular, ArrowUpRegular, CopyRegular, SearchRegular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces a JSON object/array embedded in a line with its pretty-printed form. */
export function prettyLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.search(/[[{]/);
    if (start >= 0) {
      const candidate = line.slice(start).trim();
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (typeof parsed === 'object' && parsed !== null) {
          const prefix = line.slice(0, start).trimEnd();
          if (prefix) out.push(prefix);
          out.push(...JSON.stringify(parsed, null, 2).split('\n'));
          continue;
        }
      } catch {
        // Not JSON; keep the line as it is.
      }
    }
    out.push(line);
  }
  return out;
}

interface Segment {
  text: string;
  kind: 'plain' | 'match' | 'guid';
  matchIndex?: number;
}

function segment(line: string, search: RegExp | null, counter: { n: number }): Segment[] {
  const marks: Array<{ start: number; end: number; kind: 'match' | 'guid' }> = [];
  if (search) for (const m of line.matchAll(search)) if (m[0]) marks.push({ start: m.index!, end: m.index! + m[0].length, kind: 'match' });
  for (const m of line.matchAll(GUID)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!marks.some((x) => start < x.end && end > x.start)) marks.push({ start, end, kind: 'guid' });
  }
  marks.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) out.push({ text: line.slice(pos, m.start), kind: 'plain' });
    const seg: Segment = { text: line.slice(m.start, m.end), kind: m.kind };
    if (m.kind === 'match') seg.matchIndex = counter.n++;
    out.push(seg);
    pos = m.end;
  }
  if (pos < line.length) out.push({ text: line.slice(pos), kind: 'plain' });
  return out;
}

/** Read-only trace text with line numbers, find (Enter / Shift+Enter), GUID highlighting and JSON pretty-printing. */
export function TraceText({ text, initialSearch = '' }: { text: string; initialSearch?: string }) {
  const [search, setSearch] = useState(initialSearch);
  const [pretty, setPretty] = useState(true);
  const [current, setCurrent] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => (pretty ? prettyLines(text) : text.split(/\r?\n/)), [text, pretty]);
  const regex = useMemo(() => (search.trim() ? new RegExp(escapeRegExp(search.trim()), 'gi') : null), [search]);
  const { rendered, total } = useMemo(() => {
    const counter = { n: 0 };
    const rendered = lines.map((l) => segment(l, regex, counter));
    return { rendered, total: counter.n };
  }, [lines, regex]);

  useEffect(() => setCurrent(0), [search]);
  useEffect(() => {
    container.current?.querySelector('mark.current')?.scrollIntoView({ block: 'nearest' });
  }, [current, total]);

  const step = (d: number) => total && setCurrent((c) => (c + d + total) % total);
  const renderSeg = (s: Segment, i: number): ReactNode =>
    s.kind === 'match' ? (
      <mark key={i} className={s.matchIndex === current ? 'current' : undefined}>
        {s.text}
      </mark>
    ) : s.kind === 'guid' ? (
      <span key={i} className="guid">
        {s.text}
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    );

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <Input
          size="small"
          className="grow"
          contentBefore={<SearchRegular />}
          placeholder="Find in trace"
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          onKeyDown={(e) => e.key === 'Enter' && step(e.shiftKey ? -1 : 1)}
          contentAfter={search ? <span className="small muted">{total ? `${current + 1}/${total}` : '0/0'}</span> : undefined}
        />
        <Button size="small" appearance="subtle" icon={<ArrowUpRegular />} aria-label="Previous match" disabled={!total} onClick={() => step(-1)} />
        <Button size="small" appearance="subtle" icon={<ArrowDownRegular />} aria-label="Next match" disabled={!total} onClick={() => step(1)} />
        <Switch label="Format JSON" checked={pretty} onChange={(_, d) => setPretty(d.checked)} />
        <Tooltip content="Copy trace text" relationship="label">
          <Button size="small" appearance="subtle" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(text)} />
        </Tooltip>
      </div>
      <div className="text-viewer" ref={container} role="log" aria-label="Trace text">
        {rendered.map((segs, i) => (
          <div className="line" key={i}>
            <span className="ln">{i + 1}</span>
            <span className="tx">{segs.length ? segs.map(renderSeg) : ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
