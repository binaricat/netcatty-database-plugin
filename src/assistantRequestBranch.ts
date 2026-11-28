import type { AssistantExchange, Task } from './domain';

/** Panel-local snapshot. Retrying cannot silently capture newer editor/schema data. */
export interface AssistantRequestSnapshot {
  readonly prompt: string;
  readonly request: string;
  readonly task: Task;
  readonly history: readonly AssistantExchange[];
}
export class AssistantRequestBranch {
  private last: AssistantRequestSnapshot | null = null;
  private revision = 0;
  capture(prompt: string, request: string, task: Task, history: readonly AssistantExchange[]): AssistantRequestSnapshot {
    this.last = Object.freeze({ prompt, request: request.slice(0, 1500), task,
      history: Object.freeze(history.slice(-3).map(turn => Object.freeze({ ...turn }))) });
    return this.last;
  }
  get snapshot(): AssistantRequestSnapshot | null { return this.last; }
  begin(): number { return ++this.revision; }
  invalidate(): void { this.revision++; }
  current(revision: number): boolean { return this.revision === revision; }
  complete(revision: number, snapshot: AssistantRequestSnapshot, draft: string): AssistantExchange[] | null {
    if (!this.current(revision) || snapshot !== this.last) return null;
    return [...snapshot.history, { request: snapshot.request, draft }].slice(-3);
  }
  clear(): void { this.invalidate(); this.last = null; }
}
