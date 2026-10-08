import type { EnvTransferPlatformEntry } from '../EnvTransfer.types';

/**
 * Что отмечено в секции контуров при открытии — тоже только новое. Контур,
 * который здесь уже настроен, перезаписывается чужой настройкой только руками:
 * на этой машине у него может быть свой адрес, свои проекты и свой бюджет.
 */
export function defaultPlatformSelection(entries: EnvTransferPlatformEntry[]): string[] {
  return entries.filter((entry) => entry.status === 'new').map((entry) => entry.id);
}
