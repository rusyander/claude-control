import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import type {
  AppSettings,
  ProviderSkill,
  ProviderSkillDraft,
  ProviderSkillSummary,
  ProviderSkillsIgnoredDir,
  ProviderSkillsInfo,
  ProviderSkillsScope,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_NAME,
  SKILL_NAME_MAX,
  SkillFormatError,
  checkSkillDescription,
  checkSkillName,
  readOpencodeSkill,
  writeOpencodeSkill,
} from '../lib/opencode-skill.ts';

/**
 * Раздел «Скиллы» у НЕ-Claude провайдера (OPENCODE-5).
 *
 * Понятие ТО ЖЕ, что в разделе скиллов Claude (`domains/skills.ts`, маршруты
 * `/api/skills`): скилл — папка с файлом `SKILL.md`, у которого в начале
 * YAML-шапка. Тот раздел не меняется ни на строку; здесь — каталог скиллов
 * ЧУЖОГО CLI, у которого свои пути и свой набор полей шапки.
 *
 * У OpenCode задокументированы два каталога:
 *  - глобальный `~/.config/opencode/skills/<имя>/SKILL.md`;
 *  - проектный `<проект>/.opencode/skills/<имя>/SKILL.md`.
 *
 * ЧТО ДЕЛАЕТ РАЗДЕЛ: перечисляет скиллы (имя, описание, путь, признак проблемы),
 * открывает один скилл, создаёт, обновляет и удаляет — ровно как раздел скиллов
 * Claude, чтобы пользоваться было привычно.
 *
 * ПРОВЕРКА ИМЕНИ ДО ЗАПИСИ (иначе OpenCode скилл не подхватит): 1–64 символа,
 * строчные буквы и цифры, одиночный дефис-разделитель, не в начале и не в конце,
 * без `--`, и `name` обязано СОВПАДАТЬ С ИМЕНЕМ ПАПКИ. `description` — 1–1024
 * символа. Нарушение → 400, файл не тронут.
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — как у правил Cursor и плагинов OpenCode. Клиент присылает
 * путь ОТНОСИТЕЛЬНО каталога скиллов, и он обязан разрешаться ВНУТРИ него, имея
 * РОВНО форму `<имя>/SKILL.md`. Отклоняются: пустое имя, `.`/`..`/пустой сегмент,
 * абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`), нулевой байт, любая другая
 * форма пути и путь, любой сегмент которого — символическая ссылка. Отказ = 400
 * `unsafe_path` ВСЕГДА, никогда 404: существует ли что-то за пределами каталога —
 * не наше дело сообщать. Одинаково на чтении, записи и удалении.
 *
 * FAIL-CLOSED: шапка не разобрана → скилл только для чтения (GET отдаёт файл как
 * есть, PUT 422, файл байт-в-байт прежний); каталог не читается → весь раздел
 * только для чтения. Каталог и папки скиллов создаются ТОЛЬКО при явном
 * сохранении.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
interface ProviderSkillsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + каталог скиллов. */
export interface ProviderSkillsTarget {
  provider: ConfigProvider;
  format: 'skill-md-dir';
  scope: ProviderSkillsScope;
  /** Абсолютный путь каталога скиллов. */
  skillsDir: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
  /**
   * Каталоги, из которых CLI ТОЖЕ грузит скиллы, но которыми раздел НЕ
   * управляет (только показывает). Задаются лишь на глобальном уровне.
   */
  externalDirs: string[];
  /** Предел длины описания у ЭТОГО CLI (у Kimi — 240, у остальных 1024). */
  descriptionMax?: number;
}

/** Путь скилла выходит за пределы каталога скиллов — операция запрещена. */
export class UnsafeSkillPathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь скилла «${path}» отклонён: ${detail}`);
    this.name = 'UnsafeSkillPathError';
    this.path = path;
  }
}

/** Скилла с таким путём в каталоге нет. */
export class SkillNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Скилл «${path}» не найден в каталоге скиллов.`);
    this.name = 'SkillNotFoundError';
    this.path = path;
  }
}

/** Скилл существует, но панель его не переписывает (шапка не разобрана). */
export class SkillNotEditableError extends Error {
  readonly path: string;
  readonly problem: SkillFormatError['problem'];

