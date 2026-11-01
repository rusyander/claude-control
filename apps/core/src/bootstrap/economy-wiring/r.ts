import { readKeyPresence } from '@agentdeck/keys/provider-keys';

/**
 * Проводка маршрутов зоны R (план s5 §2): порт наличия ключа для маршрутов `api-key` и
 * `gateway`. Ядро ключей не держит (09, G5) — читает только «есть / нет» из того же
 * зашифрованного хранилища панели, строгим чтением пакета `@agentdeck/keys`: нет файла — «нет»,
 * файл не читается (секрета нет, расшифровка не сошлась, мусор) — бросает с кодом, и маршрут
 * превращает это в `unknown` + `refuse` (P111), а не в «ключа нет — иди без него».
 */
export type KeyPresencePort = (storeId: string) => boolean;

/** `appDataDir` — каталог данных панели, где лежат `provider-keys.enc` и `provider-keys.key`. */
export function keyPresencePort(appDataDir: string): KeyPresencePort {
  return (storeId) => readKeyPresence(appDataDir, storeId);
}
