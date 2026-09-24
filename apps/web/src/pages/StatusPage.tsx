import { TRACE_SETTING_LABELS } from '@dvt/core';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
} from '@fluentui/react-components';
import { ArrowSyncRegular, CheckmarkCircleFilled, DeleteRegular, ErrorCircleFilled, QuestionCircleRegular, WarningFilled } from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { APP_VERSION, REPO_URL } from '../constants.ts';
import { KeyValues } from '../components/bits.tsx';
import { useClient, useStatus } from '../client.ts';
import { formatAgo, formatShortDateTime } from '../format.ts';

function Check({ ok, title, children }: { ok: boolean | null; title: string; children?: ReactNode }) {
  const icon =
    ok === true ? (
      <CheckmarkCircleFilled style={{ color: 'var(--colorPaletteGreenForeground1)' }} aria-label="Yes" />
    ) : ok === false ? (
      <WarningFilled style={{ color: 'var(--viz-warning)' }} aria-label="No" />
    ) : (
      <QuestionCircleRegular aria-label="Unknown" />
    );
  return (
    <div className="check">
      {icon}
      <div>
        <div>{title}</div>
        {children && <div className="small muted">{children}</div>}
      </div>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  traceLogs: 'Plug-in trace logs',
  asyncOps: 'System jobs',
  steps: 'Step registrations',
  traceBlobs: 'Trace text',
};

export function StatusPage() {
  const { api } = useClient();
  const status = useStatus();
  if (!status) return null;
  const caps = status.capabilities;
  const setting = caps?.settings.pluginTraceLogSetting;
  const storage = status.storage;
  const isDemo = status.host?.kind === 'demo';

  return (
    <main className="page">
      <div className="status-grid">
        <div className="card card-pad">
          <h2>Environment</h2>
          <KeyValues
            items={[
              ['Host', isDemo ? 'Demo (Harbor Insurance, fictional)' : status.host?.kind === 'environment' ? status.host.origin : '–'],
              ['Signed-in user', caps?.userId ? <span className="mono">{caps.userId}</span> : 'unknown'],
              ['Trace logging', setting === null || setting === undefined ? 'unknown' : TRACE_SETTING_LABELS[setting]],
              ['Auditing', caps?.settings.isAuditEnabled === null || caps?.settings.isAuditEnabled === undefined ? 'unknown' : caps.settings.isAuditEnabled ? 'On' : 'Off'],
              ['Checked', caps ? formatAgo(caps.checkedAt) : '–'],
            ]}
          />
          <div className="section-title" style={{ marginTop: 16 }}>
            What this app can read
          </div>
          <Check ok={caps?.canReadTraceLogs ?? null} title="Plug-in trace logs">
            Needs read access to Plug-in Trace Log.
          </Check>
          <Check ok={caps?.canReadTraceText ?? null} title="Trace text">
            Dataverse only returns trace text to System Administrators.
          </Check>
          <Check ok={caps?.canReadAsyncOperations ?? null} title="System jobs">
            Used for the async lane and to find the record behind an operation.
          </Check>
          <Check ok={caps?.canReadSteps ?? null} title="Step registrations">
            Used for stage, execution order and filtering attributes.
          </Check>
          <Check ok={setting === 2 ? true : setting === null || setting === undefined ? null : false} title="Trace logging set to All">
            {setting === 1 ? 'Only failures are logged (Exceptions).' : setting === 0 ? 'Nothing is being logged (Off).' : 'Every execution is logged.'}
          </Check>
        </div>

        <div className="card card-pad">
          <div className="row">
            <h2 className="grow">Local history</h2>
            <Button size="small" icon={<ArrowSyncRegular />} disabled={status.syncing} onClick={() => void api.syncNow()}>
              {status.syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Last success</th>
                <th>Up to</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {(['traceLogs', 'asyncOps', 'steps', 'traceBlobs'] as const).map((source) => {
                const s = status.sources.find((x) => x.source === source);
                const live = status.progress.find((p) => p.source === source);
                return (
                  <tr key={source}>
                    <td>{SOURCE_LABELS[source]}</td>
                    <td>{live?.phase === 'running' ? `syncing… ${live.fetched.toLocaleString('en-US')}` : live?.phase === 'skipped' ? 'skipped' : formatAgo(s?.lastOkAt ?? null)}</td>
                    <td className="small">{s?.watermark ? formatShortDateTime(s.watermark) : '–'}</td>
                    <td className="small">
                      {s?.lastError ? (
                        <span className="error-text">
                          <ErrorCircleFilled /> {s.lastError}
                        </span>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="section-title" style={{ marginTop: 16 }}>
            Stored in this browser
          </div>
          <KeyValues
            items={[
              ['Executions', storage?.traceLogs.toLocaleString('en-US')],
              ['Trace texts', storage?.traceBlobs.toLocaleString('en-US')],
              ['System jobs', storage?.asyncOps.toLocaleString('en-US')],
              ['Steps', storage?.steps.toLocaleString('en-US')],
              ['Oldest execution', storage?.oldest ? formatShortDateTime(storage.oldest) : '–'],
              ['Newest execution', storage?.newest ? formatShortDateTime(storage.newest) : '–'],
            ]}
          />
          {(status.sources.find((s) => s.source === 'traceLogs')?.gaps.length ?? 0) > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              Gaps: {status.sources.find((s) => s.source === 'traceLogs')!.gaps.map(([a, b]) => `${formatShortDateTime(a)} – ${formatShortDateTime(b)}`).join('; ')}. Dataverse deletes trace logs after about a day, so open the app at least once a day to keep history complete.
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <Dialog>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" icon={<DeleteRegular />}>
                  Forget local data
                </Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Forget local data?</DialogTitle>
                  <DialogContent>
                    This deletes the history stored in this browser for this environment. Nothing in Dataverse changes. The app then syncs again, but Dataverse only keeps about a day of trace logs, so older history is gone for good.
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Cancel</Button>
                    </DialogTrigger>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="primary" onClick={() => void api.forget()}>
                        Forget
                      </Button>
                    </DialogTrigger>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
        </div>

        <div className="card card-pad">
          <h2>About</h2>
          <p style={{ marginTop: 0 }}>
            Dataverse Trace shows everything that ran when a record was saved. It runs entirely in your browser: in an environment it reads with your own session, and nothing is sent anywhere else.
          </p>
          <KeyValues
            items={[
              ['Version', APP_VERSION],
              [
                'Source',
                <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
                  {REPO_URL.replace('https://', '')}
                </a>,
              ],
              ['Licence', 'MIT'],
            ]}
          />
        </div>
      </div>
    </main>
  );
}
