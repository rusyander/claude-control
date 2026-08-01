import type { MessageUsage } from '@claude-control/contracts';
import type { RunStatus } from './status';

export interface StreamedTool {
  name: string;
  input: string;
  /** Идентификатор вызова — по нему к нему приходит расход шага. */
  id?: string;
  /** Расход шага, породившего вызов; общий на все вызовы одного шага. */
  usage?: MessageUsage;
}

/** Запрос агента на разрешение инструмента — ждёт «Разрешить»/«Запретить». */
export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

/**
 * Сообщение, дописанное человеком, пока агент ещё занят. Уходит само, как только
 * текущий ход закончится, — тем же `--resume`, то есть в тот же разговор.
 *
 * Прервать чужой ход панель не может и не притворяется, что может: CLI в режиме
 * `-p` доводит ход до конца, и любое «мгновенное вмешательство» всё равно легло
 * бы в очередь — только внутри CLI и без права её увидеть или отменить. Здесь
 * очередь на виду: видно, что уйдёт следующим, и можно передумать.
 */
export interface QueuedMessage {
  /** Локальный id — чтобы удалить конкретное сообщение из очереди. */
  id: string;
  prompt: string;
  files?: { name: string; base64: string }[];
  allowEdits?: boolean;
  autoApprove?: boolean;
  model?: string;
  effort?: string;
}

export interface AgentRun {
  /** Стабильный id прогона — chatId, с которым он стартовал. */
  id: string;
  sessionId?: string;
  /** Каталог проекта — для группировки статусов (undefined = домашний чат). */
  projectPath?: string;
  status: RunStatus;
  text: string;
  thinking: string;
  tools: StreamedTool[];
  costUsd?: number;
  /** Токенов израсходовано в этом прогоне (input+output+cache). */
  tokens: number;
  /**
   * Расход шагов, не породивших ни одного вызова, — то есть цена самого текста
   * ответа. Складывается по шагам: текст в ленте склеивается в один блок, и
   * разложить его обратно по шагам нечем.
   */
  textUsage?: MessageUsage;
  limitResetsAt?: number;
  error?: string;
  /**
   * Структурный код отказа сервера (`run_busy`, `unsupported_upload`,
   * `workspace_missing`). По нему принимаются решения и подбирается текст на
   * языке интерфейса; сам `error` — только для показа, разбирать его нельзя.
   */
  errorCode?: string;
  /** Сервер (или сеть) сказал, что сбой временный, — можно перезапустить самим. */
  errorRetriable?: boolean;
  /**
   * Ключ, под которым прогон зарегистрирован НА СЕРВЕРЕ. Отличается от `id`,
   * когда разговор начался в другой вкладке под временным `new-…`, а эта знает
   * его по sessionId: по этому ключу идут и подключение к потоку, и остановка.
   */
  serverRunId?: string;
  /** В последнем ходе агент задал вопрос человеку (AskUserQuestion). */
  askedQuestion: boolean;
  /** Запросы на права, ждущие ответа человека (интерактивный permission-prompt). */
  permissions: PendingPermission[];
  /** Дописанное, пока агент занят: уйдёт по очереди, как только он освободится. */
  queued: QueuedMessage[];
  /** Последний отправленный запрос — для кнопки «Повторить». */
  lastPrompt?: string;
  /** Разрешались ли правки в прошлом запуске — для повтора с теми же правами. */
  allowEdits?: boolean;
  /** Было ли включено автоподтверждение прав — чтобы повтор шёл так же. */
  autoApprove?: boolean;
  /** Модель и глубина продумывания прошлого запуска — для повтора теми же. */
  model?: string;
  effort?: string;
  lastEventAt: number;
}

export interface StartInput {
  chatId: string;
  prompt: string;
  sessionId?: string;
  files?: { name: string; base64: string }[];
  allowEdits?: boolean;
  /** Каталог проекта: серверу — для нового чата, стору — для группировки. */
  projectPath?: string;
  /** Полный доступ (bypassPermissions) — для «Разрешить и продолжить». */
  fullAccess?: boolean;
  /**
   * Автоподтверждение безопасных запросов прав. Опасное (записи в git, удаление,
   * миграции) и всё под правилами `ask`/`deny` панель всё равно спросит.
   */
  autoApprove?: boolean;
  /** Модель для разговора (алиас/полное имя); пусто = по умолчанию. */
  model?: string;
  /** Глубина продумывания (--effort); пусто = по умолчанию. */
  effort?: string;
  /** Ветвление: правка своего сообщения не дописывает разговор, а создаёт ветку. */
  fork?: boolean;
}

export type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number }
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
      /** Вызовы, рождённые этим шагом; пусто — шаг закончился одним текстом. */
      toolIds?: string[];
    }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  // `retriable` ставит сервер: временный ли сбой, решает он, а не разбор текста.
  | { kind: 'error'; message: string; retriable?: boolean }
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' };

/**
 * Итог приёма отправки. Нужен вызывающему (полю ввода): текст сообщения можно
 * очищать только после того, как сервер его ПРИНЯЛ, иначе отказ уничтожает
 * набранное — человеку остаётся печатать заново.
 */
export type SendOutcome =
  { ok: true } | { ok: false; code?: string; message: string; files?: string[] };
