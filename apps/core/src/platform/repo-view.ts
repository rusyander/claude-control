import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact, type ReadOptions } from '../lib/facts/read-fact.ts';
import type {
  RepoDirEntry,
  RepoView,
  RepoViewFile,
  RepoViewIo,
  RepoViewSpec,
} from './repo-view.types.ts';

/**
 * Чтение входов обнаружения профиля (04:45-49, 04:102) — единственное место, где профиль
 * касается диска (P51: файловые операции только в платформе). Обход асинхронный: синхронный
 * держал бы цикл событий, и тайм-аут класса `profile.read` не сработал бы никогда. Любой сбой
 * посреди обхода (каталог исчез, EPERM, мусор) — `unknown` всего вида: половина дерева дала бы
 * профиль без половины стеков, а это хуже, чем «не знаю» (решение — прогон, 04:55).
 */

export const realRepoViewIo: RepoViewIo = {
  rootExists: async (path) => {
    // `throwIfNoEntry` у промисного stat нет — ENOENT ловится по коду и только он значит «нет».
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  },
  readdir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry): RepoDirEntry => ({
      name: entry.name,
      // Ссылки не разворачиваются: петля симлинков иначе съела бы весь бюджет обхода.
      dir: entry.isDirectory(),
      file: entry.isFile(),
    })),
  readFile: (path) => readFile(path),
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isEntryList(v: unknown): v is RepoDirEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as RepoDirEntry).name === 'string' &&
        typeof (e as RepoDirEntry).dir === 'boolean',
    )
  );
}

/**
 * Общий каталог git рабочего дерева, у которого `.git` — файл `gitdir: …` (копия единицы): хуки
 * и прочее общее лежат там, и вид копии смотрит в `.git` через него — так же, как вид основной
 * копии (иначе `.git/hooks/*` есть только у основной, и отпечаток входов у двух видов одного
 * репозитория разный). Файл без указателя — `undefined`: это просто файл. Нет `commondir` — сам
 * каталог указателя общий (подмодуль); иной сбой чтения — исключение, `unknown` всего вида (P44).
 */
async function commonDirOf(
  dotGit: string,
  root: string,
  io: RepoViewIo,
): Promise<string | undefined> {
  const text = (await io.readFile(dotGit)).toString('utf8');
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  if (!pointer) return undefined;
  const gitDir = resolve(root, pointer);
  try {
    const rel = (await io.readFile(join(gitDir, 'commondir'))).toString('utf8').trim();
    return rel ? resolve(gitDir, rel) : gitDir;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return gitDir;
    throw error;
  }
}

async function walk(root: string, spec: RepoViewSpec, io: RepoViewIo): Promise<RepoView> {
  const files: RepoViewFile[] = [];
  const dirs: string[] = [];
  const overCap: string[] = [];
  let seen = 0;
  let truncated = false;
  // `abs` — настоящий каталог на диске: у `.git` копии он — общий каталог git, а не `root/.git`.
  const queue: { rel: string; depth: number; abs: string }[] = [{ rel: '', depth: 0, abs: root }];
  while (queue.length > 0) {
    const { rel, depth, abs } = queue.shift() as { rel: string; depth: number; abs: string };
    const entries = await io.readdir(abs);
    // Негодный ответ каталога — исключение, а не пустой каталог: readFact сделает его `unknown`.
    if (!isEntryList(entries)) throw new Error(`garbage: directory listing of '${rel || '.'}'`);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      seen += 1;
      if (seen > spec.maxEntries) {
        truncated = true;
        break;
      }
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const enter = (): boolean =>
        depth + 1 <= spec.maxDepth && spec.enterDir(path, entry.name, depth + 1);
      if (entry.dir) {
        if (enter()) {
          dirs.push(path);
          queue.push({ rel: path, depth: depth + 1, abs: join(abs, entry.name) });
        }
        continue;
      }
      if (!entry.file) continue;
      if (path === '.git' && enter()) {
        const common = await commonDirOf(join(abs, entry.name), root, io);
        if (common) {
          dirs.push(path);
          queue.push({ rel: path, depth: depth + 1, abs: common });
          continue;
        }
      }
      const kind = spec.inputKind(path, entry.name);
      if (!kind) continue;
      const bytes = await io.readFile(join(abs, entry.name));
      if (!Buffer.isBuffer(bytes)) throw new Error(`garbage: content of '${path}'`);
      const text =
        kind === 'text' && bytes.length <= spec.maxTextBytes ? bytes.toString('utf8') : null;
      if (kind === 'text' && text === null) overCap.push(path);
      files.push({ path, sha: sha256(bytes), bytes: bytes.length, text });
    }
    if (truncated) break;
  }
  return { files, dirs, truncated, overCap };
}

/** Вид репозитория под классом `profile.read`: нет корня — `absent`, сбой — `unknown`. */
export function readRepoView(
  root: string,
  spec: RepoViewSpec,
  io: RepoViewIo = realRepoViewIo,
  options: ReadOptions<RepoView> = {},
): Promise<Fact<RepoView>> {
  return readFact(
    'profile.read',
    async () => {
      if (!(await io.rootExists(root))) return absent();
      return walk(root, spec, io);
    },
    options,
  );
}