  constructor(path: string, problem: SkillFormatError['problem'], message: string) {
    super(message);
    this.name = 'SkillNotEditableError';
    this.path = path;
    this.problem = problem;
  }
}

/** Черновик скилла нарушает задокументированные правила — записи не будет. */
export class InvalidSkillDraftError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'InvalidSkillDraftError';
    this.reason = reason;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов. `undefined` для ошибок, которые маршрут пробрасывает.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404.
 */
export function describeSkillError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafeSkillPathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof InvalidSkillDraftError) {
    return {
      status: 400,
      body: { error: 'invalid_draft', reason: error.reason, message: error.message },
    };
  }
  if (error instanceof SkillNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof SkillNotEditableError) {
    return {
      status: 422,
      body: { error: 'skill_read_only', problem: error.problem, message: error.message },
    };
  }
  return undefined;
}

/** Больше этого панель не открывает: раздел — редактор скиллов, а не просмотр дампов. */
const MAX_SKILL_BYTES = 1_000_000;

/** Предохранитель обхода каталога: он пользовательский, его размер не наш. */
const MAX_ENTRIES = 2000;

/**
 * Каталоги, из которых OpenCode грузит скиллы ПОМИМО собственного. По
 * документации это `~/.claude/skills` и `~/.agents/skills`, поэтому уже готовые
 * скиллы Claude работают в нём без переноса. Раздел показывает их для сведения и
 * НИКОГДА туда не пишет: скиллами Claude управляет собственный раздел Claude.
 */
export function opencodeExternalSkillDirs(): string[] {
  return [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')];
}

/**
 * Цель глобального раздела скиллов — или `undefined`, если активный провайдер
 * его не поддерживает (маршрут ответит 4xx). Поддержан, только когда `skills` =
 * `ready` И задан `skillsConfig`. Claude сюда не попадает: у него свой раздел.
 */
export function resolveProviderSkillsTarget(
  store: ProviderSkillsSettingsSource,
): ProviderSkillsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.skills !== 'ready' || !provider.skillsConfig) return undefined;

  const override = store.getSettings().claudeDirOverride;
  return {
    provider,
    format: provider.skillsConfig.format,
    scope: 'global',
    skillsDir: provider.skillsConfig.dir(override),
    backupPrefix: `${provider.id}-`,
    externalDirs: provider.skillsConfig.alsoLoadedFrom?.() ?? [],
    ...(provider.skillsConfig.descriptionMax
      ? { descriptionMax: provider.skillsConfig.descriptionMax }
      : {}),
  };
}

// --- Безопасность путей ------------------------------------------------------

/** Абсолютный ли путь по любым правилам (POSIX, Windows-диск, UNC). */
function looksAbsolute(value: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(value);
}

/**
 * Разрешить относительный путь скилла ВНУТРИ каталога скиллов. Допустима РОВНО
 * одна форма — `<имя>/SKILL.md`.
 *
 * Отклоняем: пустое имя, абсолютный путь, нулевой байт, `..`/`.`/пустой сегмент,
 * любое иное число сегментов, чужое имя файла, выход за каталог по итоговому
 * пути и символическую ссылку в любом сегменте.
 *
 * NB: грамматика ИМЕНИ скилла здесь НЕ проверяется — иначе нельзя было бы даже
 * прочитать скилл с неправильным именем, а показать его надо (и пометить).
 */
export function resolveSkillPath(target: ProviderSkillsTarget, rawPath: string): string {
  const value = String(rawPath ?? '').trim();
  if (!value) throw new UnsafeSkillPathError(rawPath, 'пустое имя.');
  if (looksAbsolute(value)) throw new UnsafeSkillPathError(value, 'абсолютные пути запрещены.');
  if (value.includes('\0')) throw new UnsafeSkillPathError(value, 'недопустимый символ.');

  // Разделители НЕ схлопываем: `skill//SKILL.md` даёт пустой сегмент и отклоняется.
  const segments = value.split(/[/\\]/);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new UnsafeSkillPathError(value, 'сегменты «.», «..» и пустые запрещены.');
    }
  }
  if (segments.length !== 2 || segments[1] !== SKILL_FILE_NAME) {
    throw new UnsafeSkillPathError(value, `допустима только форма «<имя>/${SKILL_FILE_NAME}».`);
  }

  const fullPath = join(target.skillsDir, ...segments);
  // Контрольная проверка после сборки: наружу каталога путь уйти не должен.
  const rel = relative(target.skillsDir, fullPath);
  if (!rel || rel.startsWith('..') || looksAbsolute(rel)) {
    throw new UnsafeSkillPathError(value, 'путь выходит за пределы каталога скиллов.');
  }

  assertNoSymlinkEscape(target.skillsDir, fullPath, value);
  return fullPath;
}

