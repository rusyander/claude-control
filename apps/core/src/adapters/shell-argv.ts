/**
 * argv первой простой команды строки оболочки — типизированный факт для `exec` (06 §Session
 * permissions, P04): политика сравнивает префиксы argv, а не текст. Разбор в духе POSIX, как
 * у оболочки инструмента CLI: пробелы делят слова, `'…'` дословно, `"…"` и `\` снимают
 * экранирование. Обратная косая черта экранирует только пробел, кавычку, `$`, `` ` `` и саму
 * себя — иначе путь Windows (`C:\x`) остался бы без разделителей.
 *
 * Ведущие присваивания окружения (`A=1 git push`) — не команда и пропускаются. Разбор
 * кончается на первом управляющем знаке вне кавычек (`;`, `&`, `|`, перевод строки): argv —
 * только первой команды цепочки; остальные звенья стережёт правило запрета CLI (оверлей).
 */

const ESCAPABLE = new Set([' ', '\t', '"', "'", '\\', '$', '`']);
const CONTROL = new Set([';', '&', '|', '\n', '\r']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function commandArgv(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const end = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      const next = command[i + 1] as string;
      const escapes =
        quote === '"'
          ? next === '"' || next === '\\' || next === '$' || next === '`'
          : ESCAPABLE.has(next);
      if (escapes) {
        word += next;
        inWord = true;
        i += 1;
        continue;
      }
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (CONTROL.has(c)) break;
    if (c === ' ' || c === '\t') {
      end();
      continue;
    }
    word += c;
    inWord = true;
  }
  end();
  let start = 0;
  while (start < words.length && ASSIGNMENT.test(words[start] as string)) start += 1;
  return words.slice(start);
}
