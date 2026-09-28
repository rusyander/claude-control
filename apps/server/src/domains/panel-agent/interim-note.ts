const CYRILLIC = /[\u0400-\u04FF]/;
const LATIN = /[A-Za-z]/g;

/**
 * Рабочая заметка модели не на языке разговора: человек пишет по-русски, а
 * текст целиком латиницей («Need the rule id; list rules.»). Строка в промпте
 * держит язык лишь часть ходов, поэтому ход решает сам: такой текст перед
 * вызовом действия в ленту не идёт. Короткое (id, путь) — не заметка.
 */
export function isForeignInterimNote(text: string, userText: string): boolean {
  if (!CYRILLIC.test(userText) || CYRILLIC.test(text)) return false;
  return (text.match(LATIN)?.length ?? 0) >= 8;
}
