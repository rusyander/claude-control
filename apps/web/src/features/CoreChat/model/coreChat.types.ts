import type { SessionStreamEvent } from '@agentdeck/contracts/core/session-stream';

/** Id переходника ядра (`claude`, `qwen`, `codex`, …): сверяется в рантайме ядром, не типом (P108). */
export type ChatCli = string;

export interface ChatStartDraft {
  project: string;
  cli: ChatCli;
  text: string;
  /** Id разговора этого CLI, который чат продолжает (`?resume=`); нет — новый разговор. */
  resume?: string;
}

/** Вызов инструмента и его результат (по `toolUseId`), как их показала модель. */
export interface ChatToolItem {
  toolUseId: string;
  name: string;
  input: unknown;
  /** `null` — результата ещё нет. */
  result: { isError: boolean } | null;
}

/** Одна строка ленты чата ядра. */
export type ChatItem =
  | { kind: 'human'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: ChatToolItem }
  | { kind: 'permission'; key: string; data: SessionStreamEvent['data'] }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'turn-end'; key: string; isError: boolean };

/** События одного сеанса в порядке показа. */
export interface SessionEvents {
  sessionId: string;
  events: SessionStreamEvent[];
  done: boolean;
}
