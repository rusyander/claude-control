import type { SignalVerdict } from './observer.types.ts';

export const ROUTE_MISMATCH_SIGNAL = 'route-mismatch';

export interface RouteMismatchInput {
  sessionId: string;
  routeId: string;
  /** Модель, которую сеанс просил (`null` — модель по умолчанию CLI: сравнивать не с чем). */
  modelAsked: string | null;
  /** Модель, которую назвал маршрут в первом ходе сеанса. */
  modelServed: string;
}

/**
 * То же имя, что просили: точное совпадение, датированный снимок псевдонима (`gpt-4o` →
 * `gpt-4o-2024-08-06`, `claude-x` → `claude-x-20250929`) или префикс поставщика у шлюза
 * (`anthropic/claude-x`). Иначе вендор отдал другую модель, чем закреплено за сеансом.
 */
function sameModel(asked: string, served: string): boolean {
  const a = asked.toLowerCase();
  const s = served.toLowerCase();
  if (s === a) return true;
  const bare = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  if (bare === a) return true;
  return bare.startsWith(`${a}-`) && isSnapshotDate(bare.slice(a.length + 1));
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Дата снимка — `YYYYMMDD` или `YYYY-MM-DD`; разбор посимвольный (P32: без regex в судье). */
function isSnapshotDate(tail: string): boolean {
  if (tail.length === 8) return [...tail].every(isDigit);
  if (tail.length !== 10) return false;
  return [...tail].every((c, i) => (i === 4 || i === 7 ? c === '-' : isDigit(c)));
}

/**
 * P119, первая половина: маршрут сеанса закреплён, модель, которую он назвал, ≠ просимой →
 * вердикт `route-mismatch`. Серьёзность и действие выносит `judgeSignal` по каталогу (`warn` +
 * `show`: сеанс не снимается — ложное срабатывание на имени модели уронило бы задачу, а подмена
 * видна человеку строкой журнала и решением). Ключ — сеанс: подмена пишется раз на сеанс.
 */
export function routeMismatchVerdict(input: RouteMismatchInput): SignalVerdict {
  const signal = ROUTE_MISMATCH_SIGNAL;
  if (input.modelAsked === null)
    return {
      fired: false,
      signal,
      reasons: [`asked: CLI default, served ${input.modelServed}: nothing pinned to compare`],
    };
  if (sameModel(input.modelAsked, input.modelServed))
    return {
      fired: false,
      signal,
      reasons: [`served ${input.modelServed} is the asked ${input.modelAsked}`],
    };
  return {
    fired: true,
    signal,
    subject: input.sessionId,
    detail: `route ${input.routeId}: asked ${input.modelAsked}, served ${input.modelServed}`,
    reasons: [
      `model served ${input.modelServed} ≠ asked ${input.modelAsked} on the pinned route ${input.routeId}`,
    ],
    key: `${signal}:${input.sessionId}`,
    sessionId: input.sessionId,
  };
}
