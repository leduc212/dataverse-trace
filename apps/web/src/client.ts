// The UI's handle on the worker, plus small hooks for status and async data.
import * as Comlink from 'comlink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HostInfo, Status, WorkerApi } from './shared/api.ts';

export interface Client {
  api: Comlink.Remote<WorkerApi>;
  host: HostInfo;
}

let status: Status | null = null;
const listeners = new Set<() => void>();
let client: Client | null = null;

export function startClient(host: HostInfo): Client {
  const worker = new Worker(new URL('./worker/worker.ts', import.meta.url), { type: 'module', name: 'dataverse-trace' });
  const api = Comlink.wrap<WorkerApi>(worker);
  void api.subscribe(
    Comlink.proxy((next: Status) => {
      status = next;
      listeners.forEach((l) => l());
    }),
  );
  void api.init(host);
  client = { api, host };
  return client;
}

export function getClient(): Client {
  if (!client) throw new Error('Client not started');
  return client;
}

/** Same as getClient(); reads nicer inside components. */
export const useClient = getClient;

export function useStatus(): Status | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => status,
  );
}

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
}

/**
 * Runs `load` whenever `deps` change and keeps the last result while the next one loads, so
 * views don't flash empty. Stale responses are dropped.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, loading: true, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => id === seq.current && setState({ data, loading: false, error: null }),
      (e: unknown) => id === seq.current && setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
