/**
 * Файловые операции с двумя страховками, потому что мы правим рабочий конфиг
 * живого инструмента: испорченный settings.json ломает Claude Code целиком.
 *
 *   1. Резервная копия перед каждой записью — в claude-control/backups/.
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

export { assertValidJson, readJsonFile, readTextFile, readTextForm } from './safe-io/read.ts';
export { writeBinaryFile, writeJsonFile, writeTextFile } from './safe-io/write.ts';
export type { WriteOptions } from './safe-io/safe-io.types.ts';
export {
  MAX_BACKUP_KEEP,
  backupEntry,
  clampBackupKeep,
  projectBackupName,
  providerBackupName,
  providerProjectBackupName,
  setBackupKeep,
} from './safe-io/backups.ts';
export {
  SecretBackupUnavailableError,
  hasSecretPassphrase,
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from './safe-io/secrets.ts';
export { copyRecursive, removeEntry } from './safe-io/fs-entry.ts';
