import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ClaudeLocation } from '@agentdeck/contracts';
import { createConfigSandbox } from '../../lib/config-sandbox.ts';
import { readJsonFile, removeEntry, writeJsonFile } from '../../lib/safe-io.ts';
import { unifiedDiff } from './unified-diff.ts';

/**
 * Общие приёмы предпросмотра: копия файла, дифф «было → станет», признак
 * переформатирования JSON. Живут отдельно от `config-preview.ts`, потому что
 * ими пользуются оба набора видов (правила/скиллы/права/MCP и хуки/env/скрипты/
 * инструкции) — второй копии этих приёмов быть не должно.
 */

export type ClaudePaths = ClaudeLocation['paths'];

export interface ConfigPreviewFile {
  /** Настоящий путь файла, который изменится. */
  path: string;
  exists: boolean;
  unchanged: boolean;
  added: number;
  removed: number;
  /** Унифицированный дифф, значения секретов скрыты. */
  diff: string;
  truncated: boolean;
  /**
   * Писатель JSON переписывает файл целиком своим форматом (отступ 2): у файла,
   * набранного иначе, часть строк диффа меняет только форму. Карточка обязана
   * это назвать, иначе смысловая строка тонет среди переотступленных соседей.
   */
  reformatted?: boolean;
}

/** Ошибка с кодом для Fastify — как у доменных ошибок записи. */
export const failure = (statusCode: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { statusCode, code });

export const readText = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

export function fileDiff(
  path: string,
  before: string,
  after: string,
  exists: boolean,
): ConfigPreviewFile {
  const diff = unifiedDiff(path, before, after);
  return { path, exists, unchanged: before === after, ...diff };
}

/** Дифф с отметкой переформатирования для существующего JSON. */
function withShape(file: ConfigPreviewFile, path: string, existed: boolean): ConfigPreviewFile {
  return !file.unchanged && existed && path.endsWith('.json') && reformatsJson(path)
    ? { ...file, reformatted: true }
    : file;
}

/** Операция по копии одного файла: сравниваем копию после записи с оригиналом. */
export function onCopy(path: string, apply: (copy: string) => void): ConfigPreviewFile {
  const sandbox = createConfigSandbox(path);
  try {
    apply(sandbox.path);
    const file = fileDiff(path, readText(path), readText(sandbox.path), sandbox.existed);
    return withShape(file, path, sandbox.existed);
  } finally {
    sandbox.dispose();
  }
}

/**
 * Перепишет ли писатель файл, не меняя в нём ни одного значения. Проверка — тем
 * же `writeJsonFile` по второй копии, а не догадкой о форматировании: форму
 * (BOM, CRLF, хвост) писатель сохраняет сам, и сравнивать нужно с ним.
 */
export function reformatsJson(path: string): boolean {
  const sandbox = createConfigSandbox(path);
  try {
    const data = readJsonFile<unknown>(sandbox.path, undefined);
    if (data === undefined) return false;
    writeJsonFile(sandbox.path, data);
    return readText(sandbox.path) !== readText(path);
  } catch {
    return false;
  } finally {
    sandbox.dispose();
  }
}

/** Файлы конфигурации, которые копируются в песочницу набора путей. */
type SandboxFile = 'settings' | 'settingsLocal' | 'secretsEnv' | 'claudeMd' | 'mcpConfig';

/**
 * Операция по копии НЕСКОЛЬКИХ файлов разом — для писателей, которые сами
 * выбирают файл (переменная уходит в settings.json, settings.local.json или файл
 * секретов; выключение хука перечитывает оба файла настроек). Писатель получает
 * полный набор путей, где названные файлы указывают в песочницу, а каталоги
 * (`hooks`, `skills`) — в пустые временные: запись мимо песочницы невозможна.
 * Возвращаются только изменившиеся файлы — под настоящими путями.
 */
export function onCopies(
  paths: ClaudePaths,
  files: readonly SandboxFile[],
  apply: (sandboxPaths: ClaudePaths) => void,
): ConfigPreviewFile[] {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-preview-'));
  try {
    const sandboxPaths: ClaudePaths = {
      ...paths,
      root,
      hooks: join(root, 'hooks'),
      skills: join(root, 'skills'),
      appData: join(root, 'app-data'),
    };
    const existed = new Map<SandboxFile, boolean>();
    for (const key of files) {
      const real = paths[key];
      const copy = join(root, `${key}-${basename(real)}`);
      existed.set(key, existsSync(real));
      if (existsSync(real)) copyFileSync(real, copy);
      sandboxPaths[key] = copy;
    }
    apply(sandboxPaths);
    return files.flatMap((key) => {
      const real = paths[key];
      const before = readText(real);
      const after = readText(sandboxPaths[key]);
      if (before === after) return [];
      return [withShape(fileDiff(real, before, after, existed.get(key) ?? false), real, true)];
    });
  } finally {
    removeEntry(root);
  }
}
