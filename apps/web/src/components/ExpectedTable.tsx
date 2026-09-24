// Expected vs. actual: everything registered to run, whether it should have, and whether it did.
import type { ExpectedItem, Tri } from '@dvt/core';
import { Badge } from '@fluentui/react-components';
import { CheckmarkCircleFilled, CircleRegular, DismissCircleRegular, QuestionCircleRegular } from '@fluentui/react-icons';

const KIND: Record<ExpectedItem['kind'], string> = { step: 'Plug-in step', workflow: 'Classic workflow', businessRule: 'Business rule', flow: 'Cloud flow' };

function ShouldRun({ value }: { value: Tri }) {
  if (value === true) return <span className="tri yes"><CheckmarkCircleFilled /> should run</span>;
  if (value === false) return <span className="tri no"><CircleRegular /> not expected</span>;
  return <span className="tri unknown"><QuestionCircleRegular /> can't tell</span>;
}

function Ran({ item }: { item: ExpectedItem }) {
  if (item.ran === 'yes') {
    return (
      <span className="tri yes">
        <CheckmarkCircleFilled /> ran
        {item.confidence !== null && item.confidence < 1 && (
          <Badge size="small" appearance="outline" color="warning" style={{ marginLeft: 6 }} title="Matched by timing and trigger (inferred)">
            ≈{Math.round(item.confidence * 100)}%
          </Badge>
        )}
      </span>
    );
  }
  if (item.ran === 'no') {
    return item.shouldRun === false ? (
      <span className="tri muted">–</span>
    ) : (
      <span className="tri miss">
        <DismissCircleRegular /> didn't run
      </span>
    );
  }
  return <span className="tri unknown"><QuestionCircleRegular /> unknown</span>;
}

/** `observed` = a save was selected, so "Ran" is meaningful. */
export function ExpectedTable({ items, observed, onSelectSpan }: { items: ExpectedItem[]; observed: boolean; onSelectSpan?: (spanId: string) => void }) {
  if (!items.length) {
    return <div className="small muted" style={{ padding: 12 }}>Nothing is registered to run for this table and change (no plug-in steps, workflows or cloud flows were found).</div>;
  }
  return (
    <table className="data expected">
      <thead>
        <tr>
          <th>When</th>
          <th>What</th>
          <th>Should run?</th>
          {observed && <th>Ran?</th>}
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const miss = observed && item.shouldRun === true && item.ran === 'no';
          const span = item.spanIds[0];
          return (
            <tr
              key={`${item.kind}:${item.id}`}
              className={`${miss ? 'miss' : ''}${item.shouldRun === false ? ' dim' : ''}`}
              style={span && onSelectSpan ? { cursor: 'pointer' } : undefined}
              onClick={span && onSelectSpan ? () => onSelectSpan(span) : undefined}
            >
              <td className="small nowrap">{item.phase}</td>
              <td>
                <div>{item.name}</div>
                <div className="small muted">{KIND[item.kind]}</div>
              </td>
              <td className="nowrap">
                <ShouldRun value={item.shouldRun} />
              </td>
              {observed && (
                <td className="nowrap">
                  <Ran item={item} />
                </td>
              )}
              <td className="small">
                {item.reasons.join('; ')}
                {observed && item.ranDetail && item.ran !== 'yes' && item.shouldRun !== false ? <div className="muted">{item.ranDetail}</div> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
