import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { realExistingPrefix } from '../../platform/links.ts';
import { isInside } from '../../platform/paths.ts';
import { foldedPaths, type FoldedPaths, unfoldableRoot } from './context-paths.ts';
import { absolute, ancestorOfAny, deny, type ReadVerdict, underAny } from './judge-helpers.ts';
import { isSearch, linksVerdict } from './read-links.ts';
import { canonicalTarget, literalPrefix } from './target-path.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Чтение и поиск (06 §Session permissions; область чтения — решение владельца 28.10, F-87).
 * Порядок: несводимое → свой временный каталог и копии вложений задачи → путь платформы и его предок → источник адреса →
 * учётные данные CLI и их предок → область (копия, корни платформы и слоя, список человека) →
 * иначе `outside-copy`. Запреты стоят раньше области: путь платформы или файл учётных данных
 * внутри разрешённого каталога остаётся закрытым. Сравнение — по ключам пути (`isInside`):
 * ссылка или junction в копии судится по своей цели, а не по написанию.
 *
 * Поиск без явного пути читает рабочий каталог сеанса — копию: пустая голова маски = корень
 * копии. Проверяются и цель целиком, и буквальная голова маски: `src/**\/../../x` поднимается
 * выше головы. Поиск (маска или каталог) дополнительно судится по ссылкам своего поддерева
 * (`read-links.ts`): маска может совпасть со ссылкой, которой в литеральном пути нет.
 */

/** Временный каталог сеанса открыт, только если в нём нет ни одного пути платформы. */
function insideOwnTemp(paths: FoldedPaths, abs: string, searched: string): boolean {
  const temp = paths.ownTemp;
  if (temp === undefined || ancestorOfAny(temp, paths.platformPaths)) return false;
  return isInside(temp, abs) && isInside(temp, searched);
}

/**
 * Копии вложений задачи (s10 G11): каталог этой задачи рядом с домом ядра (`attachmentsHome`,
 * `agentdeck-attachments/<имя дома>/<taskId>/`, вне запрета оверлея CLI). Открыт на условиях своего временного каталога — только
 * если в нём нет ни одного пути платформы, и только под ним самим: соседняя задача — вне области.
 */
function insideAttachments(paths: FoldedPaths, abs: string, searched: string): boolean {
  const root = paths.attachments;
  if (root === undefined || ancestorOfAny(root, paths.platformPaths)) return false;
  return isInside(root, abs) && isInside(root, searched);
}

function inScope(roots: readonly string[], abs: string, searched: string): boolean {
  return roots.some((root) => isInside(root, abs) && isInside(root, searched));
}

export function readVerdict(ask: PermissionAsk, ctx: PermitContext): ReadVerdict {
  const canon = canonicalTarget(ask.target);
  if ('refuse' in canon) return deny('platform-path', `${canon.refuse}: not comparable`, null);
  const paths = foldedPaths(ctx);
  const closed = unfoldableRoot(paths);
  if (closed !== null) return deny('platform-path', closed, null);
  const abs = absolute(paths, canon.path);
  const root = literalPrefix(canon.path);
  const searched = root === '' ? paths.copyRoot : absolute(paths, root);
  // Ссылка на литеральном пути, которая не разрешается (висячая, петля, нет прав): куда она
  // ведёт, неизвестно — отказ, а не путь «как написан» (F25).
  for (const path of [abs, searched]) {
    const real = realExistingPrefix(path);
    if ('unknown' in real) return deny('outside-copy', `link on the path: ${real.unknown}`, null);
  }
  const verdict = judgePath(paths, abs, searched);
  if (!verdict.allow || !isSearch(abs, root !== canon.path)) return verdict;
  const linked = linksVerdict(
    searched,
    (target) => judgePath(paths, target, target),
    ctx.readScope?.scanBudget,
  );
  return linked ?? verdict;
}

/** Решение по литеральному пути цели и голове поиска (без обхода ссылок поддерева). */
function judgePath(paths: FoldedPaths, abs: string, searched: string): ReadVerdict {
  // Свой временный каталог сеанса (TMPDIR CLI) — в доме ядра, но токенов в нём нет.
  if (insideOwnTemp(paths, abs, searched)) {
    return { allow: true, signal: null, reason: 'read inside the session temp dir' };
  }
  if (insideAttachments(paths, abs, searched)) {
    return {
      allow: true,
      signal: null,
      reason: "read of the human's attachment copy of this task",
    };
  }
  if (underAny(abs, paths.platformPaths) || underAny(searched, paths.platformPaths)) {
    return deny('platform-path', 'core home and token files are never readable', null);
  }
  if (ancestorOfAny(searched, paths.platformPaths)) {
    return deny('platform-path', 'read or search over an ancestor of the core home', null);
  }
  // Несводимый источник адреса может оказаться любым файлом: точка человека 3, не молчание.
  if (paths.unfoldable.endpointSources !== undefined || underAny(abs, paths.endpointSources)) {
    return deny('endpoint-source', 'source holds a non-ephemeral service endpoint', 3);
  }
  if (
    underAny(abs, paths.credentials) ||
    underAny(searched, paths.credentials) ||
    ancestorOfAny(searched, paths.credentials)
  ) {
    return deny('credential-path', 'CLI credential files are never readable', null);
  }
  if (inScope([paths.copyRoot], abs, searched)) {
    return { allow: true, signal: null, reason: 'read inside the copy' };
  }
  if (inScope(paths.readRoots, abs, searched)) {
    return { allow: true, signal: null, reason: 'read inside a toolchain, cache or CLI layer dir' };
  }
  if (inScope(paths.humanRoots, abs, searched)) {
    return { allow: true, signal: null, reason: 'read inside a dir the human allowed' };
  }
  return deny('outside-copy', `read of ${abs} outside the copy and the read scope`, null);
}
