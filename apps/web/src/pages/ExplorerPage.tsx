import { summarizeException } from '@dvt/core';
import {
  Button,
  Dropdown,
  Input,
  Option,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Tab,
  TabList,
} from '@fluentui/react-components';
import { DismissRegular, FilterRegular, QuestionCircleRegular, SearchRegular, TextBulletListTreeRegular } from '@fluentui/react-icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DurationCell, EmptyState, ErrorMark } from '../components/bits.tsx';
import { StackedColumns, StackedLegend } from '../components/charts.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { formatTime, shortTypeName } from '../format.ts';
import { href, navigate, useRoute } from '../router.ts';
import {
  RANGE_LABELS,
  type ExplorerRow,
  type ExplorerView,
  type FacetValue,
  type LogQuery,
  type LogQueryResult,
  type RangeKey,
  type SortKey,
} from '../shared/api.ts';
import { ExecutionPanel, OperationPanel } from './DetailPanels.tsx';

const PAGE = 200;
const SORT_LABELS: Record<SortKey, string> = { newest: 'Newest first', oldest: 'Oldest first', slowest: 'Slowest first' };

function readQuery(params: URLSearchParams): LogQuery {
  const r = params.get('r') as RangeKey | null;
  const v = params.get('v') as ExplorerView | null;
  const s = params.get('s') as SortKey | null;
  return {
    text: params.get('q') ?? '',
    range: r && r in RANGE_LABELS ? r : '24h',
    view: v === 'executions' ? 'executions' : 'operations',
    sort: s && s in SORT_LABELS ? s : 'newest',
  };
}

function explorerHref(q: LogQuery, selection?: string): string {
  return href('explorer', { q: q.text, r: q.range === '24h' ? undefined : q.range, v: q.view === 'operations' ? undefined : q.view, s: q.sort === 'newest' ? undefined : q.sort, sel: selection });
}

/** Quotes a facet value when needed and toggles it in the query text. */
function toggleClause(text: string, key: string, value: string, negate: boolean): string {
  const v = /\s/.test(value) ? `"${value}"` : value;
  const clause = `${negate ? '-' : ''}${key}:${v}`;
  const tokens = text.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter(Boolean);
  const has = tokens.includes(clause);
  return (has ? tokens.filter((t) => t !== clause) : [...tokens, clause]).join(' ');
}

const SYNTAX: Array<[string, string]> = [
  ['table:account', 'Primary table'],
  ['msg:Update', 'Message name'],
  ['type:ErpSync', 'Plugin type name contains'],
  ['dur>2s   dur<=50ms', 'Duration (ms, s, m)'],
  ['depth>=3', 'Execution depth'],
  ['mode:async', 'sync or async'],
  ['err   is:ok', 'Failed / succeeded'],
  ['corr:<guid>   req:<guid>', 'Correlation or request ID'],
  ['-table:contact', 'Exclude (any filter)'],
  ['timeout   "loaded config"', 'Text in names, exceptions and trace text'],
];

function QueryHelp() {
  return (
    <Popover withArrow positioning="below-end">
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<QuestionCircleRegular />} aria-label="Query syntax" />
      </PopoverTrigger>
      <PopoverSurface>
        <div className="section-title">Query syntax</div>
        <table className="data" style={{ minWidth: 380 }}>
          <tbody>
            {SYNTAX.map(([example, meaning]) => (
              <tr key={example}>
                <td className="mono">{example}</td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 8 }}>
          Combine freely: every filter must match. Click a facet to add it; Alt+click to exclude. Press <kbd>/</kbd> to focus the query.
        </div>
      </PopoverSurface>
    </Popover>
  );
}

