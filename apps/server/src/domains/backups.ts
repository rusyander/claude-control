import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  backupEntry,
  removeEntry,
  copyRecursive,
  writeTextFile,
  writeBinaryFile,
  setSecretPassphrase,
  SecretBackupUnavailableError,
} from '../lib/safe-io.ts';
import { isEncryptedBackup, decryptSecret } from '../lib/secret-crypto.ts';
import { SKILLS_DISABLED_DIR } from './skills.ts';

/**
 * Резервные копии и откат к ним.
 *
 * Копии складывались с самого начала, но вернуть из них файл можно было только
 * руками — найти в каталоге нужную метку времени и скопировать поверх
 * оригинала. Для инструмента, который правит рабочий конфиг, это странно:
 * страховка есть, а воспользоваться ею нельзя, не выходя из панели.
 */

export interface BackupEntry {
  /** Имя файла копии — оно же идентификатор для отката. */
  name: string;
  /** К какому файлу конфигурации относится копия. */
  target: string;
  createdAt: string;
  sizeBytes: number;
  /**
   * Можно ли вернуть копию кнопкой. Файл конфигурации возвращается по месту;
   * папка (копия скилла) разворачивается рекурсивно в каталог skills/. Кнопки
   * нет только у копий, чью цель некуда вернуть (посторонний файл).
   */
  canRestore: boolean;
  /**
   * Копия зашифрована (файл секретов при включённом шифровании). Восстановление
   * такой копии требует парольную фразу — интерфейс по этому флагу её спрашивает.
   */
  encrypted: boolean;
}

/** Заголовок нашего зашифрованного блока: `CCSB1\n`. Читаем ровно его, не весь файл. */
const ENCRYPTED_HEADER = Buffer.from('CCSB1\n', 'utf8');

