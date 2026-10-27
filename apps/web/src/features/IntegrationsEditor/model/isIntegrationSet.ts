import type { IntegrationId, IntegrationStatus, IntegrationsSettings } from '@agentdeck/contracts';
import { draftFrom } from './draft';
import { INTEGRATION_FIELDS } from './draft.constants';

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
  // Поле со значением по умолчанию (порог минут) — не настройка человека.
  const draft = draftFrom(id, saved as never);
  return INTEGRATION_FIELDS[id].some(
    (field) => (draft[field.key] ?? '').trim() !== (field.fallback ?? ''),
  );
}
