import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type {
  AppSettings,
  ProviderRule,
  ProviderRuleDraft,
  ProviderRuleSummary,
  ProviderRulesIgnoredFile,
  ProviderRulesInfo,
  ProviderRulesScope,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import {
  MDC_EXTENSION,
  MdcFormatError,
  readMdcRule,
  writeMdcRule,
  type MdcFields,
} from '../lib/cursor-mdc.ts';

/**
 * Раздел «Инструкции» в модели КАТАЛОГА ПРАВИЛ (CURSOR-1) — третья модель.
 *
 * Первые две: `domains/instructions.ts` — ОДИН файл (Claude/Codex/Gemini/
 * OpenCode); `domains/provider-instructions.ts` — СПИСОК ССЫЛОК (Aider, ключ
 * `read`). У Cursor не подходит ни та, ни другая: по документации его правила —
 * это КАТАЛОГ файлов `.mdc` (глобальный `~/.cursor/rules/`, проектный
 * `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются), где каждый
 * файл несёт свой frontmatter с полями `description` / `globs` / `alwaysApply`.
 *
 * ЧТО ДЕЛАЕТ РАЗДЕЛ:
 *  1. перечисляет все `*.mdc` рекурсивно, показывая по каждому относительный
 *     путь, три поля frontmatter, размер и признак «frontmatter не разобран»;
 *  2. отдельно перечисляет файлы каталога, которые Cursor ИГНОРИРУЕТ (обычный
 *     `.md` без frontmatter и любое другое расширение) — панель их не правит;
 *  3. открывает одно правило: поля frontmatter отдельно, markdown-тело отдельно;
 *  4. создаёт / обновляет / удаляет правило (бэкап + атомарная запись +
 *     сохранение формы файла; при записи целы комментарии frontmatter и все
 *     ключи, которыми панель не управляет).
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — главное здесь. Клиент присылает путь ОТНОСИТЕЛЬНО каталога
 * правил, и он обязан разрешаться ВНУТРИ него. Отклоняются: пустое имя, `..` в
 * любом сегменте, абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`), расширение
 * не `.mdc`, а также путь, любой сегмент которого — символическая ссылка (через
 * неё можно было бы выйти наружу). Отказ = `UnsafeRulePathError` → 400
 * `unsafe_path`, ни чтения, ни записи, ни удаления. Ровно то же — при удалении.
 *
 * FAIL-CLOSED: frontmatter правила не разбирается (или его нет вовсе) → правило
 * показывается ТОЛЬКО ДЛЯ ЧТЕНИЯ, запись по нему 422; каталог не читается →
 * весь раздел только для чтения.
 *
 * ЧЕГО РАЗДЕЛ НЕ ДЕЛАЕТ: не создаёт каталог правил и подкаталоги «на всякий
 * случай» — они появляются только при ЯВНОМ сохранении правила по такому пути.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
interface ProviderRulesSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + каталог правил. */
export interface ProviderRulesTarget {
  provider: ConfigProvider;
  format: 'cursor-mdc';
  scope: ProviderRulesScope;
  /** Абсолютный путь каталога правил (`~/.cursor/rules`). */
  rulesDir: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
}

/** Путь правила выходит за пределы каталога правил — операция запрещена. */
export class UnsafeRulePathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь правила «${path}» отклонён: ${detail}`);
    this.name = 'UnsafeRulePathError';
    this.path = path;
  }
}

/** Правило существует, но панель его не переписывает (frontmatter не разобран). */
export class RuleNotEditableError extends Error {
  readonly path: string;
  readonly problem: MdcFormatError['problem'];

  constructor(path: string, problem: MdcFormatError['problem'], message: string) {
    super(message);
    this.name = 'RuleNotEditableError';
    this.path = path;
    this.problem = problem;
  }
}

/** Правило с таким путём не найдено в каталоге. */
export class RuleNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Правило «${path}» не найдено в каталоге правил.`);
    this.name = 'RuleNotFoundError';
    this.path = path;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов (дублировать раскладку в двух местах нельзя: разъедется).
 * Возвращает `undefined` для ошибок, которые маршрут обязан пробросить дальше.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404: сообщать, есть ли
 * файл за пределами каталога правил, панель не должна.
 */
