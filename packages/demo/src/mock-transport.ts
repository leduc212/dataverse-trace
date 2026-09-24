// In-memory stand-in for the Dataverse Web API, serving a DemoDataset. Implements the same
// Transport interface as FetchTransport, so demo mode exercises the real sync engine and mappers.
import { HttpError, type ODataPage, type RequestOptions, type Transport } from '@dvt/dataverse';
import type { DemoDataset } from './generator.ts';
import { evaluate, parseRequest, project, sortRows, type Row } from './odata.ts';

export interface MockTransportOptions {
  /** Simulated network latency per request. */
  latencyMs?: number;
  /** Entity sets that answer 403, to simulate missing privileges. */
  forbidden?: string[];
  /** Largest page size when the caller doesn't ask for one (the platform default is 5,000). */
  defaultPageSize?: number;
}

export class MockTransport implements Transport {
  readonly #data: DemoDataset;
  readonly #options: MockTransportOptions;
  readonly #tables: Record<string, Row[]>;
  /** Number of requests served, for tests and the demo's status panel. */
  requests = 0;

  constructor(data: DemoDataset, options: MockTransportOptions = {}) {
    this.#data = data;
    this.#options = options;
    this.#tables = {
      plugintracelogs: data.traceLogs,
      asyncoperations: data.asyncOperations,
      sdkmessageprocessingsteps: data.steps,
      organizations: [data.organization],
    };
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    this.requests++;
    if (this.#options.latencyMs) await new Promise((r) => setTimeout(r, this.#options.latencyMs));
    options.signal?.throwIfAborted();

    const request = parseRequest(path);
    if (this.#options.forbidden?.includes(request.resource)) {
      throw new HttpError(403, `Principal user is missing prvRead${request.resource} privilege.`);
    }
    if (request.resource === 'WhoAmI') {
      return { UserId: this.#data.userId, BusinessUnitId: '1c7b0d9e-5a2f-4e6b-8c31-9f0a2d4b6e18', OrganizationId: this.#data.organizationId } as T;
    }
    if (request.navigation) return this.#page(this.#navigation(request.resource, request.navigation), request, options) as T;

    const table = this.#tables[request.resource];
    if (!table) throw new HttpError(404, `Resource not found for the segment '${request.resource}'.`);
    return this.#page(table, request, options) as T;
  }

  #navigation(resource: string, navigation: string): Row[] {
    if (resource === 'systemusers' && navigation === 'systemuserroles_association') return this.#data.userRoles;
    if (resource === 'systemusers' && navigation === 'teammembership_association') return [];
    if (resource === 'teams' && navigation === 'teamroles_association') return [];
    throw new HttpError(404, `Resource not found for the segment '${navigation}'.`);
  }

  #page(rows: Row[], request: ReturnType<typeof parseRequest>, options: RequestOptions): ODataPage<Row> {
    const filtered = request.filter ? rows.filter((r) => evaluate(request.filter!, r)) : rows;
    const sorted = sortRows(filtered, request.orderBy);
    const limited = request.top !== undefined ? sorted.slice(0, request.top) : sorted;
    const pageSize = options.maxPageSize ?? this.#options.defaultPageSize ?? 5000;
    const slice = limited.slice(request.skip, request.skip + pageSize);
    const page: ODataPage<Row> = { value: slice.map((r) => project(r, request, options.annotations !== false)) };
    if (request.skip + pageSize < limited.length) {
      const params = request.params.filter(([k]) => k !== '$skiptoken');
      params.push(['$skiptoken', String(request.skip + pageSize)]);
      const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const resource = request.key ? `${request.resource}(${request.key})/${request.navigation}` : request.resource;
      page['@odata.nextLink'] = `${resource}?${query}`;
    }
    return page;
  }
}
