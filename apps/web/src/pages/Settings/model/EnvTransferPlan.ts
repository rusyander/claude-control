import type {
  EnvTransferPlanEntry,
  EnvTransferPlatformEntry,
  EnvTransferPromptEntry,
} from '../EnvTransfer.types';

/**
 * Разбор плана разворота архива — отдельно от разметки, потому что это правила,
 * а не оформление: что можно отметить и что отмечено по умолчанию.
 *
 * Умолчание намеренно осторожное — только НОВЫЕ записи. Перезапись своей
 * конфигурации чужой должна быть осознанным щелчком, а не тем, что панель
 * подставила заранее.
 */

/** Записи, которые вообще можно применить: нерешённым некуда лечь. */
export function selectableEntries(entries: EnvTransferPlanEntry[]): EnvTransferPlanEntry[] {
  return entries.filter((entry) => entry.status !== 'unresolved');
}

/** Что отмечено при открытии плана: только новое. */
export function defaultSelection(entries: EnvTransferPlanEntry[]): string[] {
  return entries.filter((entry) => entry.status === 'new').map((entry) => entry.archivePath);
}

/**
 * Что отмечено в секции контуров при открытии — тоже только новое. Контур,
 * который здесь уже настроен, перезаписывается чужой настройкой только руками:
 * на этой машине у него может быть свой адрес, свои проекты и свой бюджет.
 */
export function defaultPlatformSelection(entries: EnvTransferPlatformEntry[]): string[] {
  return entries.filter((entry) => entry.status === 'new').map((entry) => entry.id);
}

/**
 * Что отмечено в секции промптов при открытии: только новое и только известное
 * этой панели. Промпт, которого здесь нет, отметить нельзя вовсе — записать
 * такую правку было бы некуда.
 */
export function defaultPromptSelection(entries: EnvTransferPromptEntry[]): string[] {
  return entries
    .filter((entry) => entry.status === 'new' && !entry.unknown)
    .map((entry) => entry.id);
}

/** Отмечено ли всё, что можно отметить (для переключателя «отметить всё»). */
export function isAllSelected(entries: EnvTransferPlanEntry[], selected: Set<string>): boolean {
  const selectable = selectableEntries(entries);
  return selectable.length > 0 && selectable.every((entry) => selected.has(entry.archivePath));
}

/** Размер по-человечески: байты в интерфейсе никому ни о чём не говорят. */
export function formatArchiveSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
