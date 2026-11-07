import { useEffect, useRef, useState } from 'react';
import { PluginContext } from '@netcatty/plugin-sdk';
import type { DatabaseSchemaResult } from './databaseTypes';
import { AI_FEATURE, AssistantError, buildPrompt, DraftStream, extractSqlDraft, type AssistantExchange, type Task } from './domain';
import type { Message } from './i18n';
import { AssistantRequestBranch, type AssistantRequestSnapshot } from './assistantRequestBranch';

export function useSqlAssistant(context: PluginContext, schema: DatabaseSchemaResult | null, sql: string, label: string, engine = 'sqlite', dialect = 'SQLite') {
  const enabled = context.enabledFeatures.has(AI_FEATURE);
  const [task, setTask] = useState<Task>('generate');
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [conversation, setConversation] = useState<AssistantExchange[]>([]);
  const [draftTask, setDraftTask] = useState<Task>('generate');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const [stopped, setStopped] = useState(false);
  const branch = useRef(new AssistantRequestBranch()); const locked = useRef(false);
  const [hasLastRequest, setHasLastRequest] = useState(false);
  const stream = useRef<DraftStream | null>(null);
  if (!stream.current) stream.current = new DraftStream(context.ai);
  useEffect(() => () => { branch.current.invalidate(); void stream.current?.stop(); }, []);
  const stop = () => {
    branch.current.invalidate(); locked.current = false; setBusy(false); setStopped(true);
    // Invalidation is synchronous; late reads/open/start results cannot publish.
    void stream.current!.stop();
  };
  const run = async (retry?: AssistantRequestSnapshot) => {
    if (!enabled || locked.current) return;
    if (!retry) { branch.current.clear(); setHasLastRequest(false); }
    const rev = branch.current.begin(); locked.current = true;
    setBusy(true); setFailure(null); setStopped(false); setDraft(''); setModel('');
    try {
      const snapshot = retry ?? branch.current.capture(buildPrompt(task, schema, sql, request, label, engine, dialect, conversation), request, task, conversation);
      setHasLastRequest(true);
      setDraftTask(snapshot.task);
      let received = false; let completed = '';
      await stream.current!.run(snapshot.prompt, (text) => {
        if (branch.current.current(rev)) { received = true; completed = text; setDraft(text); }
      }, (name) => { if (branch.current.current(rev)) setModel(name); });
      if (received) { const next = branch.current.complete(rev, snapshot, completed); if (next) setConversation(next); }
      if (branch.current.current(rev) && !received) setFailure('The host model returned no draft.');
    } catch (error) {
      if (branch.current.current(rev)) {
        setDraft('');
        setFailure(error instanceof AssistantError
          ? error.reason === 'input' || error.reason === 'schema'
            ? 'Connected schema is missing or too large for assistance.'
            : 'AI output was rejected: unsupported stream or draft limit exceeded.'
          : 'AI unavailable. Check host model configuration and AI permission, then retry.');
      }
    } finally { if (branch.current.current(rev)) { locked.current = false; setBusy(false); } }
  };
  const retryLast = () => { const snapshot = branch.current.snapshot; if (snapshot) return run(snapshot); };
  const editLast = () => {
    if (locked.current) return;
    const snapshot = branch.current.snapshot; if (!snapshot) return;
    stop(); setTask(snapshot.task); setRequest(snapshot.request); setConversation([...snapshot.history]);
    branch.current.clear(); setHasLastRequest(false);
    setDraft(''); setFailure(null); setStopped(false); setModel('');
  };
  const reset = () => { stop(); branch.current.clear(); setHasLastRequest(false); setConversation([]); setDraft(''); setFailure(null); setStopped(false); setModel(''); };
  const insertableSql = extractSqlDraft(draft, draftTask);
  return { conversation, reset, hasLastRequest, lastRequest: branch.current.snapshot, retryLast, editLast, insertableSql, enabled, task, setTask, request, setRequest, draft, model, busy, failure, stopped, run, stop };
}
