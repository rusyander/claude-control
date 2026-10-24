import type { Word } from './shell-parse.ts';

/**
 * Развёртка псевдонима текстом, как её делает Bash (повторная проверка 24.10).
 * Псевдоним — подстановка текста: `alias gpl='git push 2>/dev/null'` и `gpl
 * origin main --force` — это `git push 2>/dev/null origin main --force`, а
 * `alias gfp='git fetch && git push'` отдаёт слова после имени последнему
 * звену. Раньше такая развёртка судилась без слов вызова, и пуш в main шёл
 * сам. Значение, кончающееся пробелом (`alias s='sudo '`), раскрывает
 * псевдоним и в следующем слове: `s gp origin HEAD:main` — это `sudo git
 * push …`.
 */

/** Значение подстановки здесь неизвестно — переменная, которой нет. */
const UNKNOWN_ARG = '"${__alias_arg}"';

/** Слово вызова обратно в текст: известное — в одинарных кавычках, подстановка — неизвестным. */
function wordText(word: Word): string[] {
  if (word.fed !== undefined) return [`<(${word.fed})`];
  return (word.alternatives ?? [word]).map((one) =>
    one.dynamic ? UNKNOWN_ARG : `'${one.text.replace(/'/g, `'\\''`)}'`,
  );
}

/** Следующее слово раскроется псевдонимом: значение кончается пробелом (`man bash`, ALIASES). */
export function chainsAlias(
  value: string,
  next: Word | undefined,
  aliases: Readonly<Record<string, string>>,
): boolean {
  return (
    /[ \t]$/.test(value) && next !== undefined && !next.dynamic && Object.hasOwn(aliases, next.text)
  );
}

/** Сценарий, который исполнит оболочка: значение, цепочка псевдонимов и слова вызова. */
export function aliasScript(
  value: string,
  rest: Word[],
  aliases: Readonly<Record<string, string>>,
  expanding: ReadonlySet<string>,
): string {
  const seen = new Set(expanding);
  let text = value;
  let at = 0;
  while (chainsAlias(text, rest[at], aliases) && !seen.has((rest[at] as Word).text)) {
    const name = (rest[at] as Word).text;
    seen.add(name);
    text += aliases[name] as string;
    at += 1;
  }
  return [text, ...rest.slice(at).flatMap(wordText)].join(' ');
}

/**
 * Тело функции снимка оболочки, вызов которой решает человек при любых словах
 * вызова (повторная проверка 24.10, d): git, удаление и перенос файлов,
 * погашение процессов, обёртки оболочки и исполнение текста, клиенты баз,
 * контейнеры, фордж и сеть. Подставить слова вызова в `"$@"` тела надёжно разбор
 * не умеет — такое тело идёт человеку целиком. Слово целиком: `__git_ps1` — не git.
 */
const RISKY_WORD =
  /(^|[^\w.-])(git|git\.exe|rm|rmdir|rd|del|erase|unlink|shred|truncate|dd|mv|kill|pkill|killall|taskkill|fuser|stop-process|remove-item|sudo|doas|eval|exec|source|xargs|find|sh|bash|zsh|dash|ksh|mksh|pwsh|powershell|cmd|psql|mysql|sqlite3|mongosh|redis-cli|dropdb|docker|kubectl|gh|glab|curl|wget|ssh|scp|rsync)(?![\w-])/i;
/** `. файл` — исполнить чужой файл в этой оболочке. */
const DOT_SOURCE = /(^|[\n;&|({]\s*)\.\s+\S/;

export function riskyFunctionBody(body: string): boolean {
  return RISKY_WORD.test(body) || DOT_SOURCE.test(body);
}
