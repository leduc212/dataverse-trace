// Hash routing. Web resources are single files, so path-based routes would 404 on refresh.
//   #/explorer?q=…&r=24h&v=operations&s=newest
//   #/trace/<correlationId>
//   #/dashboard?r=7d
//   #/graph?r=7d&t=<table>&n=<step key>
//   #/status
//   #/record/<table>/<id>?save=<saveId>   (#/record alone: pick a record)
//   #/expected?t=<table>&c=update&cols=a,b
//   #/watch
//   #/session                              (open a .dvtrace.json file)
import { useSyncExternalStore } from 'react';

export type Page = 'explorer' | 'trace' | 'dashboard' | 'graph' | 'status' | 'record' | 'expected' | 'watch' | 'session';

export interface Route {
  page: Page;
  id: string | null;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [page, id] = path.split('/');
  const params = new URLSearchParams(query);
  switch (page) {
    case 'trace':
      return { page: 'trace', id: id ? decodeURIComponent(id) : null, params };
    case 'record': {
      // "table/id" (both parts kept, so the id carries the table).
      const rest = path.split('/').slice(1).map(decodeURIComponent);
      return { page: 'record', id: rest.length >= 2 && rest[0] && rest[1] ? `${rest[0]}/${rest[1]}` : null, params };
    }
    case 'expected':
    case 'watch':
    case 'session':
    case 'dashboard':
    case 'graph':
    case 'status':
    case 'explorer':
      return { page, id: null, params };
    default:
      return { page: 'explorer', id: null, params };
  }
}

export function href(page: Page, params: Record<string, string | undefined> = {}, id?: string): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, v);
  const qs = search.toString();
  const path = id ? `/${id.split('/').map(encodeURIComponent).join('/')}` : '';
  return `#/${page}${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(target: string, replace = false): void {
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

let cachedHash = '';
let cachedRoute: Route = parseHash('');

export function useRoute(): Route {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => {
      if (location.hash !== cachedHash) {
        cachedHash = location.hash;
        cachedRoute = parseHash(cachedHash);
      }
      return cachedRoute;
    },
  );
}
