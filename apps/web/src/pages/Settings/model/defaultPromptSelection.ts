import type { EnvTransferPromptEntry } from '../EnvTransfer.types';

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