export function describeRuleError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafeRulePathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof RuleNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof RuleNotEditableError) {
    return {
      status: 422,
      body: { error: 'rule_read_only', problem: error.problem, message: error.message },
    };
  }
  return undefined;
}

/** Больше этого панель не открывает: раздел — редактор правил, а не просмотр дампов. */
const MAX_RULE_BYTES = 1_000_000;

/** Предохранители обхода каталога: он пользовательский, глубина и размер не наши. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;

/**
 * Цель глобального раздела правил — или `undefined`, если активный провайдер
 * этой моделью не пользуется (маршрут ответит 4xx). Поддержан, только когда
 * `globalInstructions` = `ready` И задан `instructionsRules`.
 */
export function resolveProviderRulesTarget(
  store: ProviderRulesSettingsSource,
): ProviderRulesTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.globalInstructions !== 'ready' || !provider.instructionsRules) {
    return undefined;
  }

  return {
    provider,
    format: provider.instructionsRules.format,
    scope: 'global',
    rulesDir: resolve(provider.instructionsRules.dir(store.getSettings().claudeDirOverride)),
    backupPrefix: `${provider.id}-`,
  };
}

// --- Безопасность путей ------------------------------------------------------

/** Абсолютный ли путь по любым правилам (POSIX, Windows-диск, UNC). */
function looksAbsolute(value: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(value);
}

/**
 * Разрешить относительный путь правила ВНУТРИ каталога правил.
 *
 * Отклоняем: пустое имя, абсолютный путь, `..`/`.` в любом сегменте, расширение
 * не `.mdc`, выход за каталог по итоговому пути и символическую ссылку в любом
 * сегменте (иначе запись ушла бы туда, куда ссылка указывает).
 */
export function resolveRulePath(target: ProviderRulesTarget, rawPath: string): string {
  const value = String(rawPath ?? '').trim();
  if (!value) throw new UnsafeRulePathError(rawPath, 'пустое имя.');
  if (looksAbsolute(value)) throw new UnsafeRulePathError(value, 'абсолютные пути запрещены.');
  if (value.includes('\0')) throw new UnsafeRulePathError(value, 'недопустимый символ.');

  // Разделители НЕ схлопываем: `sub//rule.mdc` даёт пустой сегмент и отклоняется —
  // нормализовать за пользователя странную форму пути панель не должна.
  const segments = value.split(/[/\\]/);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new UnsafeRulePathError(value, 'сегменты «.», «..» и пустые запрещены.');
    }
  }

  const name = segments[segments.length - 1]!;
  if (!name.toLowerCase().endsWith(MDC_EXTENSION)) {
    throw new UnsafeRulePathError(value, `правило обязано оканчиваться на ${MDC_EXTENSION}.`);
  }
  if (name.length === MDC_EXTENSION.length) {
    throw new UnsafeRulePathError(value, 'имя правила пустое.');
  }

  const fullPath = join(target.rulesDir, ...segments);
  // Контрольная проверка после сборки: даже если что-то выше пропустило форму
  // пути, наружу каталога он уйти не должен.
  const rel = relative(target.rulesDir, fullPath);
  if (!rel || rel.startsWith('..') || looksAbsolute(rel)) {
    throw new UnsafeRulePathError(value, 'путь выходит за пределы каталога правил.');
  }

  assertNoSymlinkEscape(target.rulesDir, fullPath, value);
  return fullPath;
}

/**
 * Ни один сегмент между каталогом правил и целью не должен быть символической
 * ссылкой: через неё запись/удаление ушли бы наружу каталога. Сам каталог правил
 * ссылкой быть может — это осознанный выбор пользователя и корень доверия.
 */
function assertNoSymlinkEscape(rulesDir: string, fullPath: string, shown: string): void {
  let current = rulesDir;
  for (const segment of relative(rulesDir, fullPath).split(sep)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // дальше по пути ничего не существует — подменять нечего
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeRulePathError(shown, 'на пути есть символическая ссылка.');
    }
  }
}

