/**
 * Переменные, значение которых одно на всю команду: в тексте ровно одно
 * присваивание буквального значения и больше ни одного упоминания имени
 * словом (`read T`, `for T in`, `export T`, `T+=`, `${T:=…}` — уже нет).
 *
 * Тело функции обход судит вслепую: оно исполнится при вызове, с теми
 * значениями, что будут тогда. Но у такой переменной другого значения нет —
 * `T="node tools/tests-cli.mjs"; run() { $T run …; }` судится по `node`, а не
 * идёт человеку как «неизвестное имя» (ревью 23.10, зона A). Если присваивание
 * ещё не прошло к моменту суда тела, значения нет и в обходе — неизвестно.
 *
 * `eval`, `source`/`.`, `alias`, `trap`, `IFS`, ссылки `declare -n`/`${!x}`
 * меняют переменные мимо текста — тогда устойчивых нет.
 */
const UNTRACKABLE =
  /\beval\b|\bsource\b|(^|[;&|(\n{]|\b(then|do|else)\b)\s*\.\s|\b(declare|local|typeset)\s+-\w*n|\$\{!|\bIFS\b|\balias\b|\btrap\b|\bprintf\s+-v\b|\bmapfile\b|\breadarray\b/;
const LITERAL_ASSIGNMENT =
  /(?<![\w$])([A-Za-z_]\w*)=("[^"$`\\]*"|'[^']*'|[^\s;&|()<>$`'"\\]*)(?=[\s;&|)]|$)/g;

const escape = (name: string): string => name.replace(/[^\w]/g, '');

export function stableNames(command: string): Set<string> {
  const names = new Set<string>();
  if (UNTRACKABLE.test(command)) return names;
  for (const match of command.matchAll(LITERAL_ASSIGNMENT)) {
    const name = escape(match[1] as string);
    const mentions = command.match(new RegExp(String.raw`(?<![\w$\{])${name}(?!\w)`, 'g'));
    const defaulted = new RegExp(String.raw`\$\{${name}:?[=]`).test(command);
    if (mentions?.length === 1 && !defaulted) names.add(name);
  }
  return names;
}