/**
 * Ни один сегмент между каталогом скиллов и целью не должен быть символической
 * ссылкой: через неё запись/удаление ушли бы наружу каталога. Сам каталог
 * скиллов ссылкой быть может — это выбор пользователя и корень доверия.
 */
function assertNoSymlinkEscape(skillsDir: string, fullPath: string, shown: string): void {
  let current = skillsDir;
  for (const segment of relative(skillsDir, fullPath).split(sep)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // дальше по пути ничего не существует — подменять нечего
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeSkillPathError(shown, 'на пути есть символическая ссылка.');
    }
  }
}

/** Путь `<папка>/SKILL.md` в клиентской форме (разделитель `/`). */
function toRelative(target: ProviderSkillsTarget, fullPath: string): string {
  return relative(target.skillsDir, fullPath).split(sep).join('/');
}

// --- Чтение каталога ---------------------------------------------------------

/** Папки каталога: со `SKILL.md` — скиллы, без него — прочие (показываем, не трогаем). */
function walkSkillsDir(target: ProviderSkillsTarget): { skills: string[]; ignored: string[] } {
  const skills: string[] = [];
  const ignored: string[] = [];
  let seen = 0;

  for (const entry of readdirSync(target.skillsDir, { withFileTypes: true })) {
    if (seen >= MAX_ENTRIES) break;
    // Символические ссылки не обходим вовсе: они могут вести наружу каталога, а
    // правку по такому пути защита всё равно отклонит — показывать нечестно.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    seen += 1;
    const dir = join(target.skillsDir, entry.name);
    if (existsSync(join(dir, SKILL_FILE_NAME))) skills.push(dir);
    else ignored.push(dir);
  }

  return { skills, ignored };
}

/** Размер файла в байтах; недоступен → 0 (лишь витрина, не решение о записи). */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function summarize(target: ProviderSkillsTarget, skillDir: string): ProviderSkillSummary {
  const fullPath = join(skillDir, SKILL_FILE_NAME);
  const dirName = basename(skillDir);
  const base = {
    dirName,
    path: toRelative(target, fullPath),
    fullPath,
    size: sizeOf(fullPath),
  };

  try {
    const { fields } = readOpencodeSkill(readTextFile(fullPath));
    return {
      ...base,
      name: fields.name,
      description: fields.description,
      frontmatterOk: true,
      nameMismatch: fields.name !== dirName,
    };
  } catch (error) {
    if (error instanceof SkillFormatError) {
      // Имя папки — единственное, что известно наверняка у нечитаемой шапки.
      return {
        ...base,
        name: dirName,
        frontmatterOk: false,
        problem: error.problem,
        nameMismatch: false,
      };
    }
    throw error;
  }
}

