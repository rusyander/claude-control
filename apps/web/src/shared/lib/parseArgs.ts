/**
 * Аргументы команды разбираются с учётом кавычек: в путях Windows часто
 * встречаются пробелы, и наивное разбиение по пробелу их ломает.
 */
export function parseArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => (/^(["']).*\1$/.test(part) ? part.slice(1, -1) : part));
}
