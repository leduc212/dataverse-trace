// Expected vs. actual without a save: "if I change these columns of this table, what runs?"
import type { ChangeKind } from '@dvt/core';
import { Button, Dropdown, Input, MessageBar, MessageBarBody, Option, Spinner } from '@fluentui/react-components';
import { useState } from 'react';
import { EmptyState } from '../components/bits.tsx';
import { ExpectedTable } from '../components/ExpectedTable.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { href, navigate, useRoute } from '../router.ts';

const CHANGES: Array<[ChangeKind, string]> = [
  ['update', 'Update'],
  ['create', 'Create'],
  ['delete', 'Delete'],
];

const parseColumns = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

export function ExpectedPage() {
  const { api } = useClient();
  const status = useStatus();
  const route = useRoute();
  const table = route.params.get('t') ?? '';
  const change = (route.params.get('c') as ChangeKind | null) ?? 'update';
  const cols = route.params.get('cols');
  const [draft, setDraft] = useState(cols ?? '');
  const tables = useAsync(() => api.knownTables(), [status?.dataVersion]);
  const columns = cols === null ? null : parseColumns(cols);
  const result = useAsync(
    () => (table ? api.expected({ table, change, changedColumns: change === 'update' ? columns : null }) : Promise.resolve(null)),
    [table, change, cols, status?.dataVersion],
  );
  const go = (patch: Record<string, string | undefined>) => {
    const next = { t: table, c: change, cols: cols ?? undefined, ...patch };
    navigate(href('expected', next), true);
  };
  const addColumn = (c: string) => {
    const next = [...new Set([...parseColumns(draft), c])].join(', ');
    setDraft(next);
    go({ cols: next });
  };

  return (
    <main className="page">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="section-title">Expected vs. actual</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Everything registered to run when a row changes, in execution order, and whether each one should run for the columns you change. To compare with what actually ran,
          open a save in a <a className="link" href={href('record')}>record story</a>.
        </p>
        <div className="row wrap">
          <Dropdown
            placeholder="Table"
            value={table}
            selectedOptions={table ? [table] : []}
            onOptionSelect={(_, d) => go({ t: d.optionValue })}
            style={{ minWidth: 200 }}
            aria-label="Table"
          >
            {(tables.data ?? []).map((t) => (
              <Option key={t} value={t}>
                {t}
              </Option>
            ))}
          </Dropdown>
          <Dropdown value={CHANGES.find(([k]) => k === change)?.[1] ?? 'Update'} selectedOptions={[change]} onOptionSelect={(_, d) => go({ c: d.optionValue })} style={{ minWidth: 120 }} aria-label="Change">
            {CHANGES.map(([k, label]) => (
              <Option key={k} value={k}>
                {label}
              </Option>
            ))}
          </Dropdown>
          {change === 'update' && (
            <>
              <Input
                className="grow"
                style={{ minWidth: 260 }}
                value={draft}
                placeholder="Changed columns, e.g. hbr_status, hbr_premium (empty = not known)"
                onChange={(_, d) => setDraft(d.value)}
                onKeyDown={(e) => e.key === 'Enter' && go({ cols: draft.trim() ? draft : undefined })}
                aria-label="Changed columns"
              />
              <Button appearance="primary" onClick={() => go({ cols: draft.trim() ? draft : undefined })}>
                Check
              </Button>
            </>
          )}
        </div>
        {change === 'update' && (result.data?.columns.length ?? 0) > 0 && (
          <div className="row wrap small" style={{ marginTop: 8 }}>
            <span className="muted">Columns that decide what runs:</span>
            {result.data!.columns.map((c) => (
              <Button key={c} size="small" appearance={columns?.includes(c) ? 'primary' : 'outline'} shape="circular" onClick={() => addColumn(c)}>
                {c}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        {!table ? (
          <EmptyState title="Choose a table">Pick the table and the change to see what's registered to run.</EmptyState>
        ) : !result.data ? (
          <div className="loading-screen" style={{ minHeight: 160 }}>
            {result.loading ? <Spinner /> : <span className="error-text">{result.error}</span>}
          </div>
        ) : (
          <>
            {result.data.note && (
              <MessageBar intent="warning">
                <MessageBarBody>{result.data.note}</MessageBarBody>
              </MessageBar>
            )}
            {change === 'update' && columns === null && (
              <MessageBar intent="info">
                <MessageBarBody>Changed columns aren't set, so anything with filtering columns shows as "can't tell". Add the columns you change.</MessageBarBody>
              </MessageBar>
            )}
            <ExpectedTable items={result.data.items} observed={false} />
          </>
        )}
      </div>
    </main>
  );
}
