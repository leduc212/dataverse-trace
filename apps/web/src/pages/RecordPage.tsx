// The record story: every save of one record, and for the selected save everything that ran
// (plug-ins, system jobs, cloud flows) on one timeline, plus what should have run and didn't.
import { formatDuration, type SaveEvent } from '@dvt/core';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Switch, Tab, TabList, Tooltip } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowSyncRegular, CopyRegular, EyeRegular, OpenRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { Caveats, EmptyState } from '../components/bits.tsx';
import { ExpectedTable } from '../components/ExpectedTable.tsx';
import { ExportButton } from '../components/ExportDialog.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import { SpanPanel, SpanTable, Waterfall, traceMarkdown } from '../components/Waterfall.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { formatTime } from '../format.ts';
import { recordUrl } from '../host.ts';
import { href, navigate } from '../router.ts';
import type { RecordStoryView } from '../shared/api.ts';

const CHANGE_LABEL: Record<SaveEvent['change'], string> = { create: 'Created', update: 'Updated', delete: 'Deleted', other: 'Changed' };

function SaveList({ saves, selected, onSelect }: { saves: SaveEvent[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="save-list" role="listbox" aria-label="Saves of this record">
      {saves.map((s) => (
        <button key={s.id} role="option" aria-selected={s.id === selected} className={`save-item${s.id === selected ? ' selected' : ''}`} onClick={() => onSelect(s.id)}>
          <div className="row">
            <span className="save-diamond" aria-hidden="true" />
            <b className="grow">{CHANGE_LABEL[s.change]}</b>
            <span className="small muted num">{formatTime(s.time)}</span>
          </div>
          <div className="small muted ellipsis">
            {s.userName ?? 'unknown user'}
            {s.source === 'systemJob' && ' · found through a system job'}
          </div>
          {s.changedColumns && s.change === 'update' && <div className="small ellipsis" title={s.changedColumns.join(', ')}>{s.changedColumns.join(', ')}</div>}
        </button>
      ))}
    </div>
  );
}

function StoryHeader({ view }: { view: RecordStoryView }) {
  const { story } = view;
  const s = story.trace.summary;
  const flows = story.flows.filter((f) => f.runId);
  const misses = view.expected.filter((i) => i.shouldRun === true && i.ran === 'no').length;
  return (
    <div className="trace-summary">
      <span className="stat">
        <span className="label">Saved</span>
        <span className="value">{formatTime(story.save.time)}</span>
      </span>
      <span className="stat">
        <span className="label">By</span>
        <span className="value">{story.save.userName ?? 'unknown'}</span>
      </span>
      {story.save.changedColumns && story.save.change === 'update' && (
        <span className="stat">
          <span className="label">Columns</span>
          <span className="value">{story.save.changedColumns.join(', ') || '–'}</span>
        </span>
      )}
      <span className="stat">
        <span className="label">Operation</span>
        {story.correlationId ? (
          <span className="value">
            <button className="link mono" onClick={() => navigate(href('trace', {}, story.correlationId!))} title="Open the operation's own timeline">
              {story.correlationId.slice(0, 8)}
            </button>{' '}
            {story.correlationConfidence !== null && story.correlationConfidence < 1 ? (
              <Badge size="small" appearance="outline" color="warning" title="Found by timing (inferred): select the save row to see why">
                ≈{Math.round(story.correlationConfidence * 100)}%
              </Badge>
            ) : (
              <Badge size="small" appearance="tint" color="success">
                exact
              </Badge>
            )}
          </span>
        ) : (
          <span className="value muted">not found</span>
        )}
      </span>
      <span className="stat">
        <span className="label">In the save (sync)</span>
        <span className="value">{formatDuration(s.syncMs)}</span>
      </span>
      <span className="stat">
        <span className="label">Flows</span>
        <span className="value">{flows.length}</span>
      </span>
      <span className="stat">
        <span className="label">Errors</span>
        <span className={`value${s.errors ? ' error-text' : ''}`}>{s.errors}</span>
      </span>
      <span className="stat">
        <span className="label">Expected but missing</span>
        <span className={`value${misses ? ' error-text' : ''}`}>{misses}</span>
      </span>
    </div>
  );
}

function Story({ table, id, saveId, recordName }: { table: string; id: string; saveId: string; recordName: string | null }) {
  const { api } = useClient();
  const status = useStatus();
  const story = useAsync(() => api.recordStory(table, id, saveId), [table, id, saveId, status?.dataVersion]);
  const [tab, setTab] = useState<'timeline' | 'expected'>('timeline');
  const [asTable, setAsTable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const v = story.data;
  if (!v) {
    return <div className="card grow loading-screen">{story.loading ? <Spinner /> : <EmptyState title="Save not found">{story.error ?? 'This save is no longer in the audit history.'}</EmptyState>}</div>;
  }
  const title = `${v.story.save.change === 'create' ? 'Create' : v.story.save.change === 'update' ? 'Update' : 'Change'} ${recordName ?? table}`;
  const misses = v.expected.filter((i) => i.shouldRun === true && i.ran === 'no').length;
  return (
    <div className="story">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="timeline">Timeline</Tab>
            <Tab value="expected">
              Expected vs. actual
              {misses > 0 && (
                <Badge size="small" color="danger" style={{ marginLeft: 6 }}>
                  {misses}
                </Badge>
              )}
            </Tab>
          </TabList>
          <div className="grow" />
          {tab === 'timeline' && <Switch label="Table view" checked={asTable} onChange={(_, d) => setAsTable(d.checked)} />}
          <Tooltip content="Copy as Markdown (for a bug report)" relationship="label">
            <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(traceMarkdown({ trace: v.story.trace, layout: v.layout }, `Record: ${table} ${recordName ?? id} · saved ${new Date(v.story.save.time).toISOString()}`))}>
              Markdown
            </Button>
          </Tooltip>
          <ExportButton source={{ kind: 'record', title, view: { trace: v.story.trace, layout: v.layout }, steps: v.steps, expected: v.expected, users: v.story.save.userName ? [v.story.save.userName] : [] }} />
        </div>
        <StoryHeader view={v} />
        <Caveats caveats={v.story.trace.caveats} style={{ marginTop: 8 }} />
      </div>
      {tab === 'timeline' ? (
        <div className={`trace-layout${selected ? ' with-detail' : ''}`}>
          {asTable ? <SpanTable view={{ trace: v.story.trace, layout: v.layout }} onSelect={setSelected} /> : <Waterfall view={{ trace: v.story.trace, layout: v.layout }} selected={selected} onSelect={setSelected} />}
          {selected && (
            <div className="card detail">
              <SpanPanel view={{ trace: v.story.trace, layout: v.layout }} spanId={selected} onClose={() => setSelected(null)} />
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: 'auto', flex: 1 }}>
          {v.expectedNote && (
            <MessageBar intent="warning">
              <MessageBarBody>{v.expectedNote}</MessageBarBody>
            </MessageBar>
          )}
          <ExpectedTable
            items={v.expected}
            observed
            onSelectSpan={(spanId) => {
              setSelected(spanId);
              setTab('timeline');
            }}
          />
        </div>
      )}
    </div>
  );
}

export function RecordPage({ recordKey, saveId }: { recordKey: string | null; saveId: string | null }) {
  const { api, host } = useClient();
  const status = useStatus();
  const [refresh, setRefresh] = useState(0);
  const [table, id] = recordKey ? (recordKey.split('/') as [string, string]) : [null, null];
  const saves = useAsync(() => (table && id ? api.recordSaves(table, id) : Promise.resolve(null)), [table, id, refresh, status?.dataVersion]);

  if (!table || !id) {
    return (
      <main className="page">
        <div className="card card-pad" style={{ maxWidth: 820 }}>
          <div className="section-title">Record story</div>
          <RecordPicker
            hint="Everything that ran when a record was saved: plug-ins, system jobs and cloud flows on one timeline, with what should have run and didn't."
            onPick={(r) => navigate(href('record', {}, `${r.table}/${r.id}`))}
          />
        </div>
      </main>
    );
  }

  const data = saves.data;
  const selected = saveId && data?.saves.some((s) => s.id === saveId) ? saveId : (data?.saves[0]?.id ?? null);
  const name = data?.record.name ?? null;
  const appLink = recordUrl(host, table, id);
  return (
    <main className="page fill">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row">
          <Button size="small" appearance="subtle" icon={<ArrowLeftRegular />} onClick={() => navigate(href('record'))}>
            Records
          </Button>
          <div className="section-title grow" style={{ margin: 0 }}>
            {name ?? <span className="mono">{id}</span>} <span className="muted small">({table})</span>
          </div>
          {appLink && (
            <Button size="small" appearance="subtle" icon={<OpenRegular />} as="a" href={appLink} target="_blank" rel="noreferrer">
              Open in app
            </Button>
          )}
          <Button size="small" appearance="subtle" icon={<EyeRegular />} onClick={() => navigate(href('watch', { t: table, id, n: name ?? undefined }))}>
            Watch
          </Button>
          <Tooltip content="Read the audit history again" relationship="label">
            <Button size="small" appearance="subtle" icon={saves.loading ? <Spinner size="extra-tiny" /> : <ArrowSyncRegular />} onClick={() => setRefresh((n) => n + 1)} />
          </Tooltip>
        </div>
        {data?.record.error && (
          <MessageBar intent="warning" style={{ marginTop: 8 }}>
            <MessageBarBody>Couldn't read the record ({data.record.error}). Flow filter expressions that need its values will show as "can't tell".</MessageBarBody>
          </MessageBar>
        )}
        {data?.auditNote && (
          <MessageBar intent={data.audit === 'error' ? 'error' : 'info'} style={{ marginTop: 8 }}>
            <MessageBarBody>{data.auditNote}</MessageBarBody>
          </MessageBar>
        )}
      </div>
      {!data ? (
        <div className="card grow loading-screen">{saves.loading ? <Spinner label="Reading audit history…" /> : <EmptyState title="Couldn't load this record">{saves.error}</EmptyState>}</div>
      ) : data.saves.length === 0 ? (
        <div className="card grow">
          <EmptyState title="No saves found">
            No audit history or system jobs were found for this record in local history. Try <a className="link" href={href('watch', { t: table, id })}>watching it</a> while you save it.
          </EmptyState>
        </div>
      ) : (
        <div className="record-layout">
          <div className="card save-list-card">
            <div className="section-title small" style={{ padding: '10px 12px 0' }}>
              Saves ({data.saves.length})
            </div>
            <SaveList saves={data.saves} selected={selected} onSelect={(s) => navigate(href('record', { save: s }, `${table}/${id}`), true)} />
          </div>
          {selected && <Story key={selected} table={table} id={id} saveId={selected} recordName={name} />}
        </div>
      )}
    </main>
  );
}
