import { isAbsolutePath, longForm } from '../../platform/paths.ts';
import { canonicalTarget } from './target-path.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Пути контекста судьи в той же форме, что и цель (core-s2 H7). Цель read/edit/exec сводится
 * `canonicalTarget` к `C:\…`, и списки, с которыми её сравнивают, обязаны пройти тот же путь:
 * дом ядра, заданный `\localhost\C$\…`, иначе не совпадал с `C:\…`-написанием токена, и чтение
 * разрешалось. Длинная форма (8.3 → длинное имя) — чтобы хвост пути платформы сверялся по
 * настоящим именам, а не по `AGENTD~1`.
 *
 * Запись запрета, которую сложить нельзя (сервер не этой машины, `\?\GLOBALROOT`,
 * `\?\Volume{…}`), не выпадает из списка молча: она закрывает судью для всего, что может под ней
 * лежать (06 §Session permissions: несводимое — отказ). Чужая доля может оказаться этим же диском
 * по имени в сети — сравнить с ней нельзя ничего. Несводимая запись РАЗРЕШЕНИЯ (область чтения,
 * F-87) просто ничего не открывает.
 */

type Field =
  | 'copyRoot'
  | 'platformPaths'
  | 'editPaths'
  | 'endpointSources'
  | 'readRoots'
  | 'humanRoots'
  | 'ownTemp'
  | 'credentials';

export interface FoldedPaths {
  copyRoot: string;
  platformPaths: readonly string[];
  editPaths: readonly string[];
  endpointSources: readonly string[];
  /** Область чтения вне копии (F-87): корни платформы и слоя, список человека. */
  readRoots: readonly string[];
  humanRoots: readonly string[];
  /** Временный каталог сеанса; нет — не задан или несводим. */
  ownTemp: string | undefined;
  credentials: readonly string[];
  /** Первая несводимая запись каждого поля; пусто — всё сложено. */
  unfoldable: Partial<Record<Field, string>>;
}

interface Cached {
  sources: readonly unknown[];
  folded: FoldedPaths;
}

// Один раз на контекст: сеанс держит один объект на все вопросы. Сверка источников по ссылке —
// подменённый список (или корень) пересчитывается, а не судится по старой свёртке.
const cache = new WeakMap<PermitContext, Cached>();

/**
 * Поля области чтения: относительная запись свелась бы от cwd ядра, а не от чего-то названного, —
 * она несводима (разрешение ничего не открывает, учётные данные закрывают судью).
 */
const ABSOLUTE_ONLY: ReadonlySet<Field> = new Set([
  'readRoots',
  'humanRoots',
  'ownTemp',
  'credentials',
]);

function fold(path: string, field?: Field): string | null {
  if (field !== undefined && ABSOLUTE_ONLY.has(field) && !isAbsolutePath(path)) return null;
  const canon = canonicalTarget(path);
  return 'refuse' in canon ? null : longForm(canon.path);
}

function foldList(
  list: readonly string[],
  field: Field,
  unfoldable: FoldedPaths['unfoldable'],
): string[] {
  const out: string[] = [];
  for (const path of list) {
    const folded = fold(path, field);
    if (folded === null) unfoldable[field] ??= path;
    else out.push(folded);
  }
  return out;
}

export function foldedPaths(ctx: PermitContext): FoldedPaths {
  const scope = ctx.readScope;
  const sources = [
    ctx.copyRoot,
    ctx.platformPaths,
    ctx.deny.editPaths,
    ctx.endpointSources,
    scope,
    scope?.roots,
    scope?.human,
    scope?.ownTemp,
    scope?.credentials,
  ];
  const hit = cache.get(ctx);
  if (hit && hit.sources.every((source, i) => source === sources[i])) return hit.folded;
  const unfoldable: FoldedPaths['unfoldable'] = {};
  const copyRoot = fold(ctx.copyRoot);
  if (copyRoot === null) unfoldable.copyRoot = ctx.copyRoot;
  const ownTemp = scope?.ownTemp === undefined ? null : fold(scope.ownTemp, 'ownTemp');
  if (scope?.ownTemp !== undefined && ownTemp === null) unfoldable.ownTemp = scope.ownTemp;
  const folded: FoldedPaths = {
    // Несводимый корень копии остаётся как написан только для текста отказа: судья с ним
    // ничего не сравнивает (`unfoldable.copyRoot` закрывает read/edit/exec раньше).
    copyRoot: copyRoot ?? ctx.copyRoot,
    platformPaths: foldList(ctx.platformPaths, 'platformPaths', unfoldable),
    editPaths: foldList(ctx.deny.editPaths ?? [], 'editPaths', unfoldable),
    endpointSources: foldList(ctx.endpointSources, 'endpointSources', unfoldable),
    readRoots: foldList(scope?.roots ?? [], 'readRoots', unfoldable),
    humanRoots: foldList(scope?.human ?? [], 'humanRoots', unfoldable),
    ownTemp: ownTemp ?? undefined,
    credentials: foldList(scope?.credentials ?? [], 'credentials', unfoldable),
    unfoldable,
  };
  cache.set(ctx, { sources, folded });
  return folded;
}

/**
 * Причина закрыть дорогу путей (read/edit/exec): несводимый корень копии, путь платформы или
 * файл учётных данных — то, что запрещено, под несводимой записью может лежать где угодно.
 */
export function unfoldableRoot(paths: FoldedPaths): string | null {
  const { copyRoot, platformPaths, credentials } = paths.unfoldable;
  if (copyRoot !== undefined) return `copy root ${copyRoot} is not comparable`;
  if (platformPaths !== undefined) return `platform path ${platformPaths} is not comparable`;
  if (credentials !== undefined) return `credential file ${credentials} is not comparable`;
  return null;
}
