/**
 * Журнал проверок: прогон гейта или теста на том же содержимом дерева
 * повторяется из записи вместо нового прогона. Сводка — для плитки панели;
 * пока журнал в тени, плитка показывает, сколько он сэкономил бы и расходился
 * ли хоть раз с настоящим прогоном.
 */

/** Строка ленты `events.jsonl`, которую пишет preload журнала. */
export interface LedgerEvent {
  at: number;
  kind: 'record' | 'miss' | 'would-skip' | 'shadow-ok' | 'mismatch' | 'hit' | 'off';
  check?: string;
  repo?: string;
  reason?: string;
  savedMs?: number;
  exit?: number;
  recordedExit?: number;
  ms?: number;
}

export interface LedgerSummary {
  /** Preload установлен и прошёл самопроверку — панель подмешивает его запускам. */
  active: boolean;
  /** Почему не активен (самопроверка, выключатель). */
  reason: string | null;
  version: string | null;
  /** shadow — только замер; on — повторы; off — записи без повторов; disabled — журнала нет. */
  mode: 'shadow' | 'on' | 'off' | 'disabled';
  windowDays: number;
  records: number;
  wouldSkip: number;
  hits: number;
  /** Тень повторила бы прогон, а настоящий прогон кончился иначе. Должно быть 0. */
  mismatches: number;
  savedMs: number;
  repos: number;
  offReasons: Record<string, number>;
  /** Под какими CLI preload реально загружался (пульс). */
  seen: Array<{ cli: string; at: number }>;
}
