import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Artifact } from '@claude-control/contracts';

/**
 * Файлы, созданные Claude в рабочей папке чата. Для интерфейса это «артефакты»:
 * страницу или документ нужно показать в предпросмотре, а не отдавать ссылкой
 * на файл. Тип превью выбирается по расширению — от него зависит, рисуем мы
 * страницу, размеченный текст, документ или подсвеченный код.
 *
 * Сама форма ответа описана контрактом (`Artifact`), поэтому здесь она не
 * переобъявляется: своё имя было бы вторым таким же типом в репозитории.
 */

export type ArtifactKind = Artifact['kind'];

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
 * Удалить артефакт из папки чата. Имя приходит из запроса, поэтому от него, как
 * и при чтении, берётся только `basename`: выйти через `../` за пределы папки
 * чата нельзя. Удаляем лишь обычный файл; папки не трогаем. Вызывающий сам
 * ограничивает это песочницей — в настоящем проекте удалять ничего нельзя.
 */
export function deleteArtifact(chatDir: string, name: string): boolean {
  const path = safePath(chatDir, name);
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  rmSync(path);
  return true;
}

/**
 * Рабочая папка чата.
 *
 * Она намеренно лежит вне каталога `.claude`: Claude Code считает свой каталог
 * защищённым и запрещает туда запись, поэтому артефакты там просто не
 * создавались бы. Держим их рядом, в отдельной папке пользователя.
 */
export function chatDirectory(chatId: string, create = true): string {
  const dir = join(sandboxRoot(), chatId.replace(/[^a-zA-Z0-9-]/g, ''));
  // Читающие запросы папку не заводят: иначе каждый открытый черновик
  // оставлял бы за собой пустой каталог.
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Корень песочницы — папки чатов, заведённых в самой панели. */
export function sandboxRoot(): string {
  return join(homedir(), '.claude-control', 'chats');
}

/**
 * Лежит ли путь внутри песочницы. По этому признаку решается главное: свои
 * чаты пишут файлы свободно, а разговор из настоящего проекта по умолчанию
 * ничего в нём не меняет.
 */
export function isSandboxPath(path: string): boolean {
  // Путь приходит из транскрипта, а туда один и тот же каталог попадает в
  // разном написании — буква диска то строчная, то заглавная. Без приведения
  // регистра своя же папка перестаёт опознаваться как песочница, и Claude
  // теряет право писать файлы там, где они и есть результат работы.
  const normalize = (value: string): string =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

  const root = normalize(sandboxRoot());
  const target = normalize(path);
  return target === root || target.startsWith(root + sep);
}

/**
 * Имя файла приходит из запроса, поэтому от него берётся только имя: иначе
 * через «..» можно было бы прочитать файл за пределами папки чата.
 */
function safePath(chatDir: string, name: string): string {
  return join(chatDir, basename(name));
}

/*
 * Папку чата намеренно не переименовываем под идентификатор сессии.
 *
 * Раньше она переезжала с временного имени на выданный sessionId — и ровно это
 * рвало разговор: сессия Claude Code привязана к каталогу, из которого её
 * начали, а после переезда `--resume` искал её уже в другом месте и отвечал
 * «No conversation found». Папка остаётся на месте, а найти её по чату всегда
 * можно через сам транскрипт (см. findSessionCwd).
 */
