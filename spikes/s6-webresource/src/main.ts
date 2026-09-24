import {
  dynamicImportCheck,
  envChecks,
  orgChecks,
  s1Checks,
  s2Check,
  s4Check,
  s5Check,
  storedPrecisionCheck,
  versionedPathCheck,
  whoAmICheck,
  workerChecks,
  type RunContext,
} from './checks.ts';
import { storageChecks } from './storage.ts';
import type { CheckResult, Spike } from './types.ts';

const GROUPS: Record<Spike, string> = {
  env: 'Environment',
  S6: 'S6 · Web resource hosting',
  org: 'Organization',
  S1: 'S1 · Timestamp precision',
  S2: 'S2 · Meaning of plugintracelog.createdby',
  S4: 'S4 · Flow run ingestion delay and visibility',
  S5: 'S5 · Async trace ↔ system job correlation',
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const resultsEl = el<HTMLElement>('results');
const statusEl = el<HTMLElement>('status');
const runButton = el<HTMLButtonElement>('run');
const copyButton = el<HTMLButtonElement>('copy');
const downloadButton = el<HTMLButtonElement>('download');
const maskBox = el<HTMLInputElement>('mask');

let results: CheckResult[] = [];
let ranAt = '';
let ctx: RunContext = { personalNames: new Set() };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text; // always text, never HTML
  if (className) element.className = className;
  return element;
}

function render(): void {
  resultsEl.replaceChildren();
  for (const spike of Object.keys(GROUPS) as Spike[]) {
    const group = results.filter((r) => r.spike === spike);
    if (group.length === 0) continue;
    resultsEl.append(node('h2', GROUPS[spike]));
    const table = node('table');
    for (const r of group) {
      const row = node('tr');
      row.append(node('td', r.status.toUpperCase(), `status ${r.status}`), node('td', r.title));
      const summary = node('td', r.summary);
      if (r.details !== undefined) {
        const details = node('details');
        details.append(node('summary', 'details'), node('pre', JSON.stringify(r.details, null, 2)));
        summary.append(details);
      }
      row.append(summary);
      table.append(row);
    }
    resultsEl.append(table);
  }
}

function exportJson(): string {
  let json = JSON.stringify({ tool: 'dataverse-trace spike S6', version: '0.0.2', ranAt, results }, null, 2);
  if (maskBox.checked) {
    json = json.split(location.host).join('<org-host>');
    [...ctx.personalNames]
      .sort((a, b) => b.length - a.length)
      .forEach((name, i) => (json = json.split(name).join(`<user-${i + 1}>`)));
  }
  return json;
}

async function run(): Promise<void> {
  results = [];
  ctx = { personalNames: new Set() };
  ranAt = new Date().toISOString();
  runButton.disabled = copyButton.disabled = downloadButton.disabled = true;
  const push = (items: CheckResult[]) => {
    results.push(...items);
    render();
  };
  const steps: Array<[string, () => Promise<CheckResult[]>]> = [
    ['environment', envChecks],
    ['Web API from the page', async () => [await whoAmICheck(ctx)]],
    ['dynamic import', async () => [await dynamicImportCheck()]],
    ['versioned path', async () => [await versionedPathCheck()]],
    ['worker', workerChecks],
    ['page storage', () => storageChecks('page')],
    ['organization settings', orgChecks],
    ['S1 timestamps', s1Checks],
    ['S1 stored precision (about 100 small requests)', async () => [await storedPrecisionCheck()]],
    ['S2 createdby', async () => [await s2Check(ctx)]],
    ['S4 flow runs', async () => [await s4Check(ctx)]],
    ['S5 async correlation', async () => [await s5Check()]],
  ];
  for (const [label, step] of steps) {
    statusEl.textContent = `Running: ${label}…`;
    push(await step());
  }
  const count = (s: string) => results.filter((r) => r.status === s).length;
  statusEl.textContent = `Done: ${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail, ${count('info')} info.`;
  runButton.disabled = copyButton.disabled = downloadButton.disabled = false;
}

runButton.addEventListener('click', () => void run());
copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(exportJson());
  statusEl.textContent = 'Copied results to the clipboard.';
});
downloadButton.addEventListener('click', () => {
  const link = node('a');
  link.href = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
  link.download = `dvt-spike-s6-${ranAt.replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

void run();
