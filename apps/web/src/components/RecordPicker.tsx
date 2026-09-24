// Pick a record: paste an app URL or id, search a table by name, or choose a recent one.
import { parseRecordInput } from '@dvt/core';
import { Button, Dropdown, Input, Option, Spinner } from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useAsync, useClient, useStatus } from '../client.ts';
import { formatAgo } from '../format.ts';
import type { RecentRecord } from '../shared/api.ts';

export interface PickedRecord {
  table: string;
  id: string;
  name: string | null;
}

export function RecordPicker({ onPick, hint }: { onPick: (r: PickedRecord) => void; hint?: string }) {
  const { api } = useClient();
  const status = useStatus();
  const tables = useAsync(() => api.knownTables(), [status?.dataVersion]);
  const recent = useAsync(() => api.recentRecords(20), [status?.dataVersion]);
  const [pasted, setPasted] = useState('');
  const [table, setTable] = useState('');
  const [text, setText] = useState('');
  const [results, setResults] = useState<RecentRecord[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseRecordInput(pasted);
  const open = () => {
    if (!parsed) return setError('Paste a record URL (with etn and id), "table:id", or a record id.');
    const t = parsed.table ?? table;
    if (!t) return setError('Choose the table of this record below, then press Open again.');
    setError(null);
    onPick({ table: t, id: parsed.id, name: null });
  };
  const search = async () => {
    if (!table || !text.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchRecords(table, text));
    } catch (e) {
      setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="picker">
      {hint && <p className="small muted" style={{ marginTop: 0 }}>{hint}</p>}
      <div className="row wrap">
        <Input
          className="grow"
          style={{ minWidth: 280 }}
          value={pasted}
          placeholder="Paste a record URL from the app, or table:id"
          onChange={(_, d) => setPasted(d.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()}
          aria-label="Record URL or id"
        />
        <Button appearance="primary" onClick={open} disabled={!pasted.trim()}>
          Open
        </Button>
      </div>
      <div className="row wrap" style={{ marginTop: 8 }}>
        <Dropdown
          placeholder="Table"
          value={table}
          selectedOptions={table ? [table] : []}
          onOptionSelect={(_, d) => setTable(d.optionValue ?? '')}
          style={{ minWidth: 180 }}
          aria-label="Table"
        >
          {(tables.data ?? []).map((t) => (
            <Option key={t} value={t}>
              {t}
            </Option>
          ))}
        </Dropdown>
        <Input className="grow" value={text} placeholder="Search by name" onChange={(_, d) => setText(d.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} aria-label="Record name" />
        <Button icon={searching ? <Spinner size="extra-tiny" /> : <SearchRegular />} onClick={() => void search()} disabled={!table || !text.trim()}>
          Search
        </Button>
      </div>
      {error && <div className="small error-text" style={{ marginTop: 6 }}>{error}</div>}
      {results && (
        <RecordList title={results.length ? 'Search results' : 'No records match'} records={results} onPick={onPick} />
      )}
      {(recent.data?.length ?? 0) > 0 && <RecordList title="Recently seen (system jobs regarding a record)" records={recent.data!} onPick={onPick} />}
    </div>
  );
}

function RecordList({ title, records, onPick }: { title: string; records: RecentRecord[]; onPick: (r: PickedRecord) => void }) {
  return (
    <>
      <div className="section-title small" style={{ marginTop: 12 }}>
        {title}
      </div>
      <table className="data">
        <tbody>
          {records.map((r) => (
            <tr key={`${r.table}:${r.id}`} style={{ cursor: 'pointer' }} onClick={() => onPick({ table: r.table, id: r.id, name: r.name })}>
              <td>{r.name ?? <span className="mono">{r.id}</span>}</td>
              <td className="muted">{r.table}</td>
              <td className="num muted small">{r.source === 'search' ? '' : formatAgo(r.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
