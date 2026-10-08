/**
 * Накрывает ли шаблон `wide` вызовы, подходящие под `narrow`. Точно известны
 * три случая: тот же шаблон; голое имя инструмента (`Bash`) против уточнения
 * (`Bash(git status:*)`); сервер целиком (`mcp__srv`) против его инструмента
 * (`mcp__srv__tool`). Пересечения масок внутри скобок не разбираются —
 * лучше промолчать, чем соврать.
 */
export function coversPattern(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(wide)) return narrow.startsWith(`${wide}(`);
  if (wide.startsWith('mcp__') && !wide.includes('(') && !wide.includes('__', 5)) {
    return narrow.startsWith(`${wide}__`);
  }
  return false;
}
