/**
 * Фасад старого пути: хранилище ключей переехало в `packages/keys` (тот же файл, то же
 * шифрование — его читают панель, ядро и хост переходов, план s5 G5/G12). Импорты панели и
 * её тесты остаются на этом пути; панель пользуется снисходительным чтением (битое — пусто),
 * строгие чтения пакета — для ядра и хоста.
 */
export {
  MAX_KEY_LENGTH,
  clearStoredKey,
  getStoredKey,
  hasStoredKey,
  maskKey,
  readKeyStore,
  setStoredKey,
} from '@agentdeck/keys/provider-keys';
