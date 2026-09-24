// Export a trace or record story as a .dvtrace.json session file, redacted by default, with a
// preview of exactly what will be saved.
import {
  DEFAULT_REDACTION,
  createSession,
  redactSession,
  sessionFileName,
  type ExpectedItem,
  type RedactionOptions,
  type SessionKind,
  type StepRegistration,
} from '@dvt/core';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Radio,
  RadioGroup,
  Spinner,
} from '@fluentui/react-components';
import { ArrowDownloadRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { useAsync, useClient } from '../client.ts';
import { APP_VERSION } from '../constants.ts';
import type { TimelineData } from './Waterfall.tsx';

export interface ExportSource {
  kind: SessionKind;
  title: string;
  view: TimelineData;
  steps: Record<string, StepRegistration>;
  expected?: ExpectedItem[];
  /** User names known to the page (e.g. who saved), besides those in the trace rows. */
  users?: string[];
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({ source }: { source: ExportSource }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" icon={<ArrowDownloadRegular />}>
          Export
        </Button>
      </DialogTrigger>
      <ExportSurface source={source} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function ExportSurface({ source, onDone }: { source: ExportSource; onDone: () => void }) {
  const { api, host } = useClient();
  const [options, setOptions] = useState<RedactionOptions>(DEFAULT_REDACTION);
  const spanIds = useMemo(() => source.view.trace.spans.map((s) => s.id), [source]);
  const context = useAsync(() => api.exportContext(spanIds), [spanIds]);

  const session = useMemo(() => {
    if (!context.data) return null;
    const records = source.view.trace.spans.flatMap((s) => (s.record?.name ? [s.record.name] : []));
    const file = createSession({
      exportedAt: Date.now(),
      appVersion: APP_VERSION,
      kind: source.kind,
      title: source.title,
      environment: host.kind === 'environment' ? host.envKey : 'demo',
      trace: source.view.trace,
      steps: source.steps,
      ...(source.expected ? { expected: source.expected } : {}),
      ...(Object.keys(context.data.texts).length ? { texts: context.data.texts } : {}),
    });
    return redactSession(file, options, { users: [...context.data.users, ...(source.users ?? [])], records });
  }, [context.data, options, source, host]);
  const json = useMemo(() => (session ? JSON.stringify(session, null, 1) : ''), [session]);
  const set = (patch: Partial<RedactionOptions>) => setOptions((o) => ({ ...o, ...patch }));

  return (
    <DialogSurface style={{ maxWidth: 760 }}>
      <DialogBody>
        <DialogTitle>Export session</DialogTitle>
        <DialogContent>
          <p className="small muted" style={{ marginTop: 0 }}>
            Saves this timeline as a <span className="mono">.dvtrace.json</span> file that anyone can open in Dataverse Trace (including the demo site) without access to your
            environment. Trace text can contain personal data or secrets: check the preview before sharing.
          </p>
          <div className="export-options">
            <div>
              <div className="section-title small">Trace text</div>
              <RadioGroup value={options.traceText} onChange={(_, d) => set({ traceText: d.value as RedactionOptions['traceText'] })}>
                <Radio value="mask" label="Mask emails, GUIDs and long numbers" />
                <Radio value="remove" label="Leave out" />
                <Radio value="keep" label="Keep as is" />
              </RadioGroup>
            </div>
            <div>
              <div className="section-title small">Replace</div>
              <Checkbox checked={options.users} onChange={(_, d) => set({ users: d.checked === true })} label="User names" />
              <Checkbox checked={options.records} onChange={(_, d) => set({ records: d.checked === true })} label="Record names" />
              <Checkbox checked={options.ids} onChange={(_, d) => set({ ids: d.checked === true })} label="All ids (records, users, correlations)" />
              <Checkbox checked={options.environment} onChange={(_, d) => set({ environment: d.checked === true })} label="Environment name" />
            </div>
          </div>
          <div className="section-title small" style={{ marginTop: 12 }}>
            Preview{session ? ` · ${(json.length / 1024).toFixed(0)} KB · ${session.trace.spans.length} spans${session.texts ? ` · trace text for ${Object.keys(session.texts).length}` : ''}` : ''}
          </div>
          {session ? <pre className="export-preview">{json.slice(0, 6000)}{json.length > 6000 ? '\n…' : ''}</pre> : <Spinner size="small" />}
        </DialogContent>
        <DialogActions>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="secondary">Cancel</Button>
          </DialogTrigger>
          <Button
            appearance="primary"
            icon={<ArrowDownloadRegular />}
            disabled={!session}
            onClick={() => {
              if (!session) return;
              download(sessionFileName(session), JSON.stringify(session));
              onDone();
            }}
          >
            Download
          </Button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  );
}
