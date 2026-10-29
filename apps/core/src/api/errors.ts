/**
 * Коды ответов API ядра (07 §API). Тело ошибки одно на всех: `{error, code, …}` — код машинный,
 * `error` читает человек в панели. Отказ команды записан в журнал до ответа (01 §Commands).
 */

const COMMAND_STATUS: Record<string, number> = {
  'forged-authority': 403,
  'proof-required': 403,
  'nonce-invalid': 403,
  'signature-invalid': 403,
  'signature-required': 403,
  'stale-seq': 409,
  'cmd-id-reused': 409,
  'state-conflict': 409,
  // `release-resource` (G25): нет такого ресурса — 404; уже снят и прочитан назад — 409 с
  // состоянием; вид снимается своей дорогой (аренда, сессия) — запрос понятен, но не исполним.
  'no-such-resource': 404,
  'already-released': 409,
  'not-releasable': 422,
  'not-implemented': 501,
};

export function commandStatus(code: string | undefined): number {
  if (code === undefined) return 200;
  return COMMAND_STATUS[code] ?? 422;
}

export interface ApiError {
  error: string;
  code: string;
  [extra: string]: unknown;
}

export function apiError(
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): ApiError {
  return { error, code, ...extra };
}
