import type { Platform } from '@agentdeck/contracts';
import { missingFromCatalog } from './missingFromCatalog';

/** Карта соответствия строками: словарь для показа и правки. */
export interface ModelMapRow {
  from: string;
  to: string;
  /** Справа стоит модель, которой в каталоге больше нет. */
  missing: boolean;
}

/**
 * Строки карты для показа. Правая часть сверяется с каталогом на КАЖДОМ показе:
 * при добавлении выбор ограничен каталогом, но каталог меняется, и строка,
 * молча переводящая в исчезнувшую модель, — это 404 без единого слова.
 */
export function mapRows(platform: Platform, catalog: readonly string[] = []): ModelMapRow[] {
  return Object.entries(platform.modelMap).map(([from, to]) => ({
    from,
    to,
    missing: catalog.length > 0 && missingFromCatalog(catalog, to),
  }));
}
