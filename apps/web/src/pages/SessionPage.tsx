// Open a shared .dvtrace.json session. Works anywhere, including the demo site, without access to
// the environment it came from. The file is untrusted: it's validated first and only shown as text.
import { formatDuration, layoutWaterfall, parseSession, type SessionFile } from '@dvt/core';
import { Badge, Button, MessageBar, MessageBarBody, MessageBarTitle, Switch, Tab, TabList, Tooltip } from '@fluentui/react-components';
import { CopyRegular, DocumentArrowUpRegular } from '@fluentui/react-icons';
import { useMemo, useState, type DragEvent } from 'react';
import { Caveats, EmptyState } from '../components/bits.tsx';
import { ExpectedTable } from '../components/ExpectedTable.tsx';
import { SpanPanel, SpanTable, Waterfall, traceMarkdown } from '../components/Waterfall.tsx';
import { formatTime } from '../format.ts';

/** Kept while the tab is open, so navigating away and back doesn't lose the file. */
let openSession: { name: string; session: SessionFile } | null = null;

export function SessionPage() {
  const [loaded, setLoaded] = useState(openSession);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);

  const read = async (file: File) => {
    setErrors(null);
    const result = parseSession(await file.text());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    openSession = { name: file.name, session: result.session };
    setLoaded(openSession);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void read(file);
  };
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => input.files?.[0] && void read(input.files[0]);
    input.click();
  };

  return (
    <main className="page fill" onDragOver={(e) => (e.preventDefault(), setDragging(true))} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row">
          <div className="section-title grow" style={{ margin: 0 }}>
            {loaded ? loaded.session.title : 'Open a session file'}
          </div>
          <Button size="small" icon={<DocumentArrowUpRegular />} onClick={pick}>
            {loaded ? 'Open another' : 'Choose file'}
          </Button>
        </div>
        {errors && (
          <MessageBar intent="error" layout="multiline" style={{ marginTop: 8 }}>
            <MessageBarBody>
              <MessageBarTitle>This file can't be opened</MessageBarTitle>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </MessageBarBody>
          </MessageBar>
        )}
        {loaded && <SessionHeader name={loaded.name} session={loaded.session} />}
      </div>
      {loaded ? (
        <SessionView key={loaded.name + loaded.session.exportedAt} session={loaded.session} />
      ) : (
        <div className={`card grow drop-zone${dragging ? ' dragging' : ''}`}>
          <EmptyState icon={<DocumentArrowUpRegular fontSize={32} />} title="Drop a .dvtrace.json file here">
            Session files are exported from a timeline or record story (Export). They open read-only, without signing in to the environment they came from.
          </EmptyState>
        </div>
      )}
    </main>
  );
}

function SessionHeader({ name, session }: { name: string; session: SessionFile }) {
  const s = session.trace.summary;
  return (
    <div className="trace-summary" style={{ marginTop: 6 }}>
      <span className="stat">
        <span className="label">File</span>
        <span className="value">{name}</span>
      </span>
      <span className="stat">
        <span className="label">Exported</span>
        <span className="value">{formatTime(session.exportedAt)}</span>
      </span>
      <span className="stat">
        <span className="label">From</span>
        <span className="value">{session.environment ?? 'hidden'}</span>
      </span>
      <span className="stat">
        <span className="label">Started</span>
        <span className="value">{formatTime(s.start)}</span>
      </span>
      <span className="stat">
        <span className="label">End to end</span>
        <span className="value">{formatDuration(s.wallMs)}</span>
      </span>
      <span className="stat">
        <span className="label">Errors</span>
        <span className={`value${s.errors ? ' error-text' : ''}`}>{s.errors}</span>
      </span>
      <Badge appearance="tint" color={session.redaction ? 'success' : 'warning'}>
        {session.redaction ? 'Redacted' : 'Not redacted'}
      </Badge>
      <Badge appearance="outline">Read-only · app {session.appVersion}</Badge>
    </div>
  );
}

function SessionView({ session }: { session: SessionFile }) {
  const view = useMemo(() => ({ trace: session.trace, layout: layoutWaterfall(session.trace) }), [session]);
  const [tab, setTab] = useState<'timeline' | 'expected'>('timeline');
  const [asTable, setAsTable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const hasExpected = (session.expected?.length ?? 0) > 0;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="timeline">Timeline</Tab>
          {hasExpected && <Tab value="expected">Expected vs. actual</Tab>}
        </TabList>
        <div className="grow" />
        {tab === 'timeline' && <Switch label="Table view" checked={asTable} onChange={(_, d) => setAsTable(d.checked)} />}
        <Tooltip content="Copy as Markdown" relationship="label">
          <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(traceMarkdown(view))}>
            Markdown
          </Button>
        </Tooltip>
      </div>
      <Caveats caveats={session.trace.caveats} style={{ marginBottom: 8 }} />
      {tab === 'timeline' ? (
        <div className={`trace-layout${selected ? ' with-detail' : ''}`}>
          {asTable ? <SpanTable view={view} onSelect={setSelected} /> : <Waterfall view={view} selected={selected} onSelect={setSelected} />}
          {selected && (
            <div className="card detail">
              <SpanPanel view={view} spanId={selected} onClose={() => setSelected(null)} offline {...(session.texts ? { texts: session.texts } : {})} />
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: 'auto', flex: 1 }}>
          <ExpectedTable
            items={session.expected ?? []}
            observed={session.kind !== 'trace'}
            onSelectSpan={(id) => {
              setSelected(id);
              setTab('timeline');
            }}
          />
        </div>
      )}
    </>
  );
}
