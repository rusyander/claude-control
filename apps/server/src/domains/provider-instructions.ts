import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  AppSettings,
  ProviderInstructionsEntry,
  ProviderInstructionsInfo,
  ProviderInstructionsScope,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import {
  providerBackupName,
  providerProjectBackupName,
  readTextFile,
  writeTextFile,
} from '../lib/safe-io.ts';
import {
  UnrecognizedFormatError,
  readAiderReadList,
  writeAiderReadList,
} from '../lib/aider-yaml.ts';
import { isInsideProject } from './projects.ts';

/**
 * Раздел «Инструкции» в модели СПИСКА ССЫЛОК (AIDER-1).
 *
 * У Claude/Codex/Gemini/OpenCode инструкции — один файл, и его обслуживает
 * `domains/instructions.ts`. У Aider единого файла инструкций НЕТ: по
 * документации файлы контекста подключаются опцией `read` в `.aider.conf.yml` —
 * СПИСКОМ путей (`read: [CONVENTIONS.md, anotherfile.txt]`; допустима и форма
 * маркированным списком, и одиночная строка). Значит управлять надо ссылками, а
 * не «файлом AGENTS.md», которого у Aider не существует.
 *
 * ЧТО ДЕЛАЕТ РАЗДЕЛ:
 *  1. читает список `read` и показывает по каждой записи абсолютный путь и факт
 *     существования файла;
 *  2. пишет список целиком (добавить / убрать / переставить = один PUT). Правка
 *     идёт Document API пакета `yaml`: комментарии, порядок ключей и все прочие
 *     ключи конфига целы, меняется ТОЛЬКО узел `read`;
 *  3. дополнительно даёт править СОДЕРЖИМОЕ уже перечисленного файла — обычный
 *     текст, бэкап + атомарная запись + сохранение формы (BOM/CRLF).
 *
 * ЧЕГО РАЗДЕЛ НЕ ДЕЛАЕТ (осознанно): не создаёт файлов, которых нет в списке, и
 * не создаёт файл по несуществующей записи — «инструкции» тут это ссылка, а не
 * файл, и придумывать содержимое за пользователя панель не должна.
 *
 * FAIL-CLOSED: конфиг не разбирается как YAML-отображение или `read` имеет
 * неожиданную форму → чтение отдаёт `readOnly`, запись 422; путь записи вне
 * каталога проекта (проектный уровень) → 400 `unsafe_path`, файл не трогаем.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
interface ProviderInstructionsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + конфигурация со списком + база путей. */
export interface ProviderInstructionsTarget {
  provider: ConfigProvider;
  format: 'aider-yaml';
  scope: ProviderInstructionsScope;
  /** Абсолютный путь конфигурации со списком (`~/.aider.conf.yml`). */
  configPath: string;
  /** Каталог, от которого разрешаются относительные записи списка. */
  baseDir: string;
  /**
   * Корень проекта — только для проектного уровня. Задан → каждая запись обязана
   * лежать ВНУТРИ проекта, иначе панель её не открывает и не пишет.
   */
  projectRoot?: string;
  /** Имя резервной копии конфигурации (у проекта — с префиксом `-project-`). */
  backupName?: string;
}

/** Почему запись списка нельзя открыть на правку. */
export type ListedFileRefusal =
  'missing' | 'binary' | 'too_large' | 'directory' | 'unlisted' | 'unsafe_path';

/**
 * Запись списка есть в конфиге, но открыть/записать её файл нельзя.
 *
 * NB: поля объявлены ЯВНО, а не параметрами конструктора. Сервер запускается
 * `node --experimental-strip-types`, а в strip-only режиме parameter properties
 * (`constructor(readonly x: string)`) не поддерживаются — такой класс валит
 * старт процесса, хотя type-check и vitest (со своей транспиляцией) молчат.
 */
export class ListedFileNotEditableError extends Error {
  readonly raw: string;
  readonly reason: ListedFileRefusal;

  constructor(raw: string, reason: ListedFileRefusal, message: string) {
    super(message);
    this.name = 'ListedFileNotEditableError';
    this.raw = raw;
    this.reason = reason;
  }
}

