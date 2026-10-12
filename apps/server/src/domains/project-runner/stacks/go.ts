import { join } from 'node:path';
import { findUp, isDir, isFile, listDir, readText, relPath } from './fs-probe.ts';
import type { StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Go: программа = каталог с `package main` и `func main()` внутри модуля.
 *
 * Запуск идёт из КОРНЯ МОДУЛЯ (`go run ./cmd/api`), а не из каталога программы:
 * сервисы ищут конфиги, миграции и шаблоны относительно корня, и `go run .`
 * из `cmd/api` падал бы на «config.yaml: no such file» у большинства из них.
 */

/** Главный файл программы в каталоге или undefined, если это не `package main`. */
export function goMainFile(dir: string): string | undefined {
  for (const name of listDir(dir)) {
    if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
    const text = readText(join(dir, name));
    if (text && /^package\s+main\b/m.test(text) && /^func\s+main\s*\(\s*\)/m.test(text)) {
      return join(dir, name);
    }
  }
  return undefined;
}

/** Каталоги программ `cmd/*` модуля, лежащего в `moduleDir`. */
export function goProgramDirs(moduleDir: string): string[] {
  const cmd = join(moduleDir, 'cmd');
  if (!isDir(cmd)) return [];
  return listDir(cmd)
    .map((name) => join(cmd, name))
    .filter((dir) => isDir(dir) && goMainFile(dir) !== undefined);
}

export function goCandidates({ dir, root }: StackProbe): StackCandidate[] {
  const moduleDir = findUp(dir, root, ['go.mod']);
  if (!moduleDir) return [];
  const main = goMainFile(dir);
  if (!main) return [];

  const evidence = [join(moduleDir, 'go.mod'), main];
  const pkg = dir === moduleDir ? '.' : `./${relPath(moduleDir, dir)}`;
  const found: StackCandidate[] = [];

  // air — горячая перезагрузка: если проект его настроил, человек привык к нему.
  if (isFile(join(dir, '.air.toml'))) {
    found.push({
      stack: 'go',
      framework: 'air',
      evidence: [...evidence, join(dir, '.air.toml')],
      file: 'air',
      args: [],
      cwd: dir,
      display: 'air',
      tool: 'air',
    });
  }

  found.push({
    stack: 'go',
    evidence,
    file: 'go',
    args: ['run', pkg],
    cwd: moduleDir,
    display: `go run ${pkg}`,
    tool: 'go',
  });
  return found;
}
