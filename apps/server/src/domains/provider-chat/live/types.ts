import type { spawn as nodeSpawn } from 'node:child_process';

/**
 * Живой ход чужого CLI (В1): CLI запущен в своём серверном режиме на ОДИН ответ,
 * и сообщение, написанное посреди ответа, уходит в этот же ход.
 *
 * Сессии у чужого CLI по-прежнему нет: процесс живёт ровно один ответ, переписку
 * собирает панель — как у одиночного запуска. Серверный режим взят только ради
 * входа посреди хода, которого у запуска «вопрос в argv» нет вовсе.
 */
export interface LiveTurnOptions {
  /** Чем запускать CLI — найденный путь или имя из каталога. */
  readonly command: string;
  /** Вся переписка одним текстом — тот же промпт, что ушёл бы одиночному запуску. */
  readonly prompt: string;
  readonly workdir?: string;
  /** Переменные этого прогона (маршрут контура, набор панели) — побеждают канон. */
  readonly env?: Record<string, string>;
  readonly portableEnv?: () => Record<string, string>;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs: number;
  readonly spawnImpl?: typeof nodeSpawn;
  readonly fetchImpl?: typeof fetch;
  /**
   * Права хода. Нет поля — как у неинтерактивного запуска: просьба о разрешении
   * получает отказ. Молча «да» не даёт ни одна ветка без `allowEdits`.
   */
  readonly permission?: LivePermissionPolicy;
}

/** Что CLI просит разрешить — ровно то, что пришло по проводу, без догадок. */
export interface LivePermissionAsk {
  /** Чей вопрос: `qwen` | `goose` | `kimi`. */
  readonly cli: string;
  /** id просьбы у самого CLI. */
  readonly requestId: string;
  /** Имя инструмента, если CLI его назвал. */
  readonly tool?: string;
  /** Короткое описание действия, если CLI его дал. */
  readonly title?: string;
}

export interface LivePermissionPolicy {
  /** Переключатель «Разрешить правки» чата: включён — CLI правит без вопроса. */
  readonly allowEdits: boolean;
  /** Вопрос человеку; без него при выключенных правках — отказ. */
  readonly ask?: (request: LivePermissionAsk) => Promise<'allow' | 'deny'>;
}

/**
 * Итог хода. `unavailable` — серверный режим не поднялся (старая версия CLI, нет
 * подкоманды, не та форма ответа): вызывающий молча идёт одиночным запуском, и
 * человек получает ответ так же, как получал до В1.
 */
export type LiveTurnResult =
  | { readonly kind: 'done'; readonly reply: string }
  | { readonly kind: 'error'; readonly error: string }
  | { readonly kind: 'unavailable'; readonly why: string };

export interface LiveTurn {
  /**
   * `onSteerable` — ход начат, и с этой минуты `steer` его достаёт: панель
   * говорит человеку «уйдёт в этот же ход», а не «по концу ответа».
   */
  run(
    options: LiveTurnOptions,
    onDelta: (text: string) => void,
    onSteerable?: () => void,
  ): Promise<LiveTurnResult>;
  /**
   * Сообщение в идущий ход. `false` — ход его не принял (кончился, ещё не начат,
   * CLI отказал): сообщение встаёт в очередь панели, как и раньше.
   */
  steer(text: string): Promise<boolean>;
  stop(): void;
}