/** Сводка раздела: скиллы, папки без `SKILL.md` и путь каталога. */
export function readProviderSkillsInfo(target: ProviderSkillsTarget): ProviderSkillsInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    skillsDir: target.skillsDir,
    dirExists: existsSync(target.skillsDir),
    externalDirs: target.externalDirs.map((path) => ({ path, exists: existsSync(path) })),
  };

  if (!base.dirExists) return { ...base, skills: [], ignored: [], readOnly: false };

  try {
    const walked = walkSkillsDir(target);
    return {
      ...base,
      skills: walked.skills
        .map((dir) => summarize(target, dir))
        .sort((a, b) => a.dirName.localeCompare(b.dirName)),
      ignored: walked.ignored
        .map((dir): ProviderSkillsIgnoredDir => ({ dirName: basename(dir), fullPath: dir }))
        .sort((a, b) => a.dirName.localeCompare(b.dirName)),
      readOnly: false,
    };
  } catch (error) {
    // Каталог не читается (права, гонка с удалением) — раздел на чтение, но
    // писать в него вслепую нельзя: fail-closed.
    return {
      ...base,
      skills: [],
      ignored: [],
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Прочитать ОДИН скилл: поля шапки отдельно от markdown-тела. Шапка не разобрана
 * (или её нет) → файл отдаётся ЦЕЛИКОМ как тело с пометкой `readOnly` —
 * прочитать можно, переписать нельзя.
 */
export function readProviderSkill(target: ProviderSkillsTarget, rawPath: string): ProviderSkill {
  const fullPath = resolveSkillPath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new SkillNotFoundError(rawPath);
  }
  if (sizeOf(fullPath) > MAX_SKILL_BYTES) {
    throw new SkillNotEditableError(
      rawPath,
      'malformed',
      `Файл ${fullPath} слишком большой для правки в панели.`,
    );
  }

  const text = readTextFile(fullPath);
  const dirName = basename(dirname(fullPath));
  const base = { path: toRelative(target, fullPath), fullPath, dirName };

  try {
    const skill = readOpencodeSkill(text);
    return {
      ...base,
      name: skill.fields.name,
      description: skill.fields.description,
      body: skill.body,
      otherKeys: skill.otherKeys,
      readOnly: false,
    };
  } catch (error) {
    if (error instanceof SkillFormatError) {
      return {
        ...base,
        name: dirName,
        description: '',
        body: text,
        otherKeys: [],
        readOnly: true,
        problem: error.problem,
      };
    }
    throw error;
  }
}

/**
 * Разобрать черновик скилла из тела запроса. Схему zod в рантайме сервера
 * использовать нельзя — проверяем руками. Здесь только ТИПЫ полей; смысловые
 * правила (грамматика имени, совпадение с папкой, длины) проверяет
 * `assertSkillDraft` — у них разные коды ответа не нужны, но разные сообщения.
 */
export function parseProviderSkillDraft(body: unknown): ProviderSkillDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;

  if (typeof raw.path !== 'string' || !raw.path.trim()) return undefined;
  if (typeof raw.name !== 'string' || typeof raw.description !== 'string') return undefined;
  // Пустое тело допустимо (скилл может состоять из одной шапки), отсутствие — нет.
  if (typeof raw.body !== 'string') return undefined;
  // Перевод строки внутри однострочных полей шапки сломал бы форму записи.
  if (/[\r\n]/.test(raw.name) || /[\r\n]/.test(raw.description)) return undefined;
  if (raw.name.includes('\0') || raw.description.includes('\0')) return undefined;

  return {
    path: raw.path,
    name: raw.name,
    description: raw.description,
    body: raw.body,
  };
}

/**
 * Проверить черновик по ЗАДОКУМЕНТИРОВАННЫМ правилам — до любой записи.
 * `dirName` — имя папки из уже проверенного пути: `name` обязано ему совпадать,
 * иначе CLI скилл не подхватит. `descriptionMax` приходит из каталога: у Kimi
 * документация ограничивает описание 240 знаками, у прочих потолка нет (1024).
 *
 * Грамматика ИМЕНИ намеренно одна и самая узкая из трёх (строчная латиница,
 * цифры и одиночные дефисы): она допустима у всех — и у OpenCode, и у Qwen
 * (`[\p{L}\p{N}_:.-]+`), и у Kimi. Панель пишет заведомо совместимое имя, а
 * читает любые уже существующие папки как есть.
 */
export function assertSkillDraft(
  draft: ProviderSkillDraft,
  dirName: string,
  descriptionMax: number = SKILL_DESCRIPTION_MAX,
): void {
  const nameProblem = checkSkillName(draft.name);
  if (nameProblem) {
    const detail: Record<string, string> = {
      empty: 'имя обязательно.',
      too_long: `имя длиннее ${SKILL_NAME_MAX} символов.`,
      leading_hyphen: 'имя не может начинаться с дефиса.',
      trailing_hyphen: 'имя не может заканчиваться дефисом.',
      double_hyphen: 'два дефиса подряд запрещены.',
      pattern: 'допустимы только строчные латинские буквы, цифры и одиночные дефисы.',
    };
    throw new InvalidSkillDraftError(
      `name_${nameProblem}`,
      `Имя скилла «${draft.name}» не годится: ${detail[nameProblem]}`,
    );
  }

  if (draft.name !== dirName) {
    throw new InvalidSkillDraftError(
      'name_dir_mismatch',
      `Имя скилла «${draft.name}» обязано совпадать с именем его папки «${dirName}».`,
    );
  }

  const descriptionProblem = checkSkillDescription(draft.description, descriptionMax);
  if (descriptionProblem) {
    throw new InvalidSkillDraftError(
      `description_${descriptionProblem}`,
      descriptionProblem === 'empty'
        ? 'Описание скилла обязательно: по нему CLI решает, когда его подключать.'
        : `Описание скилла длиннее ${descriptionMax} символов.`,
    );
  }
}

