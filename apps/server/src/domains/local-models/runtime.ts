import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
// Пространством имён, а не именованным импортом: `createZstdDecompress` есть с Node 22.15,
// а на 22.6–22.14 именованный импорт ронял загрузку всего сервера на любой системе.
import * as zlib from 'node:zlib';
import type { HardwareGpu, RuntimeSource } from '@agentdeck/contracts/local-models';
import { localError } from './errors.ts';
import type { JobHandle } from './jobs.ts';
import type { FetchLike } from './ollama-client.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Сервер моделей: чей исполняемый файл и как его получить одной кнопкой.
 *
 * Ollama уже стоит в системе — берём ЕГО файл, но поднимаем СВОЙ сервер (свой
 * порт, свой каталог моделей): качать полтора гигабайта ради того, что уже
 * лежит на диске, незачем, а модели всё равно ложатся в каталог панели. Не
 * стоит — качаем переносную сборку с GitHub в `.local-models/runtime`, без
 * установщика и без прав администратора, с докачкой и проверкой контрольной
 * суммы из `sha256sum.txt` того же выпуска.
 *
 * Версию НЕ спрашиваем у `ollama --version`: на Windows эта команда, не найдя
 * сервера, сама запускает приложение Ollama пользователя (проверено 05.10.2026 на
 * 0.35.0). Версию говорит `/api/version` уже нашего сервера.
 */

/** Наименьшая версия, знающая все модели каталога (Qwen3.8 — 0.32.12); живёт в контрактах — её показывает и страница. */
export { MIN_OLLAMA_VERSION } from '@agentdeck/contracts/local-models';
const RELEASES_URL = 'https://api.github.com/repos/ollama/ollama/releases/latest';

export function binaryName(os: NodeJS.Platform): string {
  return os === 'win32' ? 'ollama.exe' : 'ollama';
}

function fixedCandidates(os: NodeJS.Platform, env: NodeJS.ProcessEnv, name: string): string[] {
  if (os === 'win32') {
    return [
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Ollama', name) : '',
      env.ProgramFiles ? join(env.ProgramFiles, 'Ollama', name) : '',
    ];
  }
  if (os === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}

/** Где обычно стоит Ollama пользователя. PATH дописывается к этому списку. */
export function systemCandidates(os: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const name = binaryName(os);
  const fixed = fixedCandidates(os, env, name);
  const fromPath = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name));
  return [...fixed, ...fromPath].filter(Boolean);
}

export function findSystemBinary(
  os: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): string {
  return systemCandidates(os, env).find((path) => exists(path)) ?? '';
}

/** Самая свежая своя сборка в `runtime/`: каталоги `ollama-<версия>`. */
export function findPanelBinary(paths: LocalPaths, os: NodeJS.Platform): string {
  if (!existsSync(paths.runtime)) return '';
  const dirs = readdirSync(paths.runtime)
    .filter((name) => /^ollama-\d/.test(name) && !name.endsWith('.tmp'))
    .sort((a, b) => compareVersions(b.slice(7), a.slice(7)));
  for (const dir of dirs) {
    const found = locateBinary(join(paths.runtime, dir), os);
    if (found) return found;
  }
  return '';
}

