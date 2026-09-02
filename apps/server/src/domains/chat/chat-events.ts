import type { HandoffRefusal } from '@claude-control/contracts/chat-handoff';

/**
 * Словарь событий чата: что панель получает от CLI и что отдаёт интерфейсу.
 *
 * Живёт отдельно от самого прогона, потому что разбор потока разнесён по двум
 * модулям — `ChatRunner` (запуск и перевод строк в события) и `stream-usage`
 * (расход по ходам модели). Общие типы в одном из них сделали бы их
 * взаимозависимыми, а слои сервера циклов не допускают.
 */

/** Событие для интерфейса — уже разобранное, без служебного шума CLI. */
export type ChatEvent =
  | {
      kind: 'session';
      sessionId: string;
      model: string;
      tools: number;
      /** Когда реестр завёл прогон — по часам сервера, тем же, что пишут транскрипт. */
      startedAt?: number;
    }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  /**
   * Расход одного шага модели. `toolIds` — вызовы, рождённые ЭТИМ шагом: по ним
   * интерфейс ставит цифру у конкретного действия. Вызовов бывает несколько
   * (модель зовёт инструменты параллельно одним сообщением) — тогда расход у них
   * общий, и делить его между ними нельзя: раздельного счёта модель не даёт.
   */
  | {
      kind: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      cacheCreation1h?: number;
      model?: string;
      /** Пусто — шаг закончился одним текстом, привязывать расход не к чему. */
      toolIds?: string[];
      /** Оценка стоимости шага; проставляет реестр — тарифы знает только он. */
      costUsd?: number;
      /**
       * Остаток сверки с итогом прогона (`result.usage`): расход, который не
       * покрыли ходы, — субагенты, ходы без потоковых событий. Это не шаг
       * модели: к действию его не привязать, размер окна по нему не судить.
       */
      remainder?: boolean;
    }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string }
  // Интерактивные права: агент хочет применить инструмент — ждём решения человека.
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' }
  /**
   * Работа продолжена в чистой сессии (или не продолжена — тогда есть `reason`).
   * Событие уходит в поток ЗАКРЫВАЕМОГО прогона последним: по нему вкладка
   * переключается на новый разговор, а не остаётся смотреть на завершённый.
   */
  | {
      kind: 'handoff';
      chatId?: string;
      path?: string;
      chainDepth?: number;
      reason?: HandoffRefusal;
      /**
       * Окно, из-за размера которого зашла речь о продолжении. Есть только у
       * повода по порогу: у предложения агента причина смысловая, и число тут
       * сбивало бы с толку.
       */
      contextTokens?: number;
    };

/** Счётчики расхода в том виде, в каком их пишет CLI (и модель). */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Разбивка записи в кэш по сроку жизни: часовая стоит вдвое дороже. */
  cache_creation?: { ephemeral_1h_input_tokens?: number };
}

/**
 * Строка потока `stream-json` — только те поля, которые панель читает.
 * Экспортируется ради трекера ходов (`stream-usage.ts`) и тестов разбора.
 */
export interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: unknown[];
  message?: {
    /** Ход модели: у всех строк одного хода `id` общий. */
    id?: string;
    /** Модель ЭТОГО шага: в разговоре они чередуются (переключение, субагенты). */
    model?: string;
    content?: { type: string; text?: string; name?: string; input?: unknown; id?: string }[];
    /** В `assistant` это заглушка из `message_start` — полный расход в `message_delta`. */
    usage?: RawUsage;
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
    /** `message_start`: модель и id хода, стартовые счётчики. */
    message?: { id?: string; model?: string; usage?: RawUsage };
    /** `message_delta`: полный расход хода. */
    usage?: RawUsage;
    /** `content_block_start`: какой блок начался. */
    content_block?: { type?: string };
  };
  /** Заполнен у строк субагента: ход принадлежит вложенному прогону, не этому. */
  parent_tool_use_id?: string | null;
  rate_limit_info?: { resetsAt?: number; rateLimitType?: string; status?: string };
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
  /** `result`: итог прогона — по нему сверяется сумма ходов. */
  usage?: RawUsage;
  modelUsage?: Record<string, unknown>;
  hook_name?: string;
}
