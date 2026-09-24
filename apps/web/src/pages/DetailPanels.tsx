import { formatDuration, summarizeException } from '@dvt/core';
import { Badge, Button, Spinner, Tab, TabList, Tooltip } from '@fluentui/react-components';
import { CopyRegular, DismissRegular, FlowchartRegular, OpenRegular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { DurationCell, EmptyState, ErrorMark, KeyValues } from '../components/bits.tsx';
import { ExceptionView } from '../components/ExceptionView.tsx';
import { TraceText } from '../components/TraceText.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { STAGE_LABELS, formatTime, shortTypeName } from '../format.ts';
import { recordUrl } from '../host.ts';
import { href, navigate } from '../router.ts';

type DetailTab = 'trace' | 'exception' | 'details' | 'raw';

export function ExecutionPanel({ id, search, onClose, inTimeline = false }: { id: string; search: string; onClose: () => void; inTimeline?: boolean }) {
  const { api, host } = useClient();
  const status = useStatus();
  const detail = useAsync(() => api.execution(id), [id, status?.dataVersion]);
  const d = detail.data;
  const [tab, setTab] = useState<DetailTab>('trace');
  useEffect(() => {
    if (d) setTab(d.log.exception ? 'exception' : 'trace');
  }, [d?.log.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) {
    return (
      <div className="loading-screen">
        {detail.loading ? <Spinner /> : <EmptyState title="Not found">This execution is no longer in local history.</EmptyState>}
      </div>
    );
  }
  const { log, blob, step, job } = d;
  const stepLink = log.stepId ? recordUrl(host, 'sdkmessageprocessingstep', log.stepId) : null;
  const textHidden = status?.capabilities?.canReadTraceText === false;
  // Free-text terms of the explorer query pre-fill "find in trace".
  const initialSearch = search
    .split(/\s+/)
    .filter((t) => t && !/^-?[a-z]+(:|>|<|=)/i.test(t) && !/^-?(err|error|errors)$/i.test(t))
    .join(' ')
    .replace(/"/g, '');

  return (
    <>
      <div className="detail-head">
        <div className="row">
          <div className="detail-title grow">{log.typeName}</div>
          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="small muted" style={{ margin: '2px 0 8px' }}>
          {log.messageName} {log.primaryEntity ?? ''} · {log.mode} · depth {log.depth} · {formatTime(log.start)}
        </div>
        <div className="row wrap">
          <DurationCell ms={log.durationMs} error={Boolean(log.exception)} />
          {log.exception ? <Badge color="danger" appearance="tint">Failed</Badge> : <Badge color="success" appearance="tint">Succeeded</Badge>}
          <div className="grow" />
          {log.correlationId && !inTimeline && (
            <Button size="small" appearance="primary" icon={<FlowchartRegular />} onClick={() => navigate(href('trace', {}, log.correlationId!))}>
              Timeline ({d.operationSize})
            </Button>
          )}
          {log.correlationId && (
            <Tooltip content="Copy correlation ID" relationship="label">
              <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(log.correlationId!)} />
            </Tooltip>
          )}
          {stepLink && (
            <Tooltip content="Open the step registration" relationship="label">
              <Button size="small" icon={<OpenRegular />} as="a" href={stepLink} target="_blank" rel="noreferrer" />
            </Tooltip>
          )}
        </div>
      </div>
      <TabList size="small" selectedValue={tab} onTabSelect={(_, t) => setTab(t.value as DetailTab)} style={{ padding: '0 8px' }}>
        <Tab value="trace">Trace text</Tab>
        <Tab value="exception" disabled={!log.exception}>
          Exception
        </Tab>
        <Tab value="details">Details</Tab>
        <Tab value="raw">Raw</Tab>
      </TabList>
      <div className="detail-body">
        {tab === 'trace' &&
          (blob?.messageBlock ? (
            <>
              {blob.messageBlock.length >= 10_000 && (
                <div className="small muted" style={{ marginBottom: 6 }}>
                  Near the 10 KB limit: the platform drops the oldest lines, so the start of the trace may be missing.
                </div>
              )}
              <TraceText text={blob.messageBlock} initialSearch={initialSearch} />
            </>
          ) : textHidden ? (
            <EmptyState title="Trace text is hidden">Dataverse only returns trace text to System Administrators.</EmptyState>
          ) : blob ? (
            <EmptyState title="No trace text">This execution didn't write any trace lines.</EmptyState>
          ) : (
            <EmptyState title="Trace text not synced yet">It's fetched in the background after the execution list.</EmptyState>
          ))}
        {tab === 'exception' && log.exception && <ExceptionView text={log.exception} />}
        {tab === 'details' && (
          <KeyValues
            items={[
              ['Plugin type', log.typeName],
              ['Operation type', log.operationType === 'workflowActivity' ? 'Custom workflow activity' : 'Plug-in'],
              ['Message', log.messageName],
              ['Table', log.primaryEntity],
              ['Mode', log.mode],
              ['Depth', log.depth],
              ['Started', `${new Date(log.start).toISOString()}${log.precision === 's' ? ' (whole seconds)' : ''}`],
              ['Duration', formatDuration(log.durationMs)],
              ['Constructor', log.constructorMs === null ? null : formatDuration(log.constructorMs)],
              ['Correlation ID', <span className="mono">{log.correlationId}</span>],
              ['Request ID', <span className="mono">{log.requestId}</span>],
              ['Step', step ? step.name : <span className="mono">{log.stepId}</span>],
              ['Stage', step ? `${STAGE_LABELS[step.stage] ?? step.stage} (${step.stage}), order ${step.rank}` : null],
              ['Filtering attributes', step ? (step.filteringAttributes?.join(', ') ?? 'none (runs on any column)') : null],
              ['Assembly', step?.assemblyName],
              ['Created by', log.createdByName ?? log.createdById],
              ['System job', job ? `${job.name} · ${job.statusLabel}${job.retryCount ? ` · ${job.retryCount} retries` : ''}` : log.mode === 'async' ? 'not found (may be auto-deleted)' : null],
              ['Trace text', log.messageBlockLength === null ? 'not synced' : `${log.messageBlockLength.toLocaleString('en-US')} characters`],
            ]}
          />
        )}
        {tab === 'raw' && <pre className="text-viewer" style={{ padding: 8, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ ...log, messageBlock: blob?.messageBlock }, null, 2)}</pre>}
      </div>
    </>
  );
}

export function OperationPanel({ correlationId, onClose, onSelectExecution }: { correlationId: string; onClose: () => void; onSelectExecution: (id: string) => void }) {
  const { api, host } = useClient();
  const status = useStatus();
  const logs = useAsync(() => api.operationExecutions(correlationId), [correlationId, status?.dataVersion]);
  const trace = useAsync(() => api.trace(correlationId), [correlationId, status?.dataVersion]);
  const rows = logs.data ?? [];
  const summary = trace.data?.trace.summary;
  const anchor = trace.data?.trace.anchor;
  const anchorLink = anchor ? recordUrl(host, anchor.table, anchor.id) : null;
  return (
    <>
      <div className="detail-head">
        <div className="row">
          <div className="detail-title grow">{summary?.title ?? 'Operation'}</div>
          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="small muted" style={{ margin: '2px 0 8px' }}>
          {summary ? `${formatTime(summary.start)} · ${formatDuration(summary.wallMs)} end to end · max depth ${summary.maxDepth}` : ' '}
        </div>
        <div className="row wrap">
          {summary && summary.errors > 0 && <Badge color="danger" appearance="tint">{summary.errors} failed</Badge>}
          {anchor && (
            <span className="small">
              Record:{' '}
              {anchorLink ? (
                <a className="link" href={anchorLink} target="_blank" rel="noreferrer">
                  {anchor.name ?? anchor.id} ({anchor.table})
                </a>
              ) : (
                `${anchor.name ?? anchor.id} (${anchor.table})`
              )}
            </span>
          )}
          <div className="grow" />
          <Button size="small" appearance="primary" icon={<FlowchartRegular />} onClick={() => navigate(href('trace', {}, correlationId))}>
            Open timeline
          </Button>
          <Tooltip content="Copy correlation ID" relationship="label">
            <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(correlationId)} />
          </Tooltip>
        </div>
      </div>
      <div className="detail-body">
        <div className="section-title">Executions in order</div>
        <table className="data">
          <thead>
            <tr>
              <th>Step</th>
              <th>Stage</th>
              <th className="num">Duration</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => onSelectExecution(l.id)}>
                <td>
                  <span style={{ paddingLeft: (l.depth - 1) * 14 }} title={l.typeName}>
                    {shortTypeName(l.typeName)}
                  </span>
                  <div className="small muted" style={{ paddingLeft: (l.depth - 1) * 14 }}>
                    {l.messageName} {l.primaryEntity} · depth {l.depth} · {l.mode}
                  </div>
                </td>
                <td className="small">{l.stepId ? (STAGE_LABELS[trace.data?.steps[l.stepId]?.stage ?? 0] ?? '–') : '–'}</td>
                <td className="num">{formatDuration(l.durationMs)}</td>
                <td>{l.exception && <ErrorMark title={summarizeException(l.exception) ?? undefined} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.loading && rows.length === 0 && <Spinner />}
      </div>
    </>
  );
}
