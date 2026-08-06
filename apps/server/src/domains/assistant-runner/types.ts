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

/**
 * Свой эндпоинт для ассистента САМОЙ панели: адрес вместо облака вендора.
 *
 * Приходит из настроек (`assistantEndpointId` → профиль), а не из окружения
 * процесса, как раньше. Задан → раннер идёт прямым вызовом API по ЭТОМУ виду
 * API и ЭТОМУ адресу, минуя резолв «CLI или ключ»: пользователь выбрал, куда
 * уходят его данные, и подписочный CLI отправил бы их в облако вопреки выбору.
 */
export interface AssistantEndpoint {
  baseUrl: string;
  apiKind: 'anthropic' | 'google' | 'openai-compat';
  /** Имя модели на этом адресе; пусто — зашитый в код минимум. */
  model: string;
  /** Токен эндпоинта; пусто — запрос уходит без авторизации (локальная модель). */
  token?: string;
}

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
  /**
   * Свой эндпоинт ассистента панели. Не задан → всё как раньше: облако вендора
   * и обычный порядок «CLI → ключ → отказ».
   */
  endpoint?: AssistantEndpoint;
}

/** Исход one-shot запуска CLI до превращения в результат ассистента. */
export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}
