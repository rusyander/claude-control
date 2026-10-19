/**
 * Лимиты подписки Claude: загрузка окон, которую сервер Anthropic отдаёт самому
 * CLI (`GET /api/oauth/usage` под его OAuth-токеном — тот же ответ, что рисует
 * `/usage`). Панель зовёт его со своего сервера, токен в браузер не уходит.
 *
 * Точность — ровно та, что в ответе: сейчас сервер отдаёт целые проценты
 * (`utilization: 68.0`, `limits[].percent: 68`), и дробей к ним панель не
 * дописывает. Денег здесь нет намеренно: подписка Max, суммы в ответе
 * (`*_dollars`, `spend`, `extra_usage`) не переносятся.
 */

/** Окно: сессия (5 часов), неделя целиком, неделя одной модели. */
export type UsageLimitKind = 'session' | 'weekly' | 'weekly-model';

export interface UsageLimitWindow {
  /** `session`, `weekly` или `weekly:<модель>` — ключ строки в интерфейсе. */
  id: string;
  kind: UsageLimitKind;
  /** Имя модели у недельного окна модели — как его называет сервер («Opus»). */
  model?: string;
  /** Использовано, проценты 0..100 — с той точностью, что дал источник. */
  percent: number;
  /** Сброс окна, мс эпохи; `null` — сервер момента не назвал. */
  resetsAt: number | null;
  /** Это окно сейчас ограничивает (сервер `is_active`). */
  active?: boolean;
}

/**
 * Итог последней попытки:
 * - `ok` — ответ получен;
 * - `no-credentials` — входа CLI на этой машине нет;
 * - `api-key` — CLI работает по ключу API: лимитов подписки у него нет;
 * - `token-expired` — срок токена CLI истёк; CLI обновит его сам при запуске,
 *   панель токен не обновляет (обновление сменило бы токен и выбило бы вход CLI);
 * - `unauthorized` — сервер отказал токену (401/403);
 * - `rate-limited` — сервер просит подождать (429);
 * - `unavailable` — сеть, 5xx или ответ незнакомой формы.
 */
export type UsageLimitsStatus =
  | 'ok'
  | 'no-credentials'
  | 'api-key'
  | 'token-expired'
  | 'unauthorized'
  | 'rate-limited'
  | 'unavailable';

/** Откуда окна: ответ сервера Anthropic или последний замер из прогона чата. */
export type UsageLimitsSource = 'oauth' | 'chat-run';

export interface UsageLimits {
  status: UsageLimitsStatus;
  /** Последние известные окна; при неудачной попытке — прежние, с их `observedAt`. */
  windows: UsageLimitWindow[];
  /** Когда эти окна получены, мс эпохи; `null` — окон нет. */
  observedAt: number | null;
  source: UsageLimitsSource | null;
}
