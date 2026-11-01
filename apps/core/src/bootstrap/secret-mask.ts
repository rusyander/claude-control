import { findSecretSpans, maskSecretsInText, type MaskOptions } from '@agentdeck/dlp/secret-mask';
import type { MaskFn } from '../journal/journal.types.ts';

/**
 * Маска секретов журнала (01 §Durability, P61) = общий детектор `@agentdeck/dlp`, тот же, что
 * у панели. Журнал знает только форму функции; подключает её загрузка.
 *
 * `keepHashes`: ровно 40/64 hex без секретного имени — коммит или sha256 (хеш профиля и слоя,
 * baseRef, ключ идемпотентности), не секрет. Без этого схема отвергала `task.created` с
 * хешем и `layer.changed`, а ref ложился «••••••» навсегда (ревью B1, 28.10). Hex под
 * секретным именем (`GITHUB_TOKEN=…`) и ключи с префиксом вендора прячутся по-прежнему.
 *
 * `keepRouteIds`: `api-key:endpoint:<id>` — id маршрута реестра (W2b): id карточки панели с
 * цифрой иначе шёл за пароль после `api-key:`, и схема отвергала `task.created`.
 */
const OPTIONS: MaskOptions = { keepHashes: true, keepRouteIds: true };

export const dlpSecretMask: MaskFn = (text) => {
  const count = findSecretSpans(text, OPTIONS).length;
  return count === 0 ? { text, count } : { text: maskSecretsInText(text, OPTIONS), count };
};
