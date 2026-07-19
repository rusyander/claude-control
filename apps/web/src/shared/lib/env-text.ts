/**
 * Переменные окружения редактируются как текст в формате KEY=VALUE по строке.
 * Это привычнее таблицы с кнопками «добавить строку» и позволяет вставить
 * готовый блок из документации одним движением.
 *
 * Живёт в shared, потому что нужен и редактору MCP-серверов, и редактору
 * групп: импортировать одну фичу из другой доктрина запрещает.
 */

export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function textToEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key) result[key] = trimmed.slice(separator + 1).trim();
  }

  return result;
}

/**
 * Аргументы команды разбираются с учётом кавычек: в путях Windows часто
 * встречаются пробелы, и наивное разбиение по пробелу их ломает.
 */
export function parseArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => (/^(["']).*\1$/.test(part) ? part.slice(1, -1) : part));
}

export function formatArgs(args: string[]): string {
  return args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}
