// Edit the insight rules' thresholds for this environment (stored locally with its history).
import { DEFAULT_THRESHOLDS, type InsightThresholds } from '@dvt/core';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Field, Input, Spinner } from '@fluentui/react-components';
import { SettingsRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useClient } from '../client.ts';

type Key = keyof InsightThresholds;

/** How a threshold is shown: percentages are edited as 0–100 and stored as 0–1. */
interface FieldSpec {
  key: Key;
  label: string;
  unit: string;
  percent?: boolean;
}

const GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: 'Loops',
    fields: [
      { key: 'loopDepth', label: 'Possible loop at depth', unit: 'or deeper' },
      { key: 'reentryDepths', label: 'Step runs again at', unit: 'depths of one operation' },
    ],
  },
  {
    title: 'Steps',
    fields: [
      { key: 'noFilterRunsPerDay', label: 'Update step without filtering attributes', unit: 'runs a day' },
      { key: 'slowSyncP95Ms', label: 'Slow sync step: p95 above', unit: 'ms' },
      { key: 'heavyCtorP95Ms', label: 'Heavy constructor: p95 above', unit: 'ms' },
      { key: 'heavyCtorShare', label: 'or average above', unit: '% of execution time', percent: true },
      { key: 'truncatedShare', label: 'Too much trace text: at the 10 KB limit in over', unit: '% of traces', percent: true },
    ],
  },
  {
    title: 'Errors',
    fields: [
      { key: 'failingMinErrors', label: 'Failing step: at least', unit: 'errors' },
      { key: 'failingRate', label: 'and an error rate of', unit: '%', percent: true },
      { key: 'spikeFactor', label: 'Error spike: last 24 h error rate at least', unit: '× the previous 7 days' },
      { key: 'spikeMinErrors', label: 'with at least', unit: 'errors in 24 h' },
    ],
  },
  {
    title: 'Async queue and history',
    fields: [
      { key: 'retriedJobs', label: 'Retry storm: jobs needing retries', unit: 'or more per step' },
      { key: 'waitingJobs', label: 'or jobs waiting', unit: 'or more per step' },
      { key: 'syncGapHours', label: 'Collection gap longer than', unit: 'hours' },
    ],
  },
];

const toText = (spec: FieldSpec, t: InsightThresholds) => String(spec.percent ? Math.round(t[spec.key] * 1000) / 10 : t[spec.key]);

/** The dashboard refreshes by itself afterwards: saving bumps the data version. */
export function ThresholdsDialog() {
  const { api } = useClient();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<Key, string> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const t = await api.insightThresholds();
    setValues(Object.fromEntries(GROUPS.flatMap((g) => g.fields).map((f) => [f.key, toText(f, t)])) as Record<Key, string>);
  };
  const parsed = (spec: FieldSpec): number | null => {
    const text = values?.[spec.key]?.trim() ?? '';
    const n = Number(text);
    if (text === '' || !Number.isFinite(n) || n < 0 || (spec.percent && n > 100)) return null;
    return spec.percent ? n / 100 : n;
  };
  const fields = GROUPS.flatMap((g) => g.fields);
  const invalid = fields.some((f) => parsed(f) === null);

  const save = async (reset: boolean) => {
    setSaving(true);
    try {
      const next = reset ? null : (Object.fromEntries(fields.map((f) => [f.key, parsed(f)!])) as Partial<InsightThresholds>);
      await api.setInsightThresholds(next);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        setOpen(d.open);
        if (d.open) void load();
        else setValues(null);
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<SettingsRegular />}>
          Thresholds
        </Button>
      </DialogTrigger>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Finding thresholds</DialogTitle>
          <DialogContent>
            {!values ? (
              <Spinner size="small" />
            ) : (
              <div className="thresholds">
                <p className="small muted" style={{ marginTop: 0 }}>
                  Saved in this browser for this environment.
                </p>
                {GROUPS.map((g) => (
                  <fieldset key={g.title}>
                    <legend>{g.title}</legend>
                    {g.fields.map((f) => (
                      <Field
                        key={f.key}
                        label={f.label}
                        orientation="horizontal"
                        validationState={parsed(f) === null ? 'error' : 'none'}
                        validationMessage={parsed(f) === null ? (f.percent ? 'A number from 0 to 100' : 'A number, 0 or more') : undefined}
                        hint={`Default ${toText(f, DEFAULT_THRESHOLDS)}`}
                      >
                        <Input
                          size="small"
                          inputMode="decimal"
                          value={values[f.key]}
                          contentAfter={<span className="small muted">{f.unit}</span>}
                          onChange={(_, d) => setValues({ ...values, [f.key]: d.value })}
                        />
                      </Field>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="subtle" disabled={saving || !values} onClick={() => void save(true)} style={{ marginRight: 'auto' }}>
              Restore defaults
            </Button>
            <DialogTrigger disableButtonEnhancement>
              <Button>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={saving || !values || invalid} onClick={() => void save(false)}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