/** Путь относительно каталога правил в клиентской форме (разделитель `/`). */
function toRelative(target: ProviderRulesTarget, fullPath: string): string {
  return relative(target.rulesDir, fullPath).split(sep).join('/');
}

// --- Чтение каталога ---------------------------------------------------------

/** Все файлы каталога правил: `.mdc` — правила, остальное — игнорируемое Cursor. */
function walkRulesDir(target: ProviderRulesTarget): {
  rules: string[];
  ignored: string[];
} {
  const rules: string[] = [];
  const ignored: string[] = [];
  let seen = 0;

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (seen >= MAX_ENTRIES) return;
      const full = join(dir, entry.name);
      // Символические ссылки не обходим вовсе: они могут вести наружу каталога,
      // а раздел обязан оставаться в его границах.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (entry.name.toLowerCase().endsWith(MDC_EXTENSION)) rules.push(full);
      else ignored.push(full);
    }
  };

  visit(target.rulesDir, 0);
  return { rules, ignored };
}

/** Размер файла в байтах; недоступен → 0 (лишь витрина, не решение о записи). */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Описать одно правило для списка: поля frontmatter или честная пометка о проблеме. */
function summarize(target: ProviderRulesTarget, fullPath: string): ProviderRuleSummary {
  const base = {
    path: toRelative(target, fullPath),
    fullPath,
    size: sizeOf(fullPath),
  };
  try {
    const { fields } = readMdcRule(readTextFile(fullPath));
    return { ...base, ...fields, frontmatterOk: true };
  } catch (error) {
    if (error instanceof MdcFormatError) {
      return { ...base, frontmatterOk: false, problem: error.problem };
    }
    throw error;
  }
}