function FacetGroup({ title, field, values, query, onChange }: { title: string; field: string; values: FacetValue[]; query: string; onChange: (text: string) => void }) {
  if (values.length === 0) return null;
  const max = Math.max(...values.map((v) => v.count));
  return (
    <div className="facet-group">
      <div className="facet-title">{title}</div>
      {values.map((v) => (
        <button
          key={v.value}
          className="facet-item"
          title={`${v.value}\nClick to filter, Alt+click to exclude`}
          onClick={(e) => onChange(toggleClause(query, field, v.value, e.altKey))}
        >
          <span className="grow ellipsis">{field === 'type' ? shortTypeName(v.value) : v.value}</span>
          <span className="bar" style={{ width: `${Math.max(4, (v.count / max) * 36)}px` }} />
          <span className="num muted" style={{ width: 44 }}>
            {v.count.toLocaleString('en-US')}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Loads result rows from the worker page by page as the grid scrolls. */
function useRowPages(result: LogQueryResult | undefined) {
  const { api } = useClient();
  const [rows, setRows] = useState<Map<number, ExplorerRow>>(new Map());
  const requested = useRef(new Set<number>());
  const queryId = result?.queryId;
  useEffect(() => {
    setRows(new Map());
    requested.current = new Set();
  }, [queryId]);
  const ensure = useCallback(
    (from: number, to: number) => {
      if (queryId === undefined) return;
      for (let page = Math.floor(from / PAGE); page <= Math.floor(to / PAGE); page++) {
        if (requested.current.has(page)) continue;
        requested.current.add(page);
        void api.rows(queryId, page * PAGE, (page + 1) * PAGE).then((slice) => {
          setRows((prev) => {
            const next = new Map(prev);
            slice.forEach((r, i) => next.set(page * PAGE + i, r));
            return next;
          });
        });
      }
    },
    [api, queryId],
  );
  return { rows, ensure };
}

const rowKey = (r: ExplorerRow) => (r.kind === 'operation' ? `o:${r.op.correlationId}` : `e:${r.log.id}`);

function ResultsGrid({
  result,
  view,
  selection,
  onSelect,
}: {
  result: LogQueryResult;
  view: ExplorerView;
  selection: string | null;
  onSelect: (key: string, open?: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { rows, ensure } = useRowPages(result);
  const virtualizer = useVirtualizer({ count: result.total, getScrollElement: () => scroller.current, estimateSize: () => 34, overscan: 12 });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => ensure(first, last), [ensure, first, last]);
  useEffect(() => virtualizer.scrollToOffset(0), [result.queryId, virtualizer]);

  const selectedIndex = useMemo(() => {
    for (const [i, r] of rows) if (rowKey(r) === selection) return i;
    return -1;
  }, [rows, selection]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.key === 'Enter') {
      if (selection) onSelect(selection, true);
      return;
    }
    const next = Math.max(0, Math.min(result.total - 1, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = rows.get(next);
    if (row) {
      onSelect(rowKey(row));
      virtualizer.scrollToIndex(next, { align: 'auto' });
    }
  };

  const cols = view === 'operations' ? 'cols-operations' : 'cols-executions';
  return (
    <div className="card grid-card">
      <div className={`grid-head ${cols}`} role="row">
        {view === 'operations' ? (
          <>
            <span />
            <span>Started</span>
            <span>Operation</span>
            <span>Tables</span>
            <span className="num">Steps</span>
            <span className="num">Depth</span>
            <span>Duration</span>
            <span className="num">Errors</span>
          </>
        ) : (
          <>
            <span>Started</span>
            <span>Plugin type</span>
            <span>Message</span>
            <span>Table</span>
            <span>Mode</span>
            <span className="num">Depth</span>
            <span>Duration</span>
            <span>Result</span>
          </>
        )}
      </div>
      <div className="grid-body" ref={scroller} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-rowcount={result.total} aria-label="Results">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const row = rows.get(item.index);
            const key = row ? rowKey(row) : null;
            return (
              <div
                key={item.key}
                role="row"
                className={`grid-row ${cols}${key === selection ? ' selected' : ''}`}
                style={{ transform: `translateY(${item.start}px)` }}
                onClick={() => key && onSelect(key)}
                onDoubleClick={() => key && onSelect(key, true)}
              >
                {!row ? (
                  <span className="muted">Loading…</span>
                ) : row.kind === 'operation' ? (
                  <>
                    <span>{row.op.errors > 0 ? <ErrorMark title="Has failures" /> : null}</span>
                    <span className="mono">{formatTime(row.op.start)}</span>
                    <span className="ellipsis" title={row.op.title}>
                      <b>{row.op.title || '(no message)'}</b>
                      {row.matched < row.op.steps && <span className="muted"> · {row.matched} matched</span>}
                    </span>
                    <span className="ellipsis muted" title={row.op.tables.join(', ')}>
                      {row.op.tables.join(', ')}
                    </span>
                    <span className="num">{row.op.steps}</span>
                    <span className="num">{row.op.maxDepth}</span>
                    <DurationCell ms={row.op.end - row.op.start} error={row.op.errors > 0} />
                    <span className="num">{row.op.errors || ''}</span>
                  </>
                ) : (
                  <>
                    <span className="mono">{formatTime(row.log.start)}</span>
                    <span className="ellipsis" title={row.log.typeName}>
                      {row.log.typeName}
                    </span>
                    <span className="ellipsis">{row.log.messageName}</span>
                    <span className="ellipsis">{row.log.primaryEntity ?? '–'}</span>
                    <span>{row.log.mode}</span>
                    <span className="num">{row.log.depth}</span>
                    <DurationCell ms={row.log.durationMs} error={Boolean(row.log.exception)} />
                    <span className="ellipsis" title={row.log.exception ?? undefined}>
                      {row.log.exception ? (
                        <span className="error-text">
                          <ErrorMark /> {summarizeException(row.log.exception, 120)}
                        </span>
                      ) : (
                        <span className="muted">OK</span>
                      )}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ExplorerPage() {
  const { api } = useClient();
  const status = useStatus();
  const route = useRoute();
  const query = readQuery(route.params);
  const selection = route.params.get('sel');
  const [draft, setDraft] = useState(query.text);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(query.text), [query.text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (patch: Partial<LogQuery>, sel?: string) => navigate(explorerHref({ ...query, ...patch }, sel), true);
  const result = useAsync(() => api.query(query), [query.text, query.range, query.view, query.sort, status?.dataVersion]);

  const onSelect = (key: string, open = false) => {
    if (open) {
      const cid = key.startsWith('o:') ? key.slice(2) : null;
      if (cid) return navigate(href('trace', {}, cid));
    }
    navigate(explorerHref(query, key), true);
  };

  const r = result.data;
  const total = status?.storage?.traceLogs ?? 0;
  return (
    <main className="page fill">
      <div className="toolbar">
        <Input
          ref={input}
          className="query-box"
          contentBefore={<SearchRegular />}
          placeholder="Filter, e.g.  table:account dur>2s err   (press / to focus)"
          value={draft}
          onChange={(_, d) => setDraft(d.value)}
          onKeyDown={(e) => e.key === 'Enter' && set({ text: draft })}
          onBlur={() => draft !== query.text && set({ text: draft })}
          contentAfter={
            draft ? <Button appearance="transparent" size="small" icon={<DismissRegular />} aria-label="Clear" onClick={() => set({ text: '' })} /> : undefined
          }
          aria-label="Filter query"
        />
        <QueryHelp />
        <Dropdown
          aria-label="Time range"
          value={RANGE_LABELS[query.range]}
          selectedOptions={[query.range]}
          onOptionSelect={(_, d) => set({ range: d.optionValue as RangeKey })}
          style={{ minWidth: 150 }}
        >
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
            <Option key={k} value={k}>
              {RANGE_LABELS[k]}
            </Option>
          ))}
        </Dropdown>
        <TabList size="small" selectedValue={query.view} onTabSelect={(_, d) => set({ view: d.value as ExplorerView })}>
          <Tab value="operations" icon={<TextBulletListTreeRegular />}>
            Operations
          </Tab>
          <Tab value="executions" icon={<FilterRegular />}>
            Executions
          </Tab>
        </TabList>
        <Dropdown aria-label="Sort" value={SORT_LABELS[query.sort]} selectedOptions={[query.sort]} onOptionSelect={(_, d) => set({ sort: d.optionValue as SortKey })} style={{ minWidth: 140 }}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <Option key={k} value={k}>
              {SORT_LABELS[k]}
            </Option>
          ))}
        </Dropdown>
      </div>
      <div className="query-hint">
        {r?.parseErrors.length ? (
          <span className="error-text">{r.parseErrors.join(' · ')}</span>
        ) : r ? (
          <span className="muted">
            {r.total.toLocaleString('en-US')} {query.view === 'operations' ? 'operations' : 'executions'}
            {query.view === 'operations' && ` · ${r.matchedExecutions.toLocaleString('en-US')} matching executions`} · {r.tookMs} ms
            {r.textSearchLimited && ' · trace text search was limited to the most recent text'}
            {result.loading && <Spinner size="extra-tiny" style={{ display: 'inline-flex', marginLeft: 6 }} />}
          </span>
        ) : null}
      </div>

      {total === 0 && status?.syncing ? (
        <div className="card">
          <EmptyState icon={<Spinner />} title="Loading history…">
            Reading plug-in trace logs from Dataverse
            {status.progress.find((p) => p.source === 'traceLogs')?.fetched ? ` (${status.progress.find((p) => p.source === 'traceLogs')!.fetched.toLocaleString('en-US')} so far)` : ''}.
          </EmptyState>
        </div>
      ) : total === 0 ? (
        <div className="card">
          <EmptyState title="No executions yet">
            {status?.capabilities?.settings.pluginTraceLogSetting === 0
              ? 'Plug-in trace logging is Off in this environment. Set it to All (or Exceptions), run something that triggers your plugins, then sync.'
              : 'Nothing has been logged yet. Trigger a plugin (save a record), then press Sync.'}
          </EmptyState>
        </div>
      ) : (
        <div className={`explorer${selection ? ' with-detail' : ''}`}>
          <div className="card card-pad histogram-card">
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="small muted grow">Executions over time</span>
              <StackedLegend />
            </div>
            {r ? <StackedColumns buckets={r.histogram} height={96} label="Executions over time" /> : <div style={{ height: 96 }} />}
          </div>
          <div className="card facets">
            {r && (
              <>
                <FacetGroup title="Table" field="table" values={r.facets.primaryEntity} query={query.text} onChange={(text) => set({ text })} />
                <FacetGroup title="Message" field="msg" values={r.facets.messageName} query={query.text} onChange={(text) => set({ text })} />
                <FacetGroup title="Plugin type" field="type" values={r.facets.typeName} query={query.text} onChange={(text) => set({ text })} />
                <FacetGroup title="Mode" field="mode" values={r.facets.mode} query={query.text} onChange={(text) => set({ text })} />
                <FacetGroup title="Depth" field="depth" values={r.facets.depth} query={query.text} onChange={(text) => set({ text })} />
              </>
            )}
          </div>
          {r ? (
            r.total === 0 ? (
              <div className="card">
                <EmptyState title="Nothing matches">
                  Try a longer time range or remove a filter.{' '}
                  {query.text && (
                    <button className="link" onClick={() => set({ text: '' })}>
                      Clear the query
                    </button>
                  )}
                </EmptyState>
              </div>
            ) : (
              <ResultsGrid result={r} view={query.view} selection={selection} onSelect={onSelect} />
            )
          ) : (
            <div className="card loading-screen">
              <Spinner />
            </div>
          )}
          {selection && (
            <div className="card detail">
              {selection.startsWith('o:') ? (
                <OperationPanel correlationId={selection.slice(2)} onClose={() => navigate(explorerHref(query), true)} onSelectExecution={(id) => navigate(explorerHref({ ...query, view: 'executions' }, `e:${id}`), true)} />
              ) : (
                <ExecutionPanel id={selection.slice(2)} search={query.text} onClose={() => navigate(explorerHref(query), true)} />
              )}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
