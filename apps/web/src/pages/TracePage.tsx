import { formatDuration } from '@dvt/core';
import { Button, MessageBar, MessageBarBody, Spinner, Switch, Tooltip } from '@fluentui/react-components';
import { ArrowLeftRegular, CopyRegular, HistoryRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { Caveats, EmptyState } from '../components/bits.tsx';
import { ExportButton } from '../components/ExportDialog.tsx';
import { SpanPanel, SpanTable, Waterfall, traceMarkdown } from '../components/Waterfall.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { formatTime } from '../format.ts';
import { recordUrl } from '../host.ts';
import { href, navigate } from '../router.ts';

export function TracePage({ correlationId }: { correlationId: string }) {
  const { api, host } = useClient();
  const status = useStatus();
  const view = useAsync(() => api.trace(correlationId), [correlationId, status?.dataVersion]);
  const [selected, setSelected] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const v = view.data;

  if (!v) {
    return (
      <main className="page">
        {view.loading ? (
          <div className="loading-screen">
            <Spinner />
          </div>
        ) : (
          <div className="card">
            <EmptyState title="Trace not found">
              No executions with correlation ID <span className="mono">{correlationId}</span> are in local history.
            </EmptyState>
          </div>
        )}
      </main>
    );
  }
  const s = v.trace.summary;
  const anchor = v.trace.anchor;
  const anchorLink = anchor ? recordUrl(host, anchor.table, anchor.id) : null;
  return (
    <main className="page fill">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <Button size="small" appearance="subtle" icon={<ArrowLeftRegular />} onClick={() => history.back()}>
            Back
          </Button>
          <div className="section-title grow" style={{ margin: 0 }}>
            {s.title}
          </div>
          <Switch label="Table view" checked={asTable} onChange={(_, d) => setAsTable(d.checked)} />
          {anchor && (
            <Tooltip content="Every save of this record, with flows and what should have run" relationship="description">
              <Button size="small" icon={<HistoryRegular />} onClick={() => navigate(href('record', {}, `${anchor.table}/${anchor.id}`))}>
                Record story
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Copy as Markdown (for a bug report)" relationship="label">
            <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(traceMarkdown(v))}>
              Markdown
            </Button>
          </Tooltip>
          <ExportButton source={{ kind: 'trace', title: s.title, view: v, steps: v.steps }} />
        </div>
        <div className="trace-summary">
          <span className="stat">
            <span className="label">Started</span>
            <span className="value">{formatTime(s.start)}</span>
          </span>
          <span className="stat">
            <span className="label">End to end</span>
            <span className="value">{formatDuration(s.wallMs)}</span>
          </span>
          <span className="stat">
            <span className="label">In the save (sync)</span>
            <span className="value">{formatDuration(s.syncMs)}</span>
          </span>
          <span className="stat">
            <span className="label">Plugins</span>
            <span className="value">{(s.counts.plugin ?? 0) + (s.counts.workflowActivity ?? 0)}</span>
          </span>
          <span className="stat">
            <span className="label">System jobs</span>
            <span className="value">{s.counts.systemJob ?? 0}</span>
          </span>
          <span className="stat">
            <span className="label">Max depth</span>
            <span className="value">{s.maxDepth}</span>
          </span>
          <span className="stat">
            <span className="label">Errors</span>
            <span className={`value${s.errors ? ' error-text' : ''}`}>{s.errors}</span>
          </span>
          {anchor && (
            <span className="stat">
              <span className="label">Record</span>
              {anchorLink ? (
                <a className="link value" href={anchorLink} target="_blank" rel="noreferrer">
                  {anchor.name ?? anchor.id} ({anchor.table})
                </a>
              ) : (
                <span className="value">
                  {anchor.name ?? anchor.id} ({anchor.table})
                </span>
              )}
            </span>
          )}
          <span className="stat">
            <span className="label">Correlation</span>
            <button className="link mono" title="Filter the explorer by this correlation" onClick={() => navigate(href('explorer', { q: `corr:${correlationId}`, v: 'executions', r: 'all' }))}>
              {correlationId}
            </button>
          </span>
        </div>
        <Caveats caveats={v.trace.caveats} style={{ marginTop: 8 }} />
      </div>
      <div className={`trace-layout${selected ? ' with-detail' : ''}`}>
        {asTable ? <SpanTable view={v} onSelect={setSelected} /> : <Waterfall view={v} selected={selected} onSelect={setSelected} />}
        {selected && (
          <div className="card detail">
            <SpanPanel view={v} spanId={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
    </main>
  );
}