/** Сводка раздела: правила, игнорируемые файлы и путь каталога. */
export function readProviderRulesInfo(target: ProviderRulesTarget): ProviderRulesInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    rulesDir: target.rulesDir,
    dirExists: existsSync(target.rulesDir),
  };

  if (!base.dirExists) return { ...base, rules: [], ignored: [], readOnly: false };

  try {
    const { rules, ignored } = walkRulesDir(target);
    return {
      ...base,
      rules: rules
        .map((full) => summarize(target, full))
        .sort((a, b) => a.path.localeCompare(b.path)),
      ignored: ignored
        .map((full): ProviderRulesIgnoredFile => ({
          path: toRelative(target, full),
          fullPath: full,
          size: sizeOf(full),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      readOnly: false,
    };
  } catch (error) {
    // Каталог не читается (права, гонка с удалением) — раздел на чтение, но
    // писать в него вслепую нельзя: fail-closed.
    return {
      ...base,
      rules: [],
      ignored: [],
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Прочитать ОДНО правило: поля frontmatter отдельно от markdown-тела.
 * Frontmatter не разобран (или его нет) → правило отдаётся ЦЕЛИКОМ как тело с
 * пометкой `readOnly` — прочитать можно, переписать нельзя.
 */
export function readProviderRule(target: ProviderRulesTarget, rawPath: string): ProviderRule {
  const fullPath = resolveRulePath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new RuleNotFoundError(rawPath);
  }
  if (sizeOf(fullPath) > MAX_RULE_BYTES) {
    throw new RuleNotEditableError(
      rawPath,
      'malformed',
      `Файл ${fullPath} слишком большой для правки в панели.`,
    );
  }

  const text = readTextFile(fullPath);
  const base = { path: toRelative(target, fullPath), fullPath };
  try {
    const rule = readMdcRule(text);
    return { ...base, ...rule.fields, body: rule.body, otherKeys: rule.otherKeys, readOnly: false };
  } catch (error) {
    if (error instanceof MdcFormatError) {
      return { ...base, body: text, otherKeys: [], readOnly: true, problem: error.problem };
    }
    throw error;
  }
}

/**
 * Разобрать черновик правила из тела запроса. Схему zod в рантайме сервера
 * использовать нельзя (значение из contracts роняет node ESM) — проверяем руками.
 * Некорректное тело → `undefined` (маршрут ответит 400).
 */
export function parseProviderRuleDraft(body: unknown): ProviderRuleDraft | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;

  if (typeof raw.path !== 'string' || !raw.path.trim()) return undefined;
  // Пустое тело — осознанно допустимо (правило может состоять из одного
  // frontmatter), а вот отсутствие поля значит «запрос неполон».
  if (typeof raw.body !== 'string') return undefined;
  if (raw.description !== undefined && typeof raw.description !== 'string') return undefined;
  if (raw.globs !== undefined && typeof raw.globs !== 'string') return undefined;
  if (raw.alwaysApply !== undefined && typeof raw.alwaysApply !== 'boolean') return undefined;
  // Перевод строки внутри однострочных полей frontmatter сломал бы форму записи.
  if (typeof raw.description === 'string' && /[\r\n]/.test(raw.description)) return undefined;
  if (typeof raw.globs === 'string' && /[\r\n]/.test(raw.globs)) return undefined;

  return {
    path: raw.path,
    body: raw.body,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.globs === 'string' ? { globs: raw.globs } : {}),
    ...(typeof raw.alwaysApply === 'boolean' ? { alwaysApply: raw.alwaysApply } : {}),
  };
}

/** Имя резервной копии правила: `<id>[-project]-<путь с «-» вместо «/»>`. */
function ruleBackupName(target: ProviderRulesTarget, fullPath: string): string {
  return `${target.backupPrefix}${toRelative(target, fullPath).split('/').join('-')}`;
}

/**
 * Создать или обновить правило: бэкап + атомарная запись + сохранение формы
 * файла (BOM/CRLF). Комментарии frontmatter и ключи, которыми панель не
 * управляет, сохраняются. Подкаталоги создаются ТОЛЬКО здесь — при явном
 * сохранении по такому пути.
 *
 * Существующий файл с неразобранным frontmatter НЕ переписывается —
 * `RuleNotEditableError` (маршрут ответит 422).
 */
export function saveProviderRule(
  target: ProviderRulesTarget,
  draft: ProviderRuleDraft,
  backupDir: string | undefined,
): { path: string; fullPath: string; backupPath?: string } {
  const fullPath = resolveRulePath(target, draft.path);
  const exists = existsSync(fullPath);
  if (exists && !statSync(fullPath).isFile()) {
    throw new UnsafeRulePathError(draft.path, 'по этому пути находится каталог, а не файл.');
  }

  const original = exists ? readTextFile(fullPath) : '';
  if (exists) {
    // Fail-closed: файл, который панель не понимает, она не переписывает.
    try {
      readMdcRule(original);
    } catch (error) {
      if (error instanceof MdcFormatError) {
        throw new RuleNotEditableError(
          draft.path,
          error.problem,
          `Правило ${fullPath} только для чтения: ${error.message}`,
        );
      }
      throw error;
    }
  }

  const fields: MdcFields = {
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.globs === undefined ? {} : { globs: draft.globs }),
    ...(draft.alwaysApply === undefined ? {} : { alwaysApply: draft.alwaysApply }),
  };

  const next = writeMdcRule(original, fields, draft.body);
  const backupPath = writeTextFile(fullPath, next, {
    backupDir,
    backupName: ruleBackupName(target, fullPath),
  });

  return { path: toRelative(target, fullPath), fullPath, ...(backupPath ? { backupPath } : {}) };
}

/**
 * Удалить правило: сначала резервная копия, потом удаление. Защита пути ровно та
 * же, что при записи (`..`, абсолютный путь, чужое расширение, ссылка в
 * сегменте — отказ). Опустевшие подкаталоги НЕ удаляем: они могут быть нужны
 * пользователю, а рекурсивная уборка чужого каталога — не наше дело.
 */
export function deleteProviderRule(
  target: ProviderRulesTarget,
  rawPath: string,
  backupDir: string | undefined,
): { path: string; backupPath?: string } {
  const fullPath = resolveRulePath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new RuleNotFoundError(rawPath);
  }

  const backupPath = backupDir
    ? backupEntry(fullPath, backupDir, ruleBackupName(target, fullPath))
    : undefined;
  removeEntry(fullPath);

  return { path: toRelative(target, fullPath), ...(backupPath ? { backupPath } : {}) };
}