/** Имя резервной копии скилла: `<id>[-project-]skill-<имя папки>`. */
function skillBackupName(target: ProviderSkillsTarget, dirName: string): string {
  return `${target.backupPrefix}skill-${dirName}`;
}

/**
 * Создать или обновить скилл: проверка правил → бэкап → атомарная запись +
 * сохранение формы файла (BOM/CRLF). Комментарии шапки и все ключи, которыми
 * панель не управляет (`license`, `compatibility`, `metadata`, чужие),
 * сохраняются. Папка скилла и сам каталог скиллов создаются ТОЛЬКО здесь — при
 * явном сохранении.
 *
 * Существующий файл с неразобранной шапкой НЕ переписывается —
 * `SkillNotEditableError` (маршрут ответит 422).
 */
export function saveProviderSkill(
  target: ProviderSkillsTarget,
  draft: ProviderSkillDraft,
  backupDir: string | undefined,
): { path: string; fullPath: string; backupPath?: string } {
  const fullPath = resolveSkillPath(target, draft.path);
  const dirName = basename(dirname(fullPath));
  assertSkillDraft(draft, dirName, target.descriptionMax ?? SKILL_DESCRIPTION_MAX);

  const exists = existsSync(fullPath);
  if (exists && !statSync(fullPath).isFile()) {
    throw new UnsafeSkillPathError(draft.path, 'по этому пути находится каталог, а не файл.');
  }

  const original = exists ? readTextFile(fullPath) : '';
  if (exists) {
    // Fail-closed: файл, который панель не понимает, она не переписывает.
    try {
      readOpencodeSkill(original);
    } catch (error) {
      if (error instanceof SkillFormatError) {
        throw new SkillNotEditableError(
          draft.path,
          error.problem,
          `Скилл ${fullPath} только для чтения: ${error.message}`,
        );
      }
      throw error;
    }
  }

  const next = writeOpencodeSkill(
    original,
    { name: draft.name, description: draft.description },
    draft.body,
  );
  const backupPath = writeTextFile(fullPath, next, {
    backupDir,
    backupName: skillBackupName(target, dirName),
  });

  return { path: toRelative(target, fullPath), fullPath, ...(backupPath ? { backupPath } : {}) };
}

/**
 * Удалить скилл: сначала резервная копия ПАПКИ, потом её удаление. Защита пути
 * ровно та же, что при записи, и удаляется РОВНО папка этого скилла — ничего
 * выше по дереву.
 */
export function deleteProviderSkill(
  target: ProviderSkillsTarget,
  rawPath: string,
  backupDir: string | undefined,
): { path: string; backupPath?: string } {
  const fullPath = resolveSkillPath(target, rawPath);
  const skillDir = dirname(fullPath);
  // Контроль: удаляем только прямую подпапку каталога скиллов, и никогда его сам.
  if (dirname(skillDir) !== target.skillsDir || skillDir === target.skillsDir) {
    throw new UnsafeSkillPathError(rawPath, 'удалять можно только папку самого скилла.');
  }
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    throw new SkillNotFoundError(rawPath);
  }

  const dirName = basename(skillDir);
  const backupPath = backupDir
    ? backupEntry(skillDir, backupDir, skillBackupName(target, dirName))
    : undefined;
  // removeEntry, а не rmSync: у скилла может быть нелатинское имя папки, а
  // рекурсивный rmSync на такой папке рапортует об успехе, ничего не удалив.
  removeEntry(skillDir);

  return { path: toRelative(target, fullPath), ...(backupPath ? { backupPath } : {}) };
}