/**
 * Больше этого панель не открывает: раздел — редактор инструкций, а не просмотр
 * дампов. Ограничение защищает и память сервера, и браузер.
 */
const MAX_EDITABLE_BYTES = 1_000_000;

/**
 * Цель глобального раздела инструкций-ссылок — или `undefined`, если активный
 * провайдер этой моделью не пользуется (маршрут ответит 4xx). Поддержан, только
 * когда `globalInstructions` = `ready` И задан `instructionsList`. Claude и все
 * «однофайловые» провайдеры сюда не попадают — они на своих роутах.
 */
export function resolveProviderInstructionsTarget(
  store: ProviderInstructionsSettingsSource,
): ProviderInstructionsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.globalInstructions !== 'ready' || !provider.instructionsList) {
    return undefined;
  }

  const configPath = provider.instructionsList.path(store.getSettings().claudeDirOverride);
  return {
    provider,
    format: provider.instructionsList.format,
    scope: 'global',
    configPath,
    // Относительные записи конфига разрешаем от каталога самого конфига — это
    // единственная база, которую панель знает наверняка (для глобального файла
    // это домашний каталог). Полный путь всегда показан в интерфейсе.
    baseDir: dirname(configPath),
  };
}

/** Абсолютный путь записи: абсолютную оставляем как есть, относительную — от базы. */
export function resolveEntryPath(target: ProviderInstructionsTarget, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(target.baseDir, raw);
}

/** Почему запись нельзя открыть на правку (или `undefined` — можно). */
function editabilityReason(path: string): ProviderInstructionsEntry['reason'] | undefined {
  if (!existsSync(path)) return 'missing';
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 'missing';
  }
  if (stat.isDirectory()) return 'directory';
  if (stat.size > MAX_EDITABLE_BYTES) return 'too_large';
  // Бинарный файл распознаём по нулевому байту в начале — тот же дешёвый признак,
  // что используют git и большинство редакторов.
  try {
    const head = readFileSync(path).subarray(0, 8000);
    if (head.includes(0)) return 'binary';
  } catch {
    return 'missing';
  }
  return undefined;
}

/** Описать одну запись списка для клиента. */
function describeEntry(target: ProviderInstructionsTarget, raw: string): ProviderInstructionsEntry {
  const path = resolveEntryPath(target, raw);
  // На проектном уровне запись вне каталога проекта показываем, но НЕ открываем:
  // конфиг чужой, а писать за пределы проекта раздел не имеет права.
  const outside = target.projectRoot !== undefined && !isInsideProject(target.projectRoot, path);
  const reason = outside ? 'missing' : editabilityReason(path);
  return {
    raw,
    path,
    exists: !outside && existsSync(path),
    editable: !outside && reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

/** Прочитать список ссылок конфигурации. Файла нет → пустой список. */
export function readProviderInstructionsEntries(
  target: ProviderInstructionsTarget,
): ProviderInstructionsEntry[] {
  const text = readTextFile(target.configPath);
  if (!text.trim()) return [];
  return readAiderReadList(text).map((raw) => describeEntry(target, raw));
}

/** Сводка раздела для клиента (без содержимого файлов). */
export function readProviderInstructionsInfo(
  target: ProviderInstructionsTarget,
): ProviderInstructionsInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    configPath: target.configPath,
    configExists: existsSync(target.configPath),
    baseDir: target.baseDir,
  };
  try {
    return { ...base, entries: readProviderInstructionsEntries(target), readOnly: false };
  } catch (error) {
    if (error instanceof UnrecognizedFormatError) {
      return { ...base, entries: [], readOnly: true, error: error.message };
    }
    throw error;
  }
}

/**
 * Разобрать желаемый список из тела запроса. Схему zod в рантайме сервера
 * использовать нельзя (значение из contracts роняет node ESM) — проверяем руками.
 * Пустые строки и дубликаты отбрасываются, порядок сохраняется. Некорректное
 * тело → `undefined` (маршрут ответит 400).
 */
