import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { copyRecursive, removeEntry } from './fs-entry.ts';
import { encryptSecretBackup, needsSecretEncryption } from './secrets.ts';

/**
 * Копия с отметкой времени — файла или папки целиком. Timestamp без двоеточий:
 * иначе имя невалидно в Windows. `name` задаётся, когда одного basename мало,
 * чтобы различить копии (скилл лежит и в skills/, и в skills-disabled/).
 *
 * Копия файла секретов при включённом шифровании пишется зашифрованной. Если
 * шифрование включено, а парольной фразы в памяти нет (например, после
 * перезапуска сервера до повторного ввода) — копию НЕ делаем вовсе: писать
 * секреты открытым текстом в этом режиме нельзя, а молча подменить шифр
 * плейнтекстом — обман.
 *
 * И НЕ МОЛЧА: раньше здесь возвращался undefined, и вызывающий (правка секрета,
 * откат старой копии поверх живого файла) спокойно продолжал перезапись — токены
 * исчезали, а панель отвечала `ok`, откатываться было не к чему. Теперь это
 * `SecretBackupUnavailableError`: нет копии — нет и разрушающей записи.
 * Плейнтекст на диск при этом по-прежнему не попадает.
 */
export function backupEntry(path: string, backupDir: string, name?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  // Спрашиваем ДО mkdir и штампа: отказ не должен оставлять следов на диске.
  const encrypt = needsSecretEncryption(path);

  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = name ?? basename(path);
  const target = join(backupDir, `${base}.${stamp}.bak`);

  if (encrypt) writeFileSync(target, encryptSecretBackup(readFileSync(path, 'utf8')));
  else copyRecursive(path, target);

  rotateBackups(backupDir, base);
  return target;
}

/**
 * Сколько копий одного файла хранить. Панель пишет конфиг при каждой правке —
 * без ограничения каталог копий растёт бесконечно, а внутри лежат в том числе
 * копии `.mcp-secrets.env` открытым текстом. Десяти хватает, чтобы отмотать
 * назад несколько шагов; всё, что старше, только занимает место.
 *
 * Настраивается: кому-то нужно больше истории, кому-то — меньше копий секретов
 * на диске. Значение задаётся из настроек через `setBackupKeep` при старте и
 * при их изменении; по умолчанию — десять.
 */
let keepBackups = 10;

/**
 * Верхний предел глубины ротации — тот же, что в контракте `appSettingsSchema`
 * (backupKeep: 1..100). Держим его и на сервере: без клампа PATCH со значением
 * вроде 100000 заставил бы панель хранить сто тысяч копий (в т.ч. `.mcp-secrets.env`
 * открытым текстом) на диске.
 */
export const MAX_BACKUP_KEEP = 100;

/** Привести глубину ротации к контрактному диапазону [1..100] (floor). */
export function clampBackupKeep(count: number): number {
  return Math.min(MAX_BACKUP_KEEP, Math.max(1, Math.floor(count)));
}

/** Сколько копий одного файла держать (из настроек панели). Диапазон 1..100. */
export function setBackupKeep(count: number): void {
  if (Number.isFinite(count) && count >= 1) keepBackups = clampBackupKeep(count);
}

function rotateBackups(backupDir: string, base: string): void {
  const prefix = `${base}.`;
  const own = readdirSync(backupDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
    // Отметка времени в имени — ISO, поэтому лексикографический порядок
    // совпадает с хронологическим, и читать stat каждого файла незачем.
    .sort();

  for (const stale of own.slice(0, Math.max(0, own.length - keepBackups))) {
    removeEntry(join(backupDir, stale));
  }
}

/**
 * Имя резервной копии файла ПРОВАЙДЕРА — с префиксом его id.
 *
 * Каталог копий один на всю панель, а basename у файлов разных провайдеров
 * совпадает: `~/.gemini/settings.json` и `~/.claude/settings.json`,
 * `~/.codex/AGENTS.md` и `~/.config/opencode/AGENTS.md`. Без префикса их копии
 * попадали бы в ОДНУ ротацию (десять копий на всех), лента истории показывала бы
 * дифф чужого файла против claude-конфига, а откат (он ищет цель по basename)
 * вернул бы настройки Gemini поверх `~/.claude/settings.json`. Префикс делает
 * копии провайдеров различимыми и невосстановимыми по чужому пути (fail-closed).
 */
export function providerBackupName(providerId: string, filePath: string): string {
  return `${providerId}-${basename(filePath)}`;
}

/**
 * Имя резервной копии ПРОЕКТНОГО файла провайдера — `<id>-project-<basename>`.
 *
 * Отдельно от `providerBackupName`, потому что basename проектного файла
 * совпадает с глобальным (`<проект>/.codex/config.toml` ↔ `~/.codex/config.toml`,
 * `<проект>/AGENTS.md` ↔ `~/.codex/AGENTS.md`). Без своего префикса копии
 * проектных и глобальных файлов делили бы одну ротацию (правки проекта вытесняли
 * бы историю глобального конфига), а лента изменений показывала бы дифф проекта
 * как правку глобального файла. Восстановление у них так же запрещено.
 */
export function providerProjectBackupName(providerId: string, filePath: string): string {
  return `${providerId}-project-${basename(filePath)}`;
}
