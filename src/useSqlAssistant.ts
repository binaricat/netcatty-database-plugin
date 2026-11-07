import { useEffect, useRef, useState } from 'react';
import type { PluginContext, DatabaseSchemaResult } from '@netcatty/plugin-sdk';
import { AI_FEATURE, AssistantError, buildPrompt, DraftStream, type Task } from './domain';
import type { Message } from './i18n';

export function useSqlAssistant(context: PluginContext, schema: DatabaseSchemaResult | null, sql: string, label: string) {
  const enabled = context.enabledFeatures.has(AI_FEATURE);
  const [task, setTask] = useState<Task>('generate');
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const [stopped, setStopped] = useState(false);
  const generation = useRef(0); const locked = useRef(false);
  const stream = useRef<DraftStream | null>(null);
  if (!stream.current) stream.current = new DraftStream(context.ai);
  useEffect(() => () => { generation.current++; void stream.current?.stop(); }, []);
  const stop = () => {
    generation.current++; locked.current = false; setBusy(false); setStopped(true);
    // Invalidation is synchronous; late reads/open/start results cannot publish.
    void stream.current!.stop();
  };
  const run = async () => {
    if (!enabled || locked.current) return;
    const rev = ++generation.current; locked.current = true;
    setBusy(true); setFailure(null); setStopped(false); setDraft(''); setModel('');
    try {
      const prompt = buildPrompt(task, schema, sql, request, label);
      let received = false;
      await stream.current!.run(prompt, (text) => {
        if (rev === generation.current) { received = true; setDraft(text); }
      }, (name) => { if (rev === generation.current) setModel(name); });
      if (rev === generation.current && !received) setFailure('The host model returned no draft.');
    } catch (error) {
      if (rev === generation.current) {
        setDraft('');
        setFailure(error instanceof AssistantError
          ? error.reason === 'input' || error.reason === 'schema'
            ? 'Connected schema is missing or too large for assistance.'
            : 'AI output was rejected: unsupported stream or draft limit exceeded.'
          : 'AI unavailable. Check host model configuration and AI permission, then retry.');
      }
    } finally { if (rev === generation.current) { locked.current = false; setBusy(false); } }
  };
  return { enabled, task, setTask, request, setRequest, draft, model, busy, failure, stopped, run, stop };
}
