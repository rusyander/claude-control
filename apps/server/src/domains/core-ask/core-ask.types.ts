import type { AskFields, AskSession } from '@agentdeck/contracts/core/ask';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import type { AgentImage } from '../../lib/agent-images/agent-images.ts';

/** Ответ ядра на просьбу: задача хода или отказ с кодом ядра (журналированный у него). */
export type CoreAskStarted =
  { ok: true; taskId: string } | { ok: false; status: number; code: string; message: string };

/** Всё, что вопросу нужно от ядра; тесты подменяют его заглушкой, жизнь — `createCoreAskPort`. */
export interface CoreAskPort {
  /** `env` — значения имён `fields.session.env` (G13): в теле вне полей, в журнал ядра не ложатся. */
  ask(fields: AskFields, env?: Readonly<Record<string, string>>): Promise<CoreAskStarted>;
  task(taskId: string): Promise<TaskView>;
  pages(taskId: string, sessionId: string, signal: AbortSignal): AsyncIterable<SessionStreamPage>;
  cancel(taskId: string): Promise<void>;
}

/** События хода — словарь окна агента без `start` (его шлёт маршрут, он знает разговор). */
export type CoreAskEvent = Exclude<PanelAgentRunEvent, { kind: 'start' }>;

export interface CoreAskOutcome {
  ok: boolean;
  /** Весь текст модели за ход (склейка `assistant-text`). */
  reply: string;
  error?: string;
  code?: string;
  /** Действия панели, вызванные за ход (`<имя>` или `<имя> (failed)`). */
  actions: string[];
}

export interface CoreAskRun {
  done: Promise<CoreAskOutcome>;
  taskId: () => string | undefined;
  stop: () => void;
}

/** Реплика служебного вопроса (ассистент, группы, проверка провайдера): текст и картинки. */
export interface OneShotMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Картинки реплики человека — едут в вопрос ядру блоками `image` (берутся у последней). */
  images?: readonly AgentImage[];
}

export interface OneShotRequest {
  /** Заголовок задачи ядра: по нему ход виден в ленте ядра. */
  title: string;
  messages: readonly OneShotMessage[];
  system?: string;
  /** Потолок модели хода (дешёвая ступень групп); нет — модель профиля или CLI. */
  model?: string;
  /**
   * Названный CLI вместо активного (проверка провайдера): ход идёт набором запуска ядра для него,
   * без профиля «Ассистент панели» — проверяется сам CLI, а не выбранный адрес.
   */
  adapter?: string;
  /** Потолок ожидания ответа, мс; вышел — ход снимается командой ядру `cancel`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Набор панели чужому CLI (G13): только окна помощника формы и структуры — им прежнее окно
   * давало `route.kit.env` (HEAD `assistant-route.ts`). Claude, агент панели, группы и проверка
   * провайдера набора не получали и не получают.
   */
  carry?: AskCarry;
}

/** Набор вопроса: поля сеанса `ask` и значения их переменных; отказ — причина человеку дословно. */
export type AskCarryOutcome =
  { ok: true; session?: AskSession; env?: Record<string, string> } | { ok: false; reason: string };

/** Кто собирает набор для CLI вопроса и маршрутов хода (`helper-carry.ts`). */
export type AskCarry = (input: {
  cli: string;
  routes: AskFields['routes'] | undefined;
}) => AskCarryOutcome;

/** Исход служебного вопроса: ответ модели или отказ с кодом текста панели и причиной. */
export type OneShotResult =
  | { ok: true; providerId: string; reply: string }
  | {
      ok: false;
      providerId: string;
      /** `unsupported` — CLI без судьи ядра (отказ панели до ядра); иначе — исход хода. */
      reason: 'unsupported' | 'refused' | 'failed';
      error: string;
      messageCode?: ServerMessageCode;
      params?: ServerMessageParams;
    };
