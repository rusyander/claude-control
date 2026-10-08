/** Строка источника обнаружения для человека: `provider:claude` → «общие каталоги claude». */
export function sourceLabel(source: string): { kind: 'provider' | 'project'; name: string } {
  return source.startsWith('provider:')
    ? { kind: 'provider', name: source.slice('provider:'.length) }
    : { kind: 'project', name: source };
}
