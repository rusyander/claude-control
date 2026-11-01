import { PUBLISH_COMMANDS } from './publish-commands.ts';

/**
 * Алиасы git, которые публикуют, и адрес-заглушка закрытой копии (05 §Push closure). Один модуль
 * для того, кто пишет закрытие (`publisher/closure`), и того, кто сверяет дрейф
 * (`observer/forged-publish`): части не импортируют друг друга (depcruise core-parts-apart).
 */

/**
 * Адрес push, которого нет: схема, которой у git нет помощника, — push падает до сети. Пишется
 * покопийным `remote.<r>.pushurl` каждого удалённого.
 */
export const CLOSED_PUSH_URL = 'agentdeck-closed://push-refused';

/** Разделители оболочки в алиасе `!…`: команды после них — новые argv. */
const SHELL_BREAKS = new Set([';', '&', '|', '(', ')', '{', '}', '`', '"', "'", '\n']);

function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  const flush = () => {
    if (word !== '') words.push(word);
    word = '';
  };
  for (const c of text) {
    if (SHELL_BREAKS.has(c)) {
      flush();
      words.push(';');
    } else if (c === ' ' || c === '\t' || c === '\r') flush();
    else word += c;
  }
  flush();
  return words;
}

/**
 * Имя программы без каталога и расширения: `/usr/bin/git` и `git.exe` — тот же git. Расширение
 * снимается любое: суффиксы ОС знает только platform/ (P51), а lib/ — лист и туда не ходит.
 */
function tool(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Глобальные ключи git перед подкомандой: `-c k=v`, `-C dir` берут значение следующим словом. */
function skipGitOptions(words: readonly string[], at: number): number {
  let i = at;
  while (i < words.length && words[i]!.startsWith('-')) {
    i += words[i] === '-c' || words[i] === '-C' ? 2 : 1;
  }
  return i;
}

/** argv (с программой первым словом) начинается формой публикации из общего списка. */
function startsWithPublish(words: readonly string[], at: number): boolean {
  const program = tool(words[at] ?? '');
  return PUBLISH_COMMANDS.some((form) => {
    if (form[0] !== program) return false;
    const from = program === 'git' ? skipGitOptions(words, at + 1) : at + 1;
    return form.slice(1).every((part, k) => words[from + k] === part);
  });
}

/**
 * Значение алиаса git публикует: `push …` (и равные из `PUBLISH_COMMANDS`), `!git push`,
 * `!f() { gh pr create; }; f`. Цепочка алиасов (`p = pp`, `pp = push`) разворачивается по `all`.
 */
export function aliasPublishes(
  value: string,
  all: Readonly<Record<string, string>> = {},
  depth = 0,
): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('!')) {
    const words = shellWords(trimmed.slice(1));
    return words.some((_, i) => startsWithPublish(words, i));
  }
  const words = ['git', ...shellWords(trimmed)];
  if (startsWithPublish(words, 0)) return true;
  const next = all[words[1] ?? ''];
  return next !== undefined && depth < 10 && aliasPublishes(next, all, depth + 1);
}