export function parseProviderInstructionsDraft(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return undefined;

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return undefined;
    const value = item.trim();
    if (!value) return undefined;
    // Перевод строки разрушил бы скалярную запись YAML — отсекаем до файла.
    if (/[\r\n]/.test(value)) return undefined;
    if (seen.has(value)) continue;
    seen.add(value);
    entries.push(value);
  }
  return entries;
}

/**
 * Записать полный список ссылок в ключ `read`: бэкап + атомарно + сохранение
 * формы файла. Комментарии и прочие ключи конфига целы (Document API `yaml`),
 * round-trip проверяется ДО записи. Пустой список удаляет ключ.
 *
 * preserveForm по умолчанию: текст пересобран сериализатором `yaml` (всегда LF),
 * поэтому BOM и CRLF существующего файла возвращает `safe-io`.
 */
export function saveProviderInstructionsEntries(
  target: ProviderInstructionsTarget,
  entries: string[],
  backupDir: string | undefined,
): string | undefined {
  const original = existsSync(target.configPath) ? readFileSync(target.configPath, 'utf8') : '';
  const next = writeAiderReadList(original, entries);

  return writeTextFile(target.configPath, next, {
    backupDir,
    backupName: target.backupName ?? providerBackupName(target.provider.id, target.configPath),
  });
}

/**
 * Найти запись списка по её исходному значению и убедиться, что её файл можно
 * открыть. Записи НЕТ в списке → отказ: панель правит только то, на что конфиг
 * реально ссылается (файлы «мимо списка» не выдумываем).
 */
function requireEditableEntry(
  target: ProviderInstructionsTarget,
  raw: string,
): ProviderInstructionsEntry {
  const entries = readProviderInstructionsEntries(target);
  const entry = entries.find((item) => item.raw === raw);
  if (!entry) {
    throw new ListedFileNotEditableError(
      raw,
      'unlisted',
      `Записи «${raw}» нет в списке read конфигурации ${target.configPath}.`,
    );
  }
  if (target.projectRoot !== undefined && !isInsideProject(target.projectRoot, entry.path)) {
    throw new ListedFileNotEditableError(
      raw,
      'unsafe_path',
      `Путь «${raw}» выходит за пределы каталога проекта — панель его не открывает.`,
    );
  }
  if (!entry.editable) {
    const reason = entry.reason ?? 'missing';
    const message =
      reason === 'missing'
        ? `Файл ${entry.path} не существует. Панель не создаёт файлы, которых нет: создайте его сами или уберите запись из списка.`
        : reason === 'directory'
          ? `Путь ${entry.path} — каталог, а не файл.`
          : reason === 'too_large'
            ? `Файл ${entry.path} слишком большой для правки в панели.`
            : `Файл ${entry.path} не является текстовым — панель его не открывает.`;
    throw new ListedFileNotEditableError(raw, reason, message);
  }
  return entry;
}

/** Прочитать содержимое ОДНОГО перечисленного файла. */
export function readListedInstructionsFile(
  target: ProviderInstructionsTarget,
  raw: string,
): { raw: string; path: string; content: string } {
  const entry = requireEditableEntry(target, raw);
  return { raw: entry.raw, path: entry.path, content: readTextFile(entry.path) };
}

/**
 * Записать содержимое ОДНОГО перечисленного файла: бэкап + атомарно + сохранение
 * формы (BOM/CRLF). Только существующий текстовый файл из списка — иначе отказ.
 */
export function writeListedInstructionsFile(
  target: ProviderInstructionsTarget,
  raw: string,
  content: string,
  backupDir: string | undefined,
): string | undefined {
  const entry = requireEditableEntry(target, raw);
  // Копия перечисленного файла отделена от копий самого конфига именем провайдера
  // (а на проектном уровне ещё и префиксом `-project-`), чтобы CONVENTIONS.md
  // проекта и глобальный не делили одну ротацию.
  const backupName =
    target.scope === 'project'
      ? providerProjectBackupName(target.provider.id, entry.path)
      : providerBackupName(target.provider.id, entry.path);
  return writeTextFile(entry.path, content, { backupDir, backupName });
}
