import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * Файлы, созданные Claude в рабочей папке чата. Для интерфейса это «артефакты»:
 * страницу или документ нужно показать в предпросмотре, а не отдавать ссылкой
 * на файл. Тип превью выбирается по расширению — от него зависит, рисуем мы
 * страницу, размеченный текст, документ или подсвеченный код.
 */

export type ArtifactKind = 'html' | 'markdown' | 'pdf' | 'image' | 'code' | 'data' | 'other';

export interface Artifact {
  name: string;
  path: string;
  kind: ArtifactKind;
  sizeBytes: number;
  modifiedAt: string;
  /** Показывать ли вкладку с исходником рядом с предпросмотром. */
  hasSource: boolean;
}

const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.json': 'data',
  '.csv': 'data',
  '.yml': 'data',
  '.yaml': 'data',
};

const CODE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.ps1',
  '.css',
  '.scss',
  '.sql',
  '.txt',
]);

/** Размер, выше которого содержимое не отдаётся: браузеру такое не нужно. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export function readArtifacts(chatDir: string): Artifact[] {
  if (!existsSync(chatDir)) return [];

  return readdirSync(chatDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(chatDir, entry.name);
      const stats = statSync(path);
      const kind = detectKind(entry.name);

      return {
        name: entry.name,
        path,
        kind,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        // У картинок и документов исходника нет, у разметки и кода — есть.
        hasSource: kind !== 'image' && kind !== 'pdf',
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function detectKind(name: string): ArtifactKind {
  const extension = extname(name).toLowerCase();
  if (KIND_BY_EXTENSION[extension]) return KIND_BY_EXTENSION[extension];
  return CODE_EXTENSIONS.has(extension) ? 'code' : 'other';
}

/** Текст артефакта — для вкладки с исходником и разметки. */
export function readArtifactText(chatDir: string, name: string): string {
  const path = safePath(chatDir, name);
  if (!existsSync(path) || statSync(path).size > MAX_INLINE_BYTES) return '';
  return readFileSync(path, 'utf8');
}

/** Двоичное содержимое — картинки и PDF отдаются как есть. */
export function readArtifactBinary(chatDir: string, name: string): Buffer | undefined {
  const path = safePath(chatDir, name);
  return existsSync(path) ? readFileSync(path) : undefined;
}

/**
 * Рабочая папка чата.
 *
 * Она намеренно лежит вне каталога `.claude`: Claude Code считает свой каталог
 * защищённым и запрещает туда запись, поэтому артефакты там просто не
 * создавались бы. Держим их рядом, в отдельной папке пользователя.
 */
export function chatDirectory(chatId: string): string {
  const dir = join(homedir(), '.claude-control', 'chats', chatId.replace(/[^a-zA-Z0-9-]/g, ''));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Имя файла приходит из запроса, поэтому от него берётся только имя: иначе
 * через «..» можно было бы прочитать файл за пределами папки чата.
 */
function safePath(chatDir: string, name: string): string {
  return join(chatDir, basename(name));
}

/**
 * Переезд папки нового чата под настоящий идентификатор сессии.
 *
 * До первого ответа идентификатора сессии не существует, и папка заводится под
 * временным именем. Как только Claude Code выдал свой — переносим, иначе
 * созданные файлы остались бы в папке, которую больше никто не откроет.
 */
export function renameChatDirectory(fromId: string, toId: string): void {
  if (fromId === toId) return;

  const from = chatDirectory(fromId);
  const to = chatDirectory(toId);

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile()) renameSync(join(from, entry.name), join(to, entry.name));
  }

  rmSync(from, { recursive: true, force: true });
}
