/**
 * Факт внешнего мира (01 §Facts, F25): значение, «нет» или «неизвестно с причиной». Любое
 * исключение и таймаут — `unknown`, никогда `absent`: «не смог прочитать» и «прочитал — нет»
 * ведут к разным решениям (P44).
 */
export type Fact<T> = { value: T } | { absent: true } | { unknown: string };

/** Что делает решение, если вход `unknown` (01 §Facts): никогда «пропустить» и никогда «нет». */
export const UNKNOWN_ACTIONS = ['run', 'ask', 'refuse', 'retry-until'] as const;
export type UnknownAction = (typeof UNKNOWN_ACTIONS)[number];

export interface ReadClassDef {
  name: string;
  /** Свой таймаут у каждого класса — не общий с быстрой пробой «изменилось ли». */
  timeoutMs: number;
  onUnknown: UnknownAction;
  /** Для `retry-until`: сколько повторять до точки человека. */
  retryUntilMs?: number;
  /** Пока класс — заглушка будущей фазы, она названа. */
  stubUntilPhase?: number;
}

export function factKind<T>(fact: Fact<T>): 'value' | 'absent' | 'unknown' {
  if ('value' in fact) return 'value';
  if ('absent' in fact) return 'absent';
  return 'unknown';
}
