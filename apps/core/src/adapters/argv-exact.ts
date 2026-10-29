/**
 * Строка, чей argv разбор (`shell-argv.ts`) берёт дословно (core-s2 F-02). Bash снимает `\`,
 * раскрывает `$…`, `` `…` ``, шаблоны, скобки и перенаправления — разбор этого не повторяет
 * (`gi\t push` = `git push`), поэтому такая строка помечается неточной, а судья ей не верит.
 * PowerShell экранирует обратной кавычкой, раскрывает `$`/`@` и в кавычках — точен только текст без
 * них; `\` у него — просто разделитель пути. Оболочка системы (Qwen: cmd на Windows, sh иначе) —
 * знаки Bash и ещё `^` (экран cmd) и `%` (переменная cmd). Разделители цепочки (`;`, `|`, `&&`,
 * перевод строки) точности не портят: argv — первой команды, остальное стережёт судья по строке.
 */

export type ShellDialect = 'bash' | 'powershell' | 'system';

const PLAIN: Record<ShellDialect, RegExp> = {
  bash: /^[^\\$`*?[\]{}~<>()!]*$/,
  powershell: /^[A-Za-z0-9_.,:=+\-/\\ \t;|\n\r]*$/,
  system: /^[^\\$`*?[\]{}~<>()!^%]*$/,
};

export function argvExact(command: string, dialect: ShellDialect): boolean {
  return PLAIN[dialect].test(command);
}
