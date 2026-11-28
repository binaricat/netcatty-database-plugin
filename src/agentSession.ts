import type { PluginAgentClient } from '@netcatty/plugin-sdk';
type Reply<K extends keyof PluginAgentClient> = Awaited<ReturnType<PluginAgentClient[K]>>;
export type AgentEvent = Reply<'read'>;
export type AgentSessionState = 'closed' | 'opening' | 'ready' | 'sending';
export class AgentSessionError extends Error {
  constructor(readonly reason: 'busy' | 'closed' | 'cancelled' | 'expired' | 'limit' | 'actions-forbidden' | 'backend-unavailable') { super(reason); }
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** Conversation-only integration. The manifest MUST NOT declare ai.agent.actions.
 * The host is the enforcement boundary: openChat has no per-chat action-disable flag.
 * This adapter never executes SQL, grants permissions or retries denied operations.
 */
export class AgentSession {
  private generation = 0;
  private chat?: Reply<'openChat'>;
  private turn?: Reply<'send'>;
  private phase: AgentSessionState = 'closed';
  get state(): AgentSessionState { return this.phase; }
  constructor(private readonly client: PluginAgentClient, policy: { actionsPermissionDeclared: false }, private readonly now = Date.now) {
    if (policy.actionsPermissionDeclared !== false) throw new AgentSessionError('actions-forbidden');
  }
  async discover() { return (await this.client.listBackends({})).items.slice(0, 32); }
  async listChats() { return (await this.client.listChats({})).items.slice(0, 100); }
  private current(generation: number) {
    if (generation !== this.generation) throw new AgentSessionError('cancelled');
  }
  private ready() {
    if (this.phase !== 'ready' || !this.chat) throw new AgentSessionError(this.phase === 'closed' ? 'closed' : 'busy');
    if (this.chat.expiresAt <= this.now()) throw new AgentSessionError('expired');
    return this.chat;
  }
  async open(backendRef: string, conversationRef?: string) {
    if (this.phase !== 'closed') throw new AgentSessionError('busy');
    const generation = ++this.generation; this.phase = 'opening';
    let opened: Reply<'openChat'> | undefined;
    try {
      const backend = (await this.discover()).find(item => item.backendRef === backendRef);
      this.current(generation);
      if (!backend || backend.status !== 'supported' || backend.reason !== 'ready') throw new AgentSessionError('backend-unavailable');
      const selection = await this.client.selectTargets({}); this.current(generation);
      if (selection.expiresAt <= this.now()) throw new AgentSessionError('expired');
      opened = await this.client.openChat({backendRef, selectionHandle: selection.selectionHandle, ...(conversationRef ? {conversationRef} : {})});
      this.current(generation);
      if (opened.expiresAt <= this.now()) throw new AgentSessionError('expired');
      this.chat = opened; this.phase = 'ready';
      return {...opened};
    } catch (error) {
      if (opened) await this.client.closeChat({chatHandle:opened.chatHandle}).catch(() => {});
      if (generation === this.generation) { this.phase = 'closed'; this.chat = undefined; }
      throw error;
    }
  }
  async history() {
    const chat = this.ready(), generation = this.generation;
    const result = await this.client.history({chatHandle:chat.chatHandle}); this.current(generation);
    // Keep complete messages only. Never silently turn a clipped draft into runnable SQL.
    let total = 0;
    const items: typeof result.items = [];
    for (const item of result.items.slice(-30).reverse()) {
      if (bytes(item.text) > 8192 || total + bytes(item.text) > 65536) break;
      total += bytes(item.text); items.unshift({...item});
    }
    return {items, omitted: result.items.length - items.length};
  }
  async send(text: string, onEvent: (event: AgentEvent) => void): Promise<Extract<AgentEvent,{kind:'end'}>> {
    const chat = this.ready();
    if (!text.trim() || bytes(text) > 12000) throw new AgentSessionError('limit');
    const generation = ++this.generation; this.phase = 'sending';
    let turn: Reply<'send'> | undefined; let outputBytes = 0; let events = 0;
    try {
      turn = await this.client.send({chatHandle:chat.chatHandle,text}); this.current(generation);
      this.turn = turn;
      while (true) {
        if (turn.expiresAt <= this.now() || chat.expiresAt <= this.now()) throw new AgentSessionError('expired');
        const event = await this.client.read({turnHandle:turn.turnHandle}); this.current(generation);
        if (++events > 2048) throw new AgentSessionError('limit');
        // Any tool activity contradicts conversation-only integration. Stop immediately;
        // this detection cannot undo an action, so host manifest enforcement is required.
        if (event.kind === 'activity') throw new AgentSessionError('actions-forbidden');
        if (event.kind === 'text' && (outputBytes += bytes(event.text)) > 8192) throw new AgentSessionError('limit');
        onEvent(event);
        if (event.kind === 'end') return event;
      }
    } catch (error) {
      if (generation === this.generation) await this.close();
      throw error;
    } finally {
      if (turn) await this.client.stop({turnHandle:turn.turnHandle}).catch(() => {});
      if (generation === this.generation) { this.turn = undefined; this.phase = this.chat ? 'ready' : 'closed'; }
    }
  }
  /** Cancellation closes the chat too: a late pending send cannot race a new turn. */
  async stop() { await this.close(); }
  async close() {
    ++this.generation;
    const turn = this.turn, chat = this.chat;
    this.turn = undefined; this.chat = undefined; this.phase = 'closed';
    await Promise.all([
      turn ? this.client.stop({turnHandle:turn.turnHandle}).catch(() => {}) : undefined,
      chat ? this.client.closeChat({chatHandle:chat.chatHandle}).catch(() => {}) : undefined,
    ]);
  }
}
