// Watch mode: pick a record, press Watch, save it in the app, and see what runs as it arrives.
// Optionally switches plug-in tracing to All for the session, with explicit consent, and always
// puts the old value back (on Stop, on tab close as best effort, and on the next start).
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { HistoryRegular, PlayRegular, SaveRegular, StopRegular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { ExpectedTable } from '../components/ExpectedTable.tsx';
import { RecordPicker, type PickedRecord } from '../components/RecordPicker.tsx';
import { SpanPanel, Waterfall } from '../components/Waterfall.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { formatTime } from '../format.ts';
import { href, navigate, useRoute } from '../router.ts';

const TRACE_LABELS = ['Off', 'Exceptions', 'All'] as const;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Best effort when the tab closes mid-session: the worker can't finish, but a keepalive request can. */
function restoreOnClose(origin: string, organizationId: string, value: 0 | 1 | 2) {
  void fetch(`${origin}/api/data/v9.2/organizations(${organizationId})`, {
    method: 'PATCH',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0', 'If-Match': '*' },
    body: JSON.stringify({ plugintracelogsetting: value }),
  });
}

function ConsentDialog({ open, from, env, onAnswer }: { open: boolean; from: 0 | 1 | 2; env: string; onAnswer: (ok: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onAnswer(false)}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Switch plug-in tracing to All?</DialogTitle>
          <DialogContent>
            <p>
              This changes an organization setting in <b>{env}</b> for everyone, from <b>{TRACE_LABELS[from]}</b> to <b>All</b>, while you watch.
            </p>
            <p>
              We'll put it back to <b>{TRACE_LABELS[from]}</b> when you stop, when watching stops by itself, or (if the tab is closed) the next time Dataverse Trace starts.
              Tracing everything adds a little overhead to every plug-in, so avoid long sessions in production.
            </p>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onAnswer(false)}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => onAnswer(true)}>
              Switch to All while watching
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function WatchPage() {
  const { api, host } = useClient();
  const status = useStatus();
  const route = useRoute();
  const watch = status?.watch;
  const watching = watch?.phase === 'watching';
  const fromParams: PickedRecord | null =
    route.params.get('t') && route.params.get('id') ? { table: route.params.get('t')!, id: route.params.get('id')!.toLowerCase(), name: route.params.get('n') } : null;
  const [picked, setPicked] = useState<PickedRecord | null>(fromParams);
  const [choosing, setChoosing] = useState(false);
  const [switchTrace, setSwitchTrace] = useState(false);
  const [asking, setAsking] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // While watching, the watched record; otherwise the one picked last (or the last watched).
  const watchedRecord = watch?.record ? { table: watch.record.table, id: watch.record.id, name: watch.record.name ?? null } : null;
  const record = watching ? watchedRecord : choosing ? null : (picked ?? watchedRecord);
  const showsWatched = watchedRecord !== null && record !== null && watchedRecord.id === record.id && watchedRecord.table === record.table;
  if (record && watchedRecord && showsWatched && !record.name && picked?.name) record.name = picked.name;

  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [watching]);

  // Tab closing while tracing is switched: put the setting back with a keepalive request.
  const pending = watch?.traceSwitch && !watch.traceSwitch.restored ? watch.traceSwitch : null;
  useEffect(() => {
    if (!pending || host.kind !== 'environment') return;
    const onHide = () => restoreOnClose(host.origin, pending.organizationId, pending.from);
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [pending, host]);

  const live = useAsync(() => (showsWatched ? api.watchView() : Promise.resolve(null)), [showsWatched, watch?.record?.id, watch?.phase, status?.dataVersion]);
  const ghosts = useAsync(
    () => (record && !showsWatched ? api.expected({ table: record.table, change: 'update', changedColumns: null }) : Promise.resolve(null)),
    [record?.table, showsWatched],
  );

  const setting = status?.capabilities?.settings.pluginTraceLogSetting ?? null;
  const isAdmin = status?.capabilities?.isSystemAdministrator === true;
  const envName = host.kind === 'environment' ? host.envKey : 'the demo environment';

  const start = async () => {
    if (!record) return;
    setSelected(null);
    await api.watchStart(record.table, record.id, { switchTrace, name: record.name });
  };
  const simulate = async () => {
    setSimError(await api.simulateSave());
  };

  const view = live.data?.view ?? null;
  const expected = view ? null : (live.data?.expected ?? ghosts.data);

  return (
    <main className="page fill">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row">
          <div className="section-title grow" style={{ margin: 0 }}>
            Watch a record
          </div>
          {watch?.record && !watching && showsWatched && (
            <Button size="small" icon={<HistoryRegular />} onClick={() => navigate(href('record', {}, `${watch.record!.table}/${watch.record!.id}`))}>
              Open record story
            </Button>
          )}
        </div>
        {!record ? (
          <RecordPicker
            hint="Pick the record you're about to save. Watch polls every 2 seconds for new rows only and fills in the timeline as they arrive."
            onPick={(r) => {
              setPicked(r);
              setChoosing(false);
            }}
          />
        ) : (
          <>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <span>
                Record: <b>{record.name ?? <span className="mono">{record.id}</span>}</b> <span className="muted">({record.table})</span>
              </span>
              {!watching && (
                <Button size="small" appearance="subtle" onClick={() => setChoosing(true)}>
                  Change
                </Button>
              )}
            </div>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <span className="small">
                Plug-in trace setting: <b>{setting === null ? 'unknown' : TRACE_LABELS[setting]}</b>
              </span>
              {!watching && setting !== null && setting !== 2 && isAdmin && (
                <Checkbox
                  checked={switchTrace}
                  label={`Switch to All during this session (restored to ${TRACE_LABELS[setting]} when you stop)`}
                  onChange={(_, d) => (d.checked ? setAsking(true) : setSwitchTrace(false))}
                />
              )}
              {!watching && setting !== null && setting !== 2 && !isAdmin && (
                <span className="small muted">Only failing plug-ins will show. A System Administrator can switch tracing to All for a session.</span>
              )}
            </div>
            <div className="row wrap watch-bar" style={{ marginTop: 10 }}>
              {!watching ? (
                <Button appearance="primary" icon={<PlayRegular />} onClick={() => void start()}>
                  Watch
                </Button>
              ) : (
                <>
                  <Badge appearance="filled" color="danger" className="live-dot">
                    ● Watching {clock(now - (watch!.startedAt ?? now))}
                  </Badge>
                  <span className="small muted">
                    polling every 2 s · {watch!.requests} requests · stops after 60 s without new rows
                    {watch!.idleStopAt ? ` (in ${Math.max(0, Math.round((watch!.idleStopAt - now) / 1000))} s)` : ''}
                  </span>
                  <Button icon={<StopRegular />} onClick={() => void api.watchStop()}>
                    Stop
                  </Button>
                </>
              )}
              {watch?.canSimulate && (
                <Button icon={<SaveRegular />} onClick={() => void simulate()} disabled={!watching} title={watching ? 'Changes the policy status, as if you saved it in the app' : 'Start watching first'}>
                  Simulate save
                </Button>
              )}
              {watch?.traceSwitch && (
                <Badge appearance="tint" color={watch.traceSwitch.restored ? 'success' : 'warning'}>
                  {watch.traceSwitch.restored ? `Trace setting restored to ${TRACE_LABELS[watch.traceSwitch.from]}` : `Tracing switched to All (was ${TRACE_LABELS[watch.traceSwitch.from]})`}
                </Badge>
              )}
            </div>
            {watch?.stoppedAt && !watching && showsWatched && (
              <div className="small muted" style={{ marginTop: 6 }}>
                Stopped at {formatTime(watch.stoppedAt)}
                {watch.stopReason === 'idle' ? ' (no new rows for 60 s)' : watch.stopReason === 'limit' ? ' (15-minute limit)' : ''}. Flow runs are written 30 s to 5 min after they
                finish; the record story picks them up with the next sync.
              </div>
            )}
          </>
        )}
        {simError && (
          <MessageBar intent="warning" style={{ marginTop: 8 }}>
            <MessageBarBody>{simError}</MessageBarBody>
          </MessageBar>
        )}
        {watch?.note && (
          <MessageBar intent="success" style={{ marginTop: 8 }}>
            <MessageBarBody>{watch.note}</MessageBarBody>
          </MessageBar>
        )}
        {watch?.error && (
          <MessageBar intent="error" style={{ marginTop: 8 }}>
            <MessageBarBody>{watch.error}</MessageBarBody>
          </MessageBar>
        )}
      </div>
      {record && (
        view ? (
          <div className={`trace-layout${selected ? ' with-detail' : ''}`}>
            <Waterfall view={{ trace: view.story.trace, layout: view.layout }} selected={selected} onSelect={setSelected} />
            {selected && (
              <div className="card detail">
                <SpanPanel view={{ trace: view.story.trace, layout: view.layout }} spanId={selected} onClose={() => setSelected(null)} />
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ overflow: 'auto', flex: 1 }}>
            <div className="card-pad small">
              {watching ? (
                <span className="row">
                  <Spinner size="extra-tiny" /> Waiting for a save of this record… Save it in the app now. Registered to run on update:
                </span>
              ) : (
                <span className="muted">Registered to run when this record is updated. Press Watch, then save the record in the app.</span>
              )}
            </div>
            {expected ? <ExpectedTable items={expected.items} observed={false} /> : <Spinner size="small" />}
          </div>
        )
      )}
      {setting !== null && (
        <ConsentDialog
          open={asking}
          from={setting}
          env={envName}
          onAnswer={(ok) => {
            setAsking(false);
            setSwitchTrace(ok);
          }}
        />
      )}
    </main>
  );
}
