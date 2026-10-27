import { run } from '../../project-git/sieve-facts/sieve-facts.ts';

/**
 * Правка одних комментариев кода не старит сданную строку сита (g3 25.10:
 * коммит «комментарий возвращён над своей функцией» снял шесть строк сит
 * разом, и группа сдавала их заново). Различимо только там, где комментарий
 * виден по началу строки, — по языку файла; разметка (md, mdx, css) и всё
 * прочее не судится: там `#` и `*` — содержимое.
 */
const MARKS: readonly [RegExp, RegExp][] = [
  [/\.(?:go|[cm]?[jt]sx?|rs|java|kts?|cs|c|cc|cpp|h|hpp|swift|scala|dart|php)$/i, /^\s*\/\//],
  [/\.(?:py|rb|sh|bash|ya?ml|toml|tf|r)$/i, /^\s*#/],
  [/\.sql$/i, /^\s*--/],
];

/**
 * Комментарий-директива меняет сборку, линтер или тесты — это код, а не
 * пояснение: `//go:build`, `// eslint-disable`, `# noqa`, `@ts-expect-error`…
 */
const DIRECTIVE =
  /\/\/go:|\/\/\s*\+build|\bnolint\b|\bnoqa\b|eslint|tslint|stylelint|prettier-ignore|biome-ignore|@ts-|istanbul|\b[cv]8 ignore|type:\s*ignore|pylint|rubocop|NOSONAR|^\s*#!|-\*-|@license|@preserve|webpack[A-Z]|@vite-ignore|@jsx|@flow|swiftlint|clippy|allow\(|coverage:ignore/i;

function markOf(path: string): RegExp | undefined {
  return MARKS.find(([file]) => file.test(path))?.[1];
}

/**
 * Пути из `paths`, чей дифф `from..HEAD` — только комментарии и пустые строки.
 * Отступы не прощаются (`-w` нет): в Python и YAML они — структура. Ошибка git
 * — пустой ответ: тогда старит всё, как без этой проверки.
 */
export async function commentOnlyPaths(
  cwd: string,
  from: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const code = paths.filter((path) => markOf(path));
  const only = new Set<string>();
  if (code.length === 0) return only;
  const diff = await run(cwd, [
    '-c',
    'core.quotePath=false',
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    from,
    'HEAD',
    '--',
    ...code,
  ]);
  if (diff.code !== 0) return only;
  for (const block of diff.stdout.split(/^diff --git /m).slice(1)) {
    const hunks = block.indexOf('\n@@');
    if (hunks < 0) continue;
    const head = block.slice(0, hunks);
    const path = /^\+\+\+ b\/(.+)$/m.exec(head)?.[1] ?? /^--- a\/(.+)$/m.exec(head)?.[1];
    const mark = path ? markOf(path) : undefined;
    if (!path || !mark) continue;
    const changed = block
      .slice(hunks + 1)
      .split('\n')
      .filter((line) => line.startsWith('+') || line.startsWith('-'))
      .map((line) => line.slice(1));
    const quiet = (line: string): boolean =>
      !line.trim() || (mark.test(line) && !DIRECTIVE.test(line));
    if (changed.length > 0 && changed.every(quiet)) only.add(path);
  }
  return only;
}
