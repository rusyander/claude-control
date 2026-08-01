import type { spawn as nodeSpawn } from 'node:child_process';
import type { AssistantRunReason, AssistantRunResult, ModelInfo } from '@claude-control/contracts';
import type { OpencodeServe } from '../opencode-serve.ts';

/** Роль реплики в мультимодельном чате. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Причина итога запуска и сам результат описаны в контракте
 * (`packages/contracts/src/assistant-run.ts`) — сервер их переэкспортирует, чтобы
 * не держать вторую копию.
 */
export type { AssistantRunReason, AssistantRunResult };

/** Внедряемые зависимости (для тестов: без реальной сети и без реального spawn). */
export interface RunAssistantDeps {
  appDataDir: string;
  detect?: (command: string) => boolean;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof nodeSpawn;
  /** Таймаут CLI one-shot, мс (по умолчанию 180000). */
  timeoutMs?: number;
  /**
   * Каталог моделей провайдера (из кэша, без похода в сеть). Нужен ровно затем,
   * чтобы зашитая в код модель ассистента не устаревала молча: при совпадении
   * семейства берётся её актуальное поколение. Пусто — остаёмся на зашитой.
   */
  models?: ModelInfo[];
  /**
   * Идентификатор диалога панели. Нужен ровно сессионному режиму (IDEA-8): по
   * нему находится уже открытая сессия CLI. Не задан → сессионный режим не
   * пробуется вовсе, всё идёт one-shot как раньше.
   */
  conversationId?: string;
  /** Локальный сервер CLI (подменяется в тестах, чтобы ничего не запускалось). */
  sessionServe?: OpencodeServe;
  /** Сколько ждать готовности локального сервера CLI, мс. */
  serveReadyTimeoutMs?: number;
}

/** Исход one-shot запуска CLI до превращения в результат ассистента. */
export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}
