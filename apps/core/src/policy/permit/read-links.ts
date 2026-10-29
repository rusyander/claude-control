import { LINK_SCAN_BUDGET, pathKind, scanLinks } from '../../platform/links.ts';
import { isInside } from '../../platform/paths.ts';
import { deny, type ReadVerdict } from './judge-helpers.ts';

/**
 * Ссылки под корнем поиска (F-87, проход 2). Маска или каталог читаются инструментом, о котором
 * судья не знает, ходит ли он по ссылкам, — значит, каждая ссылка поддерева судится так, как если
 * бы её цель читали напрямую: цель вне области, путь платформы, учётные данные — отказ с кодом
 * этой цели. Нечитаемая ссылка и недосмотренный обход (бюджет, нет прав) — отказ `outside-copy`
 * (F25: «не знаю» ≠ «ссылок нет»). Цель-каталог в разрешённом месте обходится тоже: ссылка из
 * кеша наружу — та же дыра. Обход идёт на каждый поиск: ссылку, сделанную моделью посреди сеанса,
 * снимок при запуске не увидел бы.
 */

/** Поиск, а не чтение одного файла: маска или каталог (неизвестное — тоже поиск). */
export function isSearch(abs: string, wildcard: boolean): boolean {
  if (wildcard) return true;
  const kind = pathKind(abs);
  return kind === 'dir' || kind === 'unknown';
}

export function linksVerdict(
  searched: string,
  judge: (path: string) => ReadVerdict,
  budget = LINK_SCAN_BUDGET,
): ReadVerdict | null {
  const queue = [searched];
  const scanned: string[] = [];
  let left = budget;
  while (queue.length > 0) {
    const root = queue.shift() as string;
    if (scanned.some((done) => isInside(done, root))) continue;
    scanned.push(root);
    // Корня нет — ссылок под ним нет и читать нечего (висячую ссылку на пути отказал судья раньше).
    if (pathKind(root) === 'missing') continue;
    const scan = scanLinks(root, left);
    if (!scan.complete) {
      return deny('outside-copy', `search root not fully seen for links: ${scan.reason}`, null);
    }
    left -= scan.seen;
    for (const link of scan.links) {
      if (link.target === null) {
        return deny(
          'outside-copy',
          `search root holds a link that does not resolve: ${link.at}`,
          null,
        );
      }
      const verdict = judge(link.target);
      if (!verdict.allow) {
        return deny(
          verdict.code,
          `search root holds a link ${link.at} → ${link.target}: ${verdict.reason}`,
          verdict.humanPoint,
        );
      }
      if (pathKind(link.target) === 'dir') queue.push(link.target);
    }
  }
  return null;
}
