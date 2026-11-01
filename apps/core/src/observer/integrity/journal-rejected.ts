import type { SignalVerdict } from '../observer.types.ts';

export const JOURNAL_REJECTED_SIGNAL = 'journal-rejected';

/** Сколько текста причин несёт сигнал: полный список лежит в `journal.rejected.jsonl`. */
const DETAIL_MAX = 500;

export interface JournalRejection {
  /** Вид отвергнутой строки (`(input)` — вход без вида). */
  kind: string;
  issues: readonly string[];
}

/**
 * Отвергнутая строка журнала (06:140, F11): писатель отказал строке по схеме и положил её в
 * `journal.rejected.jsonl` — в самом журнале строки нет, свёртке наблюдателя складывать нечего.
 * Поэтому это не предикат над строками, а вердикт по факту отказа: его выносит проводка
 * (`bootstrap/observer-wiring/integrity.ts`) из крючка писателя `onRejected`. `id` — уникальный
 * ключ отказа: отказы не схлопываются, перезапуск ядра чужой ключ не повторит.
 */
export function journalRejectedVerdict(rejection: JournalRejection, id: string): SignalVerdict {
  const issues = rejection.issues.join('; ');
  const detail = issues.length > DETAIL_MAX ? `${issues.slice(0, DETAIL_MAX)}…` : issues;
  return {
    fired: true,
    signal: JOURNAL_REJECTED_SIGNAL,
    subject: rejection.kind,
    detail,
    reasons: [
      `the journal writer refused a ${rejection.kind} line (${rejection.issues.length} issue(s)); it is in journal.rejected.jsonl`,
    ],
    key: `${JOURNAL_REJECTED_SIGNAL}:${id}`,
  };
}
