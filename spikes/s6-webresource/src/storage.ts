import { check, type CheckResult } from './types.ts';

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function indexedDbRoundTrip(scope: string): Promise<string> {
  const name = `dvt-spike-${scope}`;
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv', { keyPath: 'id' });
  const db = await idbRequest(open);
  try {
    const written = { id: 'probe', at: Date.now() };
    const tx = db.transaction('kv', 'readwrite');
    await idbRequest(tx.objectStore('kv').put(written));
    const read = (await idbRequest(db.transaction('kv').objectStore('kv').get('probe'))) as typeof written;
    if (read.at !== written.at) throw new Error('Read value differs from written value');
  } finally {
    db.close();
  }
  await idbRequest(indexedDB.deleteDatabase(name));
  return 'open, write, read and delete succeeded';
}

async function gzipRoundTrip(): Promise<string> {
  const text = 'Harbor.Plugins.PolicyPostCreate: Loaded config\n'.repeat(200);
  const compressed = await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const restored = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  if (restored !== text) throw new Error('Decompressed text differs');
  return `${text.length} → ${compressed.byteLength} bytes`;
}

/** Browser capabilities the app relies on, checked in the page and again in the worker. */
export async function storageChecks(scope: 'page' | 'worker'): Promise<CheckResult[]> {
  return Promise.all([
    check(`s6.${scope}.indexeddb`, 'S6', `IndexedDB (${scope})`, async () => ({
      status: 'pass',
      summary: await indexedDbRoundTrip(scope),
    })),
    check(`s6.${scope}.locks`, 'S6', `Web Locks (${scope})`, async () => {
      if (!('locks' in navigator)) return { status: 'warn', summary: 'navigator.locks not available; need a fallback' };
      let ran = false;
      await navigator.locks.request(`dvt-spike-${scope}`, async () => {
        ran = true;
      });
      return ran ? { status: 'pass', summary: 'lock acquired and released' } : { status: 'fail', summary: 'lock callback never ran' };
    }),
    check(`s6.${scope}.compression`, 'S6', `CompressionStream gzip (${scope})`, async () => ({
      status: 'pass',
      summary: await gzipRoundTrip(),
    })),
    check(`s6.${scope}.broadcast`, 'S6', `BroadcastChannel (${scope})`, async () =>
      'BroadcastChannel' in self
        ? { status: 'pass', summary: 'available' }
        : { status: 'warn', summary: 'not available; multi-tab sync coordination needs a fallback' },
    ),
    check(`s6.${scope}.quota`, 'S6', `Storage quota (${scope})`, async () => {
      const estimate = await navigator.storage.estimate();
      const persisted = scope === 'page' && navigator.storage.persisted ? await navigator.storage.persisted() : undefined;
      const mb = (n?: number) => (n === undefined ? '?' : `${Math.round(n / 1024 / 1024)} MB`);
      return {
        status: 'info',
        summary: `quota ${mb(estimate.quota)}, used ${mb(estimate.usage)}${persisted === undefined ? '' : `, persisted: ${persisted}`}`,
      };
    }),
  ]);
}
