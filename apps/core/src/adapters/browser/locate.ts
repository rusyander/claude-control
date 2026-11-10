import type { BrowseTarget } from '@agentdeck/contracts/core/browse';
import type { Locator, Page } from 'playwright-core';

/**
 * Смысловая цель → локатор Playwright (P177). Ровно четыре способа, которыми потом ищет спек
 * записи (R3): `getByRole` с именем, `getByTestId`, `getByLabel`, `getByText`, все с
 * `exact: true` — спек повторит тот же поиск буква в букву, и «нашлось при проходе, не нашлось
 * при повторе» не случится. CSS-селектора здесь нет: схема его не пропускает, а локатор из
 * строки модели (`page.locator`) сделал бы запись хрупкой к любой правке вёрстки.
 */

type AriaRole = Parameters<Page['getByRole']>[0];

export function locatorOf(page: Page, target: BrowseTarget): Locator {
  if ('role' in target)
    return page.getByRole(target.role as AriaRole, { name: target.name, exact: true });
  if ('testId' in target) return page.getByTestId(target.testId);
  if ('label' in target) return page.getByLabel(target.label, { exact: true });
  return page.getByText(target.text, { exact: true });
}

/** Цель словами для находки: модель видит, что именно не нашлось. */
export function targetText(target: BrowseTarget): string {
  if ('role' in target) return `role ${target.role} "${target.name}"`;
  if ('testId' in target) return `test id "${target.testId}"`;
  if ('label' in target) return `label "${target.label}"`;
  return `text "${target.text}"`;
}
