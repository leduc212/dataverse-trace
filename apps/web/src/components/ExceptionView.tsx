import { Button, Tooltip } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';
import { parseException, type ParsedException } from '@dvt/core';
import { useState } from 'react';

function toMarkdown(e: ParsedException, depth = 0): string {
  const head = `${'#'.repeat(Math.min(6, 3 + depth))} ${e.type ?? 'Exception'}\n\n${e.message}\n`;
  const code = e.errorCode ? `\nError code: \`${e.errorCode}\`\n` : '';
  const frames = e.frames.length ? `\n\`\`\`\n${e.frames.map((f) => f.text).join('\n')}\n\`\`\`\n` : '';
  return head + code + frames + e.inner.map((i) => `\nCaused by:\n\n${toMarkdown(i, depth + 1)}`).join('');
}

function ExceptionBlock({ e, level }: { e: ParsedException; level: number }) {
  const [showFramework, setShowFramework] = useState(false);
  const userFrames = e.frames.filter((f) => !f.framework);
  const hidden = e.frames.length - userFrames.length;
  const frames = showFramework ? e.frames : userFrames;
  return (
    <div style={{ marginLeft: level ? 12 : 0, borderLeft: level ? '2px solid var(--colorNeutralStroke2)' : undefined, paddingLeft: level ? 10 : 0, marginTop: level ? 10 : 0 }}>
      {level > 0 && <div className="small muted">Caused by</div>}
      <div className="mono" style={{ fontWeight: 600, wordBreak: 'break-all' }}>
        {e.type ?? 'Exception'}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{e.message}</div>
      {e.errorCode && <div className="small muted">Error code {e.errorCode}</div>}
      {e.frames.length > 0 && (
        <>
          <ul className="frames">
            {frames.map((f, i) => (
              <li key={i} className={f.framework ? 'framework' : undefined}>
                {f.method}
                {f.file && (
                  <span className="muted">
                    {' '}
                    — {f.file.split(/[\\/]/).pop()}:{f.line}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <button className="link small" onClick={() => setShowFramework((s) => !s)}>
              {showFramework ? 'Hide' : 'Show'} {hidden} platform frame{hidden === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}
      {e.inner.map((inner, i) => (
        <ExceptionBlock key={i} e={inner} level={level + 1} />
      ))}
    </div>
  );
}

export function ExceptionView({ text }: { text: string }) {
  const parsed = parseException(text);
  const [raw, setRaw] = useState(false);
  if (!parsed) return <div className="muted">No exception.</div>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="link small" onClick={() => setRaw((r) => !r)}>
          {raw ? 'Show parsed' : 'Show raw text'}
        </button>
        <div className="grow" />
        <Tooltip content="Copy as Markdown (for a bug report)" relationship="label">
          <Button size="small" appearance="subtle" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(toMarkdown(parsed))}>
            Markdown
          </Button>
        </Tooltip>
      </div>
      {raw ? <pre className="text-viewer" style={{ padding: 8, margin: 0, whiteSpace: 'pre-wrap' }}>{text}</pre> : <ExceptionBlock e={parsed} level={0} />}
    </div>
  );
}
