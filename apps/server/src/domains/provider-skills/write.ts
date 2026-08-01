import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ProviderSkillDraft } from '@claude-control/contracts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  SkillFormatError,
  checkSkillDescription,
  checkSkillName,
  readOpencodeSkill,
  writeOpencodeSkill,
} from '../../lib/opencode-skill.ts';
import {
  InvalidSkillDraftError,
  SkillNotEditableError,
  SkillNotFoundError,
  UnsafeSkillPathError,
} from './errors.ts';
import { resolveSkillPath, skillBackupName, toRelative } from './paths.ts';
import type { ProviderSkillsTarget } from './types.ts';

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