/** Начинается ли файл с метки зашифрованной копии — по первым байтам, без чтения целиком. */
function looksEncrypted(path: string): boolean {
  try {
    const head = Buffer.alloc(ENCRYPTED_HEADER.length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    return isEncryptedBackup(head);
  } catch {
    return false;
  }
}

/** Имя копии: `<файл>.<метка времени>.bak`. Метка всегда одна и та же по форме. */
const BACKUP_NAME = /^(.+)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.bak$/;

export function listBackups(
  backupDir: string,
  knownPaths: Record<string, string> = {},
  skillsDir?: string,
): BackupEntry[] {
  if (!existsSync(backupDir)) return [];

  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;

    const path = join(backupDir, name);
    const stats = statSync(path);
    const target = match[1] ?? name;
    const isDirectory = stats.isDirectory();

    entries.push({
      name,
      target,
      createdAt: stats.mtime.toISOString(),
      sizeBytes: stats.size,
      // Цель должна быть известна: копия постороннего файла восстановлению не
      // подлежит. Папку скилла возвращаем в skills/ (см. resolveBackupTarget).
      canRestore: Boolean(resolveBackupTarget(target, isDirectory, knownPaths, skillsDir)),
      // Зашифрованные бывают только у файла секретов; папки не шифруем.
      encrypted: !isDirectory && looksEncrypted(path),
    });
  }

  // Свежие сверху: откатываются обычно к последнему хорошему состоянию.
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Куда возвращать копию. Имя пришло из запроса, поэтому цель не собирается из
 * строки, а выводится безопасно:
 *
 *   файл — ищется в известном списке путей по basename;
 *   папка — это копия скилла с именем `<родитель>-<id>` (skills-… или
 *     skills-disabled-…). Снимаем известный префикс и возвращаем скилл ТУДА,
 *     откуда копия снята. `id` обязан быть одним безопасным сегментом — иначе
 *     `../` увёл бы запись наружу.
 */
export function resolveBackupTarget(
  target: string,
  isDirectory: boolean,
  knownPaths: Record<string, string>,
  skillsDir?: string,
): string | undefined {
  if (isDirectory) return resolveSkillRestore(target, skillsDir)?.target;
  return Object.values(knownPaths).find((path) => basename(path) === target);
}

/**
 * Куда разворачивать копию скилла и что при этом мешает.
 *
 * Префикс имени копии говорит, где скилл лежал в момент снимка: `skills-…` —
 * включённым, `skills-disabled-…` — выключенным. Возвращаем ровно туда. Раньше
 * обе копии разворачивались в активный `skills/`, и откат ВКЛЮЧАЛ скилл,
 * который пользователь выключил, — Claude Code начинал его исполнять, о чём
 * никто не просил.
 *
 * `sibling` — тот же id в соседнем каталоге. Один скилл не может быть
 * одновременно включённым и выключенным: `readSkills` обходит оба каталога, и
 * такой id показался бы в списке дважды, а переключатель падал бы на
 * переименовании папки поверх существующей. Поэтому соседа при откате убираем
 * (сняв с него копию — он мог отличаться от восстанавливаемого).
 *
 * Имя копии читается двояко: `skills-disabled-обзор` — это и выключенный
 * «обзор», и включённый скилл, который так и называется — «disabled-обзор».
 * Разбор только по префиксу выбирал первое всегда и на скилле `disabled-обзор`
 * разворачивал копию мимо цели, а «соседом» считал ПОСТОРОННИЙ скилл `обзор` —
 * и удалял его. Поэтому спрашиваем диск: берём то прочтение, чья папка на месте.
 */
interface SkillRestore {
  target: string;
  sibling: string;
  siblingName: string;
}

function skillRestoreOptions(target: string, skillsDir: string): SkillRestore[] {
  const disabledDir = join(skillsDir, '..', SKILLS_DISABLED_DIR);
  const options: SkillRestore[] = [];

  const isSafeId = (id: string): boolean => Boolean(id) && !/[\\/]/.test(id) && !id.includes('..');

  // Голый префикс («skills-», «skills-disabled-») — испорченное имя копии.
  // Второе прочтение дало бы из него скилл с именем «disabled-», то есть
  // разворачивало бы копию в папку, которой у пользователя нет и быть не должно.
  const primary = target.startsWith(`${SKILLS_DISABLED_DIR}-`)
    ? target.slice(SKILLS_DISABLED_DIR.length + 1)
    : target.startsWith('skills-')
      ? target.slice('skills-'.length)
      : '';
  if (!isSafeId(primary)) return [];

  const add = (wasDisabled: boolean, id: string): void => {
    if (!isSafeId(id)) return;
    options.push({
      target: join(wasDisabled ? disabledDir : skillsDir, id),
      sibling: join(wasDisabled ? skillsDir : disabledDir, id),
      siblingName: `${wasDisabled ? 'skills' : SKILLS_DISABLED_DIR}-${id}`,
    });
  };

  // Порядок важен: при равных правах (обеих папок нет) остаётся прежнее
  // поведение — префикс `skills-disabled-` возвращает скилл выключенным.
  if (target.startsWith(`${SKILLS_DISABLED_DIR}-`))
    add(true, target.slice(SKILLS_DISABLED_DIR.length + 1));
  if (target.startsWith('skills-')) add(false, target.slice('skills-'.length));

  return options;
}

function resolveSkillRestore(target: string, skillsDir?: string): SkillRestore | undefined {
  if (!skillsDir) return undefined;

  const options = skillRestoreOptions(target, skillsDir);
  if (options.length <= 1) return options[0];

  const alive = options.filter((option) => existsSync(option.target));
  if (alive.length === 1) return alive[0];
  // Ни одной папки нет — скилл удалили, возвращаем по префиксу. Обе на месте —
  // прочтение неразличимо, и любой выбор перезаписал бы живой чужой скилл:
  // честнее отказать (кнопка отката у такой копии просто погаснет).
  return alive.length === 0 ? options[0] : undefined;
}

/**
 * Снимок восстанавливаемой копии, снятый ДО того, как что-либо тронет каталог
 * копий: расшифрованный текст, содержимое файла или временный дубль папки.
 */
type RestoreSnapshot =
  | { kind: 'text'; text: string }
  | { kind: 'file'; data: Buffer }
  | { kind: 'directory'; staged: string };

/** Счётчик временных имён — два отката подряд не должны драться за один путь. */
let stageCounter = 0;

/**
 * Временный дубль папки-копии внутри каталога копий. Имя нарочно не похоже на
 * копию (`<файл>.<метка>.bak`): так его не подберёт ни `listBackups`, ни
 * ротация, которая иначе удалила бы дубль вместе с оригиналом.
 */
function stageDirectory(source: string, backupDir: string): string {
  const staged = join(backupDir, `.restore-${process.pid}-${(stageCounter += 1)}`);
  removeEntry(staged);
  copyRecursive(source, staged);
  return staged;
}

export interface RestoreResult {
  ok: boolean;
  /** Куда восстановили. */
  restoredTo?: string;
  /** Копия состояния, которое заменили: откат тоже должен быть обратимым. */
  backupPath?: string;
  error?: string;
}

/**
 * Откат файла к состоянию из копии.
 *
 * Перед заменой снимается копия текущего состояния — иначе откат сам стал бы
 * необратимой операцией, а это ровно то, от чего он спасает.
 *
 * Зашифрованная копия (файл секретов) требует парольную фразу: её содержимое
 * расшифровывается перед записью. Неверная фраза — внятный отказ, файл не
 * трогается. Введённая при восстановлении фраза заодно запоминается в памяти
 * процесса, чтобы копия «состояния до» тоже легла зашифрованной, а не открытым
 * текстом.
 */
export function restoreBackup(
  backupDir: string,
  name: string,
  knownPaths: Record<string, string>,
  skillsDir?: string,
  passphrase?: string,
): RestoreResult {
  const source = join(backupDir, name);
  if (!BACKUP_NAME.test(name) || !existsSync(source))
    return { ok: false, error: 'Копия не найдена' };

  const entry = listBackups(backupDir, knownPaths, skillsDir).find((item) => item.name === name);
  if (!entry) return { ok: false, error: 'Копия не найдена' };

  const isDirectory = statSync(source).isDirectory();
  // Разбор имени делаем ОДИН раз: дальше мы сами меняем диск (снимаем копии,
  // убираем соседа), а разбор смотрит на диск — повторный дал бы другой ответ.
  const skill = isDirectory ? resolveSkillRestore(entry.target, skillsDir) : undefined;
  const target = isDirectory
    ? skill?.target
    : resolveBackupTarget(entry.target, isDirectory, knownPaths, skillsDir);
  if (!target) {
    return { ok: false, error: `Непонятно, куда возвращать копию «${entry.target}»` };
  }

  // Зашифрованную копию расшифровываем ДО того, как трогать целевой файл: если
  // фраза неверна, отказываемся, ничего не записав.
  let decrypted: string | undefined;
  if (entry.encrypted) {
    if (!passphrase) return { ok: false, error: 'Нужна парольная фраза для расшифровки копии' };
    try {
      decrypted = decryptSecret(readFileSync(source), passphrase);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Не удалось расшифровать',
      };
    }
    // Фраза подошла: запоминаем в памяти, чтобы копия «состояния до» тоже
    // зашифровалась (иначе она легла бы открытым текстом мимо режима шифрования).
    setSecretPassphrase(passphrase);
  }

  // Содержимое копии забираем ДО всего остального: копия текущего состояния
  // заканчивается ротацией, а та удаляет самые старые копии той же базы — то
  // есть ровно ту, которую сейчас восстанавливают. Откат к старейшей копии
  // падал на её собственном удалении, а у папки скилла успевал стереть цель и
  // терял разом и копию, и скилл.
  let snapshot: RestoreSnapshot;
  if (decrypted !== undefined) snapshot = { kind: 'text', text: decrypted };
  else if (isDirectory) snapshot = { kind: 'directory', staged: stageDirectory(source, backupDir) };
  else snapshot = { kind: 'file', data: readFileSync(source) };

  try {
    // Перед заменой снимаем копию текущего состояния — откат тоже обратим.
    // Если копия невозможна (шифрование секретов включено, фразы в памяти нет —
    // так бывает при откате СТАРОЙ, ещё незашифрованной копии .mcp-secrets.env),
    // откат не делаем вовсе: иначе живые токены исчезли бы безвозвратно, а
    // панель отрапортовала бы «восстановлено».
    let backupPath: string | undefined;
    try {
      backupPath = existsSync(target) ? backupEntry(target, backupDir, entry.target) : undefined;
    } catch (error) {
      if (error instanceof SecretBackupUnavailableError) return { ok: false, error: error.message };
      throw error;
    }

    if (snapshot.kind === 'directory') {
      // Тот же скилл в соседнем каталоге (skills/ против skills-disabled/)
      // убираем: иначе один id оказался бы и включённым, и выключенным сразу —
      // в списке он двоился бы, а переключатель падал бы на переносе папки
      // поверх существующей. Копию с соседа снимаем: это отдельное состояние,
      // и потерять его молча нельзя.
      if (skill && existsSync(skill.sibling)) {
        backupEntry(skill.sibling, backupDir, skill.siblingName);
        removeEntry(skill.sibling);
      }

      // Папку разворачиваем целиком: сперва убираем прежнюю, чтобы не смешать
      // старые и новые файлы, затем копируем рекурсивно.
      removeEntry(target);
      copyRecursive(snapshot.staged, target);
    } else if (snapshot.kind === 'text') {
      // Расшифрованный секрет пишем атомарно, как обычную правку.
      writeTextFile(target, snapshot.text);
    } else {
      // Тоже атомарно и с сохранением прав целевого файла: прямой writeFileSync
      // отдавал бы восстановленному секрету 0644, если файла на месте не было.
      writeBinaryFile(target, snapshot.data);
    }

    return { ok: true, restoredTo: target, backupPath };
  } finally {
    if (snapshot.kind === 'directory') removeEntry(snapshot.staged);
  }
}

/** Удаление копии — на случай, когда в ней лежит то, чего быть на диске не должно. */
export function deleteBackup(backupDir: string, name: string): boolean {
  const entry = listBackups(backupDir).find((item) => item.name === name);
  if (!entry) return false;

  removeEntry(join(backupDir, name));
  return true;
}
