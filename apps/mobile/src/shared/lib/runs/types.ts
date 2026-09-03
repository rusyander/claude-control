import type { MessageUsage } from '@claude-control/contracts';
import type { HandoffRefusal } from '@claude-control/contracts/chat-handoff';

/**
 * Модель прогона — та же, что в панели: события потока одни и те же, и
 * расхождение здесь означало бы, что телефон показывает не то, что браузер.
 */

export interface StreamedTool {
  name: string;
  input: string;
  id?: string;
  usage?: MessageUsage;
}

/** Запрос агента на разрешение инструмента — ждёт ответа человека. */
export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

/** Вложение: сервер ждёт имя и base64, размер ограничен телом запроса. */
export interface Upload {
  name: string;
  base64: string;
}

/** Дописанное, пока агент занят: уйдёт, как только он освободится. */
export interface QueuedMessage {
  id: string;
  prompt: string;
  allowEdits?: boolean;
  autoApprove?: boolean;
  model?: string;
  effort?: string;
  files?: Upload[];
}

export type RunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';

export interface AgentRun {
  id: string;
  sessionId?: string;
  projectPath?: string;
  status: RunStatus;
  text: string;
  thinking: string;
  tools: StreamedTool[];
  costUsd?: number;
  tokens: number;
  textUsage?: MessageUsage;
  limitResetsAt?: number;
  error?: string;
  errorCode?: string;
  errorRetriable?: boolean;
  /** Ключ прогона НА СЕРВЕРЕ — отличается от id, если чат начали в другом месте. */
  serverRunId?: string;
  askedQuestion: boolean;
  permissions: PendingPermission[];
  queued: QueuedMessage[];
  lastPrompt?: string;
  allowEdits?: boolean;
  autoApprove?: boolean;
  model?: string;
  effort?: string;
  lastEventAt: number;
  /**
   * Когда сервер завёл прогон, по его часам. По нему опрос `/chat/active`
   * отличает НОВЫЙ ход в том же разговоре от только что законченного, который
   * сервер ещё минуту держит в списке для догона.
   */
  startedAt?: number;
  /** Разговор, в котором работа продолжена чистой сессией: экран уходит в него. */
  handoffTo?: string;
}

export interface StartInput {
  chatId: string;
  prompt: string;
  sessionId?: string;
  allowEdits?: boolean;
  projectPath?: string;
  autoApprove?: boolean;
  model?: string;
  effort?: string;
  files?: Upload[];
}

export type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number; startedAt?: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | {
      kind: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      cacheCreation1h?: number;
      model?: string;
      costUsd?: number;
      toolIds?: string[];
      /** Остаток сверки с итогом прогона — в счётчик, но не к действию. */
      remainder?: boolean;
    }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string; retriable?: boolean }
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' }
  /**
   * Работа продолжена в чистой сессии (или не продолжена — тогда есть `reason`).
   * Приходит последним кадром закрываемого прогона; по `chatId` экран уходит в
   * новый разговор, а не остаётся смотреть на завершённый — как вкладка панели.
   */
  | {
      kind: 'handoff';
      chatId?: string;
      path?: string;
      chainDepth?: number;
      reason?: HandoffRefusal;
      contextTokens?: number;
    };

/** Итог приёма отправки: поле ввода очищается только после `ok`. */
export type SendOutcome = { ok: true } | { ok: false; code?: string; message: string };

export const EMPTY_RUN: AgentRun = {
  id: '',
  status: 'idle',
  text: '',
  thinking: '',
  tools: [],
  tokens: 0,
  askedQuestion: false,
  permissions: [],
  queued: [],
  lastEventAt: 0,
};
