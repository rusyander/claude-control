import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import { coreRefusalOf, type CoreRefusal } from './refusal';

/**
 * Отказ запроса к ядру через прокладку — ОДИН разбор на все экраны ядра (лента, отчёт, вопрос,
 * запуск): прокладка без ядра, задача не создана (422 с проблемами), суд полномочий (401/403 с
 * кодом ядра), разбор (400 с путями), конфликт (409), сеть, прочее. Каждый вид несёт код ответа
 * (`status`, `null` — ответа не было): экран, который судит по коду (501 у чтений — «ещё не
 * отдаётся»), и проверка, сверяющая код на экране с кодом ядра, читают одно и то же.
 */
export type CoreFailure =
  | { kind: 'refusal'; status: number | null; code: CoreRefusal }
  | { kind: 'task-refused'; status: number; problems: string[] }
  | { kind: 'authority'; status: number; code: string; reason: string }
  | { kind: 'invalid'; status: number; issues: { path: string; message: string }[] }
  | { kind: 'rejected'; status: null; code: string; reason: string }
  | { kind: 'conflict'; status: number; code: string; reason: string }
  | { kind: 'network'; status: null; message: string }
  | { kind: 'other'; status: number | null; code: string; message: string };

interface ApiBody {
  error?: unknown;
  code?: unknown;
  problems?: unknown;
  issues?: unknown;
  reason?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function failureOf(error: unknown): CoreFailure {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const status = typeof response?.status === 'number' ? response.status : null;
  const refusal = coreRefusalOf(error);
  if (refusal) return { kind: 'refusal', status, code: refusal };
  // Ответа нет вовсе — сеть или обрыв: дошёл ли запрос до ядра, неизвестно, повтор — тем же ключом.
  if (!response) {
    return { kind: 'network', status: null, message: error instanceof Error ? error.message : '' };
  }
  const body = (
    typeof response.data === 'object' && response.data !== null ? response.data : {}
  ) as ApiBody;
  const code = str(body.code);
  const reason = str(body.reason) || str(body.error);
  if (status === 422 && Array.isArray(body.problems))
    return { kind: 'task-refused', status, problems: body.problems.map(String) };
  if (status === 401 || status === 403)
    return { kind: 'authority', status, code: code || 'forbidden', reason };
  if (status === 400 && Array.isArray(body.issues)) {
    return {
      kind: 'invalid',
      status,
      issues: body.issues.map((i: { path?: unknown; message?: unknown }) => ({
        path: str(i.path),
        message: str(i.message),
      })),
    };
  }
  if (status === 409) return { kind: 'conflict', status, code, reason };
  return {
    kind: 'other',
    status,
    code,
    message: reason || code || (error instanceof Error ? error.message : String(error)),
  };
}

/** Исход команды: `rejected` — отказ ядра с кодом и причиной; применена — отказа нет. */
export function failureOfOutcome(outcome: CommandOutcome): CoreFailure | null {
  if (outcome.status === 'applied') return null;
  return {
    kind: 'rejected',
    status: null,
    code: outcome.code ?? 'rejected',
    reason: outcome.reason ?? '',
  };
}

const withCode = (code: string, reason: string): string =>
  code && reason ? `${code}: ${reason}` : reason || code;

/**
 * Причина одной строкой, словами ядра или прокладки (P32: экран переводит только свои слова) —
 * для подписи под строкой ленты, карточкой отчёта и вопроса.
 */
export function failureReason(failure: CoreFailure): string {
  switch (failure.kind) {
    case 'refusal':
      return failure.code;
    case 'task-refused':
      return failure.problems.join('; ');
    case 'invalid':
      return failure.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    case 'network':
      return failure.message;
    case 'other':
      return withCode(failure.message === failure.code ? '' : failure.code, failure.message);
    default:
      return withCode(failure.code, failure.reason);
  }
}