/** Архивы кладут файл по-разному: Windows — в корень, Linux — в `bin/`. */
export function locateBinary(dir: string, os: NodeJS.Platform): string {
  const name = binaryName(os);
  for (const candidate of [join(dir, name), join(dir, 'bin', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export function pickRuntime(
  system: string,
  panel: string,
  preferPanel: boolean,
): { source: RuntimeSource; binary: string } {
  if (preferPanel && panel) return { source: 'panel', binary: panel };
  if (system) return { source: 'system', binary: system };
  if (panel) return { source: 'panel', binary: panel };
  return { source: 'none', binary: '' };
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Какие архивы выпуска нужны этой машине. AMD на Windows — второй архив с ROCm поверх. */
export function assetsFor(os: NodeJS.Platform, cpu: string, gpus: HardwareGpu[]): string[] {
  const amd = gpus.some((gpu) => gpu.vendor === 'amd');
  if (os === 'win32') {
    if (cpu === 'arm64') return ['ollama-windows-arm64.zip'];
    return amd
      ? ['ollama-windows-amd64.zip', 'ollama-windows-amd64-rocm.zip']
      : ['ollama-windows-amd64.zip'];
  }
  if (os === 'darwin') return ['ollama-darwin.tgz'];
  if (cpu === 'arm64') return ['ollama-linux-arm64.tar.zst'];
  return amd
    ? ['ollama-linux-amd64.tar.zst', 'ollama-linux-amd64-rocm.tar.zst']
    : ['ollama-linux-amd64.tar.zst'];
}

export interface ReleaseInfo {
  version: string;
  assets: { name: string; size: number; url: string }[];
}

export async function fetchLatestRelease(fetchImpl: FetchLike = fetch): Promise<ReleaseInfo> {
  const response = await fetchImpl(RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentdeck' },
  });
  if (!response.ok)
    throw localError(
      'local-release-http',
      `GitHub ответил ${response.status} на запрос выпуска Ollama`,
      { status: response.status },
    );
  const body = (await response.json()) as {
    tag_name: string;
    assets: { name: string; size: number; browser_download_url: string }[];
  };
  return {
    version: body.tag_name.replace(/^v/, ''),
    assets: body.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
  };
}

/** `sha256sum.txt`: «<хеш>  ./<имя>» — строка на архив. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(?:\.\/)?(\S+)$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

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

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24 }, (error, _stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(),
    );
  });

/**
 * Распаковать системным `tar`: он есть везде — на Windows 10+ это bsdtar,
 * который понимает и zip. `.tar.zst` сначала разжимается своим zlib (Node 22.15+):
 * GNU tar без программы zstd его не откроет. На Node постарше — `tar --zstd`: ему нужна
 * программа zstd в системе.
 */
export async function extractArchive(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  if (archive.endsWith('.tar.zst')) {
    const decompress = (zlib as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
      .createZstdDecompress;
    if (!decompress) {
      await run('tar', ['--zstd', '-xf', archive, '-C', dest]);
      return;
    }
    const tar = archive.slice(0, -'.zst'.length);
    await pipeline(createReadStream(archive), decompress(), createWriteStream(tar));
    try {
      await run('tar', ['-xf', tar, '-C', dest]);
    } finally {
      rmSync(tar, { force: true });
    }
    return;
  }
  await run('tar', ['-xf', archive, '-C', dest]);
}

/**
 * Поставить свою сборку: выпуск → архивы → контрольные суммы → распаковка во
 * временный каталог → переименование. Переименованием, а не распаковкой на
 * место: оборванная распаковка не должна выглядеть установленным сервером.
 */
export async function installPanelRuntime(input: {
  paths: LocalPaths;
  os: NodeJS.Platform;
  cpu: string;
  gpus: HardwareGpu[];
  handle: JobHandle;
  fetchImpl?: FetchLike;
  extract?: (archive: string, dest: string) => Promise<void>;
}): Promise<string> {
  const { paths, handle } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  handle.progress({ phase: 'release' });
  const release = await fetchLatestRelease(fetchImpl);
  const names = assetsFor(input.os, input.cpu, input.gpus);
  const assets = names.map((name) => {
    const asset = release.assets.find((item) => item.name === name);
    if (!asset)
      throw localError(
        'local-asset-missing',
        `в выпуске Ollama ${release.version} нет файла ${name}`,
        { version: release.version, name },
      );
    return asset;
  });
  const sumsAsset = release.assets.find((item) => item.name === 'sha256sum.txt');
  if (!sumsAsset)
    throw localError(
      'local-sums-missing',
      `в выпуске Ollama ${release.version} нет sha256sum.txt`,
      { version: release.version },
    );
  const sumsResponse = await fetchImpl(sumsAsset.url, { headers: { 'user-agent': 'agentdeck' } });
  if (!sumsResponse.ok)
    throw localError('local-download-http', `загрузка не удалась: HTTP ${sumsResponse.status}`, {
      status: sumsResponse.status,
    });
  const sums = parseSha256Sums(await sumsResponse.text());

  mkdirSync(paths.downloads, { recursive: true });
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  handle.progress({ phase: 'download', totalBytes: total, doneBytes: 0 });
  let done = 0;
  const files: string[] = [];
  for (const asset of assets) {
    const dest = join(paths.downloads, asset.name);
    await downloadResumable(asset.url, dest, asset.size, handle, { done, total }, fetchImpl);
    done += asset.size;
    files.push(dest);
  }

  handle.progress({ phase: 'verify' });
  for (const file of files) {
    const name = file.slice(paths.downloads.length + 1);
    const expected = sums.get(name);
    if (!expected)
      throw localError('local-checksum-missing', `для ${name} нет контрольной суммы в выпуске`, {
        name,
      });
    const actual = await sha256File(file);
    if (actual !== expected) {
      // Испорченный файл удаляем: докачка поверх него дала бы тот же испорченный.
      rmSync(file, { force: true });
      throw localError(
        'local-checksum-mismatch',
        `контрольная сумма ${name} не сошлась — файл удалён, нажмите ещё раз`,
        { name },
      );
    }
  }

  handle.progress({ phase: 'extract' });
  const final = join(paths.runtime, `ollama-${release.version}`);
  const temp = `${final}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  for (const file of files) await (input.extract ?? extractArchive)(file, temp);
  if (!locateBinary(temp, input.os))
    throw localError(
      'local-binary-missing',
      'в распакованном архиве нет исполняемого файла ollama',
    );
  rmSync(final, { recursive: true, force: true });
  renameSync(temp, final);
  for (const file of files) rmSync(file, { force: true });
  writeFileSync(
    join(final, 'agentdeck-release.json'),
    JSON.stringify({ version: release.version }),
  );
  return locateBinary(final, input.os);
}

/** Версия своей сборки по метке распаковки — до первого подъёма сервера. */
export function panelRuntimeVersion(binary: string): string {
  for (const dir of [join(binary, '..'), join(binary, '..', '..')]) {
    const file = join(dir, 'agentdeck-release.json');
    if (existsSync(file)) {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '';
      } catch {
        return '';
      }
    }
  }
  return '';
}
