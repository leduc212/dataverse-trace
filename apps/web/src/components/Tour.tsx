// A five-step guided tour of the demo. Shown on the first visit; can be dismissed or restarted.
import { Button } from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getClient } from '../client.ts';
import { href, navigate } from '../router.ts';

const DONE_KEY = 'dataverse-trace:tour-done';

interface Step {
  title: string;
  body: string;
  go: () => Promise<void> | void;
}

async function demoPolicyId(): Promise<string | null> {
  try {
    return (await getClient().api.searchRecords('hbr_policy', 'HP-10000'))[0]?.id ?? null;
  } catch {
    return null;
  }
}

const STEPS: Step[] = [
  {
    title: 'Every plug-in run, grouped by operation',
    body: 'The explorer lists operations (everything one save started) or single executions. Try the search box: "err", "depth>=6" or "type:PolicyErpSync dur>1s".',
    go: () => navigate(href('explorer', { r: '24h' })),
  },
  {
    title: 'Trends and findings',
    body: 'The dashboard spots problems across days and compares each week with the one before: PolicyErpSync got slower after a deployment, PolicyNotify started failing this morning, and ContactAudit runs on every contact update. The Cascades tab shows the loop behind "Depth 8".',
    go: () => navigate(href('dashboard', { r: '7d' })),
  },
  {
    title: 'The record story',
    body: 'Every save of one policy, with the plug-ins, system jobs and cloud flows it started on one timeline. Flow runs carry no record id, so those links are inferred: each shows its confidence and the evidence behind it.',
    go: async () => {
      const id = await demoPolicyId();
      navigate(id ? href('record', {}, `hbr_policy/${id}`) : href('record'));
    },
  },
  {
    title: 'Expected vs. actual',
    body: 'What should run when a row changes, and why. Here the account rollup only changes hbr_totalpremium, so "Sync account to marketing" (filtered on name and phone) is not expected to run.',
    go: () => navigate(href('expected', { t: 'account', c: 'update', cols: 'hbr_totalpremium' })),
  },
  {
    title: 'Watch a save as it happens',
    body: 'Press Watch, then "Simulate save": the timeline fills in as rows arrive. In a real environment you save the record in the app instead.',
    go: async () => {
      const id = await demoPolicyId();
      navigate(id ? href('watch', { t: 'hbr_policy', id, n: 'HP-10000' }) : href('watch'));
    },
  },
];

let step: number | null = null;
const listeners = new Set<() => void>();
const set = (next: number | null) => {
  step = next;
  listeners.forEach((l) => l());
};

function markDone() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // Storage can be unavailable (private mode); the tour just shows again next time.
  }
}

export function startTour() {
  set(0);
  void STEPS[0]!.go();
}

/** Starts the tour on the first visit to the demo. */
export function useFirstVisitTour(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    try {
      done = localStorage.getItem(DONE_KEY) === '1';
    } catch {
      done = true;
    }
    if (!done) set(0);
  }, [enabled]);
}

export function Tour() {
  const current = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => step,
  );
  const [busy, setBusy] = useState(false);
  if (current === null) return null;
  const s = STEPS[current]!;
  const move = async (to: number | null) => {
    if (to === null || to >= STEPS.length) {
      markDone();
      set(null);
      return;
    }
    setBusy(true);
    set(to);
    await STEPS[to]!.go();
    setBusy(false);
  };
  return (
    <div className="tour card" role="dialog" aria-label="Guided tour" aria-live="polite">
      <div className="row">
        <span className="small muted grow">
          Tour · {current + 1} of {STEPS.length}
        </span>
        <Button size="small" appearance="subtle" icon={<DismissRegular />} aria-label="Close the tour" onClick={() => void move(null)} />
      </div>
      <div className="tour-title">{s.title}</div>
      <p className="small">{s.body}</p>
      <div className="row">
        {current === 0 ? (
          <Button size="small" appearance="primary" disabled={busy} onClick={() => void STEPS[0]!.go()}>
            Show me
          </Button>
        ) : (
          <Button size="small" disabled={busy} onClick={() => void move(current - 1)}>
            Back
          </Button>
        )}
        <div className="grow" />
        <Button size="small" appearance="primary" disabled={busy} onClick={() => void move(current + 1)}>
          {current === STEPS.length - 1 ? 'Done' : 'Next'}
        </Button>
      </div>
    </div>
  );
}
