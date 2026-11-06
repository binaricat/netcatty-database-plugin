import React, { useMemo } from 'react';
import type { Translate } from './i18n';
import { gutterChunks, MAX_SQL_LENGTH, sqlLines, tokenizeSql } from './sqlDisplay';

export function SqlEditor({ sql, disabled, onChange, t }: { sql: string; disabled: boolean; onChange: (sql: string) => void; t: Translate }) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);
  const gutter = useMemo(() => gutterChunks(sql), [sql]);
  const columns = Math.max(1, ...sqlLines(sql).map((line) => [...line.replace(/\t/g, '    ')].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0)));
  // Replace the bounded overlay as a unit: mixed text/span sibling removals can
  // otherwise produce stale child indices in the remote mutation transport.
  // The textarea and scroll container stay mounted, preserving focus/selection.
  return <div className="sql-label"><span className="sql-caption">{t('SQL editor')}</span>
    <div className="sql-scroll"><div className="sql-content">
      <pre key={gutter.length} className="editor-gutter" aria-hidden="true">{gutter.map((chunk, i) => <span key={i}>{chunk}</span>)}</pre>
      <div className="sql-pane" style={{ minWidth: `calc(${columns + 1}ch + 20px)` }}>
        <pre className="sql-highlight" aria-hidden="true"><code key={sql}>{tokens.map((token, i) => token.kind === 'plain' ? token.text : <span key={i} className={`sql-${token.kind}`}>{token.text}</span>)}{'\n'}</code></pre>
        <textarea aria-label={t('SQL statement')} value={sql} maxLength={MAX_SQL_LENGTH} disabled={disabled} autoComplete="off" onChange={(e) => onChange(e.currentTarget.value)} />
      </div>
    </div></div>
  </div>;
}
