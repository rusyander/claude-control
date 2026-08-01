import { existsSync, statSync } from 'node:fs';
import type { ProviderRuleDraft } from '@claude-control/contracts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { MdcFormatError, readMdcRule, writeMdcRule, type MdcFields } from '../../lib/cursor-mdc.ts';
import { RuleNotEditableError, RuleNotFoundError, UnsafeRulePathError } from './errors.ts';
import { resolveRulePath, ruleBackupName, toRelative } from './paths.ts';
import type { ProviderRulesTarget } from './types.ts';

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
