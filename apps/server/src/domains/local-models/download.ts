import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { localError } from './errors.ts';
import type { JobHandle } from './jobs.ts';

/**
 * Файлы с чужих серверов: сборка llama.cpp с GitHub и GGUF-модели с Hugging Face.
 *
 * Общее у обоих — докачка (`Range`), проверка контрольной суммы и распаковка
 * системным `tar`. Сумма всегда берётся у самого хранилища (`digest` ассета
 * GitHub, `lfs.oid` файла Hugging Face), а не из файла рядом с архивом: файл
 * рядом лежит там же, где архив, и подменяется вместе с ним.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Скачать файл с докачкой. Недокачанное лежит рядом как `.part`; повторный
 * запуск просит у сервера только хвост (`Range`). Сервер Range не понял (200
 * вместо 206) — начинаем заново, а не пишем полный файл в хвост обрывка.
 */
export async function downloadResumable(
  url: string,
  dest: string,
  size: number,
  handle: Pick<JobHandle, 'progress' | 'signal'>,
  base: { done: number; total: number },
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const part = `${dest}.part`;
  if (existsSync(dest) && statSync(dest).size === size) {
    handle.progress({ doneBytes: base.done + size });
    return;
  }
  mkdirSync(join(dest, '..'), { recursive: true });
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > size) {
    rmSync(part);
    have = 0;
  }
  const headers: Record<string, string> = { 'user-agent': 'agentdeck' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const response = await fetchImpl(url, { headers, signal: handle.signal, redirect: 'follow' });
  if (!response.ok || !response.body)
    throw localError('local-download-http', `загрузка не удалась: HTTP ${response.status}`, {
      status: response.status,
    });
  const resumed = response.status === 206;
  if (!resumed) have = 0;
  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  let done = have;
  handle.progress({ doneBytes: base.done + done });
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (handle.signal.aborted) throw localError('local-download-cancelled', 'загрузка отменена');
      done += chunk.byteLength;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      handle.progress({ doneBytes: base.done + done });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  if (done !== size)
    throw localError(
      'local-download-cut',
      `загрузка оборвалась: ${done} из ${size} байт — нажмите ещё раз, докачается`,
      { done, size },
    );
  renameSync(part, dest);
}

/**
 * Проверить файл по сумме. Испорченный удаляется: докачка поверх него дала бы
 * тот же испорченный файл, а «нажмите ещё раз» начинает честно с нуля.
 */
export async function verifySha256(path: string, expected: string, name: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual === expected.toLowerCase()) return;
  rmSync(path, { force: true });
  throw localError(
    'local-checksum-mismatch',
    `контрольная сумма ${name} не сошлась — файл удалён, нажмите ещё раз`,
    { name },
  );
}

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24 }, (error, _stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(),
    );
  });

/**
 * Какой `tar` звать. На Windows — тот, что лежит в System32 (bsdtar, понимает zip):
 * первым в PATH из Git Bash стоит GNU tar, который zip не открывает вовсе
 * («This does not look like a tar archive» — замер 13.10).
 */
export function tarCommand(os: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (os !== 'win32') return 'tar';
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const system = join(root, 'System32', 'tar.exe');
  return existsSync(system) ? system : 'tar';
}

/** Распаковать архив (zip или tar.gz) системным `tar`. */
export async function extractArchive(
  archive: string,
  dest: string,
  os: NodeJS.Platform = process.platform,
): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await run(tarCommand(os), ['-xf', archive, '-C', dest]);
}
