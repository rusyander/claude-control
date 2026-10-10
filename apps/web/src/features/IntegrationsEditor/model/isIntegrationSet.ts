import type { IntegrationId, IntegrationStatus, IntegrationsSettings } from '@agentdeck/contracts';
import { draftFrom } from './draft';

/**
 * Заведена ли интеграция — по ней карточка стоит в списке без «Добавить».
 *
 * Заведённой считается не только включённая: адрес, сохранённый без ключа, —
 * это настройка на середине, и прятать её значит заставить человека искать
 * свою работу через «Добавить». Пустая и выключенная карточка без ключа —
 * не заведена: десять пустых форм подряд и были тем шумом, от которого список
 * уходит.
 */
export function isIntegrationSet(
  id: IntegrationId,
  settings: IntegrationsSettings,
  status: IntegrationStatus | undefined,
): boolean {
  const saved = settings[id];
  if (saved.enabled || status?.hasToken) return true;
  return Object.values(draftFrom(id, saved as never)).some((value) => value.trim() !== '');
}
