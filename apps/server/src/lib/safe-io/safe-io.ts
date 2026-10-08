/**
 * Файловые операции с двумя страховками, потому что мы правим рабочий конфиг
 * живого инструмента: испорченный settings.json ломает Claude Code целиком.
 *
 *   1. Резервная копия перед каждой записью — в agentdeck/backups/.
 *   2. Атомарная запись: пишем во временный файл и переименовываем.
 *      Прерванная запись не оставит обрезанный конфиг.
 *
 * Тем же механизмом страхуются удаления (скилл, файл скилла): там копия —
 * единственный способ отменить операцию, потому что стирается целая папка.
 *
 * Фасад над `safe-io/`: чтение (`read`), атомарная запись (`write`), копии и их
 * ротация (`backups`), секреты и их шифрование (`secrets`), режимы и ссылки
 * (`path-guards`), рекурсивные копирование/удаление (`fs-entry`).
 */

export { assertValidJson, readJsonFile, readTextFile, readTextForm } from './read.ts';
export { renameWithRetry, writeBinaryFile, writeJsonFile, writeTextFile } from './write.ts';
export type { WriteOptions } from './safe-io.types.ts';
export {
  MAX_BACKUP_KEEP,
  backupEntry,
  clampBackupKeep,
  projectBackupName,
  providerBackupName,
  providerProjectBackupName,
  setBackupKeep,
  transferBackupName,
} from './backups.ts';
export {
  SecretBackupUnavailableError,
  hasSecretPassphrase,
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from './secrets.ts';
export { copyRecursive, removeEntry } from './fs-entry.ts';
