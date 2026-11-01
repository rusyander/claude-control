import type { CoreConfig } from '@agentdeck/contracts/core/config';
import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import { matchesGlob, toSlashes } from '../../lib/glob/glob.ts';
import type { OsKind } from '../../platform/os-kind.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { foldsCaseAt, pathKey } from '../../platform/paths.ts';

/**
 * Что спросить у человека ОДИН раз до запуска (06:110-111): записи `grantRequired` репозиториев
 * задачи, чьи маски пересекают свои пути единиц. Без этого грант спрашивался бы посреди шага, на
 * первом отказе судьи права.
 *
 * Репозиторий записи сравнивается по `pathKey` (регистр свёрнут там, где его не различает том).
 * Маска против своего пути — тем же правилом тома: Windows/macOS свёрнуты, Linux точен
 * (`.Claude/x` на Linux — другой файл, не `.claude/**`).
 *
 * Пересечение двух масок оценивается сверху: свой путь без подстановок — точным сравнением
 * (путь, покрытый маской, или маска внутри своего каталога); иначе — по неподстановочным
 * префиксам каталогов: один префикс другого — пересекаются. Лишний вопрос до запуска дешевле
 * пропущенного (он стал бы вопросом посреди шага).
 */

type GrantRow = NonNullable<CoreConfig['grantRequired']>[number];

const WILD = /[*?[]/;

/** Каталоги до первой подстановки; маска «на любой глубине» (без `/`) — пустой префикс. */
function literalPrefix(glob: string, anywhere: boolean): string[] {
  const clean = toSlashes(glob).replace(/\/+$/, '').replace(/^\/+/, '');
  if (anywhere && !clean.includes('/')) return [];
  const out: string[] = [];
  for (const segment of clean.split('/')) {
    if (WILD.test(segment)) break;
    out.push(segment);
  }
  return out;
}

function prefixOf(a: string[], b: string[], fold: boolean): boolean {
  const eq = (x: string, y: string): boolean =>
    fold ? x.toLowerCase() === y.toLowerCase() : x === y;
  return a.every((seg, i) => i >= b.length || eq(seg, b[i] as string));
}

function overlaps(owned: string, glob: string, fold: boolean): boolean {
  const ownedClean = toSlashes(owned).replace(/^\/+/, '');
  if (!WILD.test(ownedClean)) {
    // Свой путь — каталог или файл целиком (с тем, что под ним): маска покрывает его, или маска
    // лежит внутри него.
    if (matchesGlob(ownedClean, glob, fold, 'gitignore')) return true;
  }
  const a = literalPrefix(ownedClean, false);
  const b = literalPrefix(glob, true);
  return prefixOf(a, b, fold) || prefixOf(b, a, fold);
}

export function grantConfirmations(
  grantRequired: readonly GrantRow[],
  repos: readonly { repoKey: string; path: string }[],
  ownedPaths: readonly string[],
  os: OsKind = currentOs(),
): GrantConfirmation[] {
  const out: GrantConfirmation[] = [];
  for (const repo of repos) {
    const key = pathKey(repo.path, os);
    const fold = foldsCaseAt(repo.path, os);
    for (const row of grantRequired) {
      if (pathKey(row.project, os) !== key) continue;
      const matched = ownedPaths.filter((owned) =>
        row.globs.some((glob) => overlaps(owned, glob, fold)),
      );
      if (matched.length === 0) continue;
      out.push({
        repoKey: repo.repoKey,
        globs: [...row.globs],
        ops: [...row.ops],
        matchedOwnedPaths: matched,
      });
    }
  }
  return out;
}
