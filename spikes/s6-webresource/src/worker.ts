// Module worker loaded from a sibling web resource. Proves the worker can call the Web API with the
// session (the real app does all fetching in a worker) and use the same storage APIs as the page.
import { getJson } from './api.ts';
import { storageChecks } from './storage.ts';
import { check, type CheckResult } from './types.ts';

self.addEventListener('message', async (event: MessageEvent) => {
  if (event.data !== 'run') return;
  const results: CheckResult[] = [
    {
      id: 's6.worker.context',
      spike: 'S6',
      title: 'Worker context',
      status: 'info',
      summary: self.location.href,
      details: { workerLocation: self.location.href, importMetaUrl: import.meta.url },
    },
    await check('s6.worker.whoami', 'S6', 'Web API from the worker (session cookie)', async () => {
      const who = await getJson<{ UserId: string }>('WhoAmI', { annotations: false });
      return { status: 'pass', summary: `WhoAmI succeeded (UserId ${who.UserId})` };
    }),
    ...(await storageChecks('worker')),
  ];
  self.postMessage(results);
});

self.postMessage('ready');
