import React from 'react';
import type { PluginContext, DatabaseSchemaResult } from '@netcatty/plugin-sdk';
import { tasks } from './domain';
import type { Translate } from './i18n';
import { useSqlAssistant } from './useSqlAssistant';

export function SqlAssistant({ context, schema, sql, label, engine, dialect, disabled, insert, t }: {
  context: PluginContext; schema: DatabaseSchemaResult | null; sql: string; label: string; engine?: string; dialect?: string;
  disabled: boolean; insert: (draft: string) => void; t: Translate;
}) {
  const ai = useSqlAssistant(context, schema, sql, label, engine, dialect);
  const status = !ai.enabled || ai.failure ? t('Unavailable') : ai.busy ? t('Generating unexecuted draft...') : ai.stopped ? t('Stopped - draft remains unexecuted.') : t('Host model - checked when you run assistance.');
  return <div className="ai-content">
    <p role="status">{status + (ai.model ? ` ${t('Host model')}: ${ai.model}` : '')}</p>
    {!ai.enabled ? <p>{t('Host AI is unavailable on this host.')}</p> : <>
      <p className="hint">{t('Shares connected schema metadata, connection label, current editor SQL and your request with the host model. No result rows. Do not include secrets.')}</p>
      <label>{t('SQL assistance task')}<select aria-label={t('SQL assistance task')} value={ai.task} disabled={ai.busy} onChange={(e) => { const value = e.currentTarget.value; const task = tasks.find(task => task === value); if (task) ai.setTask(task); }}>{tasks.map((task) => <option key={task} value={task}>{t(task)}</option>)}</select></label>
      <label>{t('Your request')}<textarea aria-label={t('Your request')} value={ai.request} maxLength={1500} disabled={ai.busy} onChange={(e) => ai.setRequest(e.currentTarget.value)} /></label>
      <button className="secondary" disabled={disabled || ai.busy || !schema?.tables.length} onClick={() => void ai.run()}>{t('Run assistance')}</button>
      <button className="secondary" disabled={!ai.busy} onClick={ai.stop}>{t('Stop')}</button>
      {ai.failure && <p role="alert">{t(ai.failure)}</p>}
    </>}
    <p className="hint">{`${t('Unexecuted AI draft')}. ${t('Insertion replaces editor text only. Review SQL and parameters before Run read query or Review write. Nothing executes automatically.')}`}</p><pre aria-label={t('Unexecuted AI draft')}>{ai.draft || t('No draft generated.')}</pre>
    <button className="secondary" disabled={disabled || ai.busy || ai.stopped || Boolean(ai.failure) || !ai.draft} onClick={() => insert(ai.draft)}>{t('Insert draft into editor')}</button>
  </div>;
}
