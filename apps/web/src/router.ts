// Hash routing. Web resources are single files, so path-based routes would 404 on refresh.
//   #/explorer?q=…&r=24h&v=operations&s=newest
//   #/trace/<correlationId>
//   #/dashboard?r=7d
//   #/status
import { useSyncExternalStore } from 'react';

export type Page = 'explorer' | 'trace' | 'dashboard' | 'status';

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
    case 'dashboard':
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
  return `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}${qs ? `?${qs}` : ''}`;
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
