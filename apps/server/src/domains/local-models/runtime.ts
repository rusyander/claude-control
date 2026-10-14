import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HardwareGpu, RuntimeSource } from '@agentdeck/contracts/local-models';
import { MIN_LLAMA_BUILD } from '@agentdeck/contracts/local-models';
import { downloadResumable, extractArchive, verifySha256, type FetchLike } from './download.ts';
import { localError } from './errors.ts';
import type { RunCommand } from './hardware.ts';
import type { JobHandle } from './jobs.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Сервер моделей: `llama-server` из сборки llama.cpp, которую панель сама
 * скачивает в `.local-models/runtime/llama-<тег>/`.
 *
 * Свою сборку, а не найденную в системе, по двум причинам. Ollama человека
 * панель не трогает и не запускает вовсе (владелец 13.10), а `llama-server` в
 * системе, если он есть, — неизвестной версии и без нужных флагов. Тег сборки
 * закреплён в `data/llama-release.json`: обновление — осознанная правка того
 * файла вместе с проверкой флагов по `--help` новой сборки, а не «последняя».
 *
 * Контрольная сумма — `digest` ассета в ответе GitHub (`sha256:<хеш>`), то есть
 * считанная самим GitHub при загрузке файла в выпуск.
 */

export interface LlamaRelease {
  repo: string;
  tag: string;
  checkedAt: string;
}

export function loadRelease(): LlamaRelease {
  return JSON.parse(
    readFileSync(new URL('./data/llama-release.json', import.meta.url), 'utf8'),
  ) as LlamaRelease;
}

/** Номер сборки из тега: `b11583` → 11583. */
export function buildNumber(tag: string): number {
  return Number.parseInt(tag.replace(/^b/, ''), 10) || 0;
}

/** Устарела ли сборка: старше той, на которую рассчитан каталог. */
export function isOutdated(tag: string): boolean {
  return Boolean(tag) && buildNumber(tag) < MIN_LLAMA_BUILD;
}

export function binaryName(os: NodeJS.Platform): string {
  return os === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** `LLAMA_SERVER_BINARY` — путь к своему `llama-server` (для проверок и тех, кому нужна другая сборка). */
export function envBinary(env: NodeJS.ProcessEnv, exists = existsSync): string {
  const path = env.LLAMA_SERVER_BINARY?.trim();
  return path && exists(path) ? path : '';
}

/** Самая свежая своя сборка в `runtime/`: каталоги `llama-b<номер>`. */
export function findPanelBinary(paths: LocalPaths, os: NodeJS.Platform): string {
  if (!existsSync(paths.runtime)) return '';
  const dirs = readdirSync(paths.runtime)
    .filter((name) => /^llama-b\d+$/.test(name))
    .sort((a, b) => buildNumber(b.slice(6)) - buildNumber(a.slice(6)));
  for (const dir of dirs) {
    const found = locateBinary(join(paths.runtime, dir), os);
    if (found) return found;
  }
  return '';
}

/** Архивы кладут файл по-разному: Windows — в корень, Linux и macOS — в каталог `llama-<тег>/`. */
export function locateBinary(dir: string, os: NodeJS.Platform): string {
  const name = binaryName(os);
  if (existsSync(join(dir, name))) return join(dir, name);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return '';
  }
  for (const entry of entries) {
    const nested = join(dir, entry, name);
    if (existsSync(nested)) return nested;
  }
  return '';
}

export function pickRuntime(
  override: string,
  panel: string,
): { source: RuntimeSource; binary: string } {
  if (override) return { source: 'system', binary: override };
  if (panel) return { source: 'panel', binary: panel };
  return { source: 'none', binary: '' };
}

/** Версия CUDA, которую поддерживает драйвер: строка `CUDA Version: 13.4` в выводе `nvidia-smi`. */
export async function detectCudaVersion(run: RunCommand): Promise<[number, number] | undefined> {
  let text: string;
  try {
    text = await run('nvidia-smi', []);
  } catch {
    return undefined;
  }
  const match = /CUDA (?:UMD )?Version:\s*(\d+)\.(\d+)/i.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export interface AssetNeed {
  /** Имя ассета выпуска. */
  name: string;
  /** Что в нём: сам сервер или библиотеки CUDA, без которых он видеокарту не откроет. */
  role: 'server' | 'cudart';
}

/**
 * Какие файлы выпуска нужны этой машине. NVIDIA — сборка CUDA под версию драйвера
 * (13.4, если драйвер её знает, иначе 12.x) и отдельный архив с библиотеками CUDA:
 * без него `ggml-cuda.dll` не загружается и сервер молча считает на процессоре.
 * Остальные видеокарты — Vulkan, он есть в сборках под Windows и Linux; Mac —
 * сборка с Metal; карты нет — процессорная.
 */
export function assetsFor(
  tag: string,
  os: NodeJS.Platform,
  cpu: string,
  gpus: Pick<HardwareGpu, 'vendor'>[],
  cuda?: [number, number],
): AssetNeed[] {
  const arm = cpu === 'arm64';
  const nvidia = gpus.some((gpu) => gpu.vendor === 'nvidia');
  const other = gpus.some((gpu) => gpu.vendor === 'amd' || gpu.vendor === 'intel');
  const server = (suffix: string, ext: string): AssetNeed => ({
    name: `llama-${tag}-bin-${suffix}.${ext}`,
    role: 'server',
  });
  if (os === 'darwin') return [server(arm ? 'macos-arm64' : 'macos-x64', 'tar.gz')];
  if (os === 'win32') {
    if (arm) return [server('win-cpu-arm64', 'zip')];
    if (nvidia) {
      const version = cuda && (cuda[0] > 13 || (cuda[0] === 13 && cuda[1] >= 4)) ? '13.4' : '12.4';
      return [
        server(`win-cuda-${version}-x64`, 'zip'),
        { name: `cudart-llama-bin-win-cuda-${version}-x64.zip`, role: 'cudart' },
      ];
    }
    return [server(other ? 'win-vulkan-x64' : 'win-cpu-x64', 'zip')];
  }
  if (arm) return [server('ubuntu-arm64', 'tar.gz')];
  if (nvidia) {
    const version = cuda && (cuda[0] > 13 || (cuda[0] === 13 && cuda[1] >= 4)) ? '13.4' : '12.8';
    return [
      server(`ubuntu-cuda-${version}-x64`, 'tar.gz'),
      { name: `cudart-llama-${tag}-bin-ubuntu-cuda-${version}-x64.tar.gz`, role: 'cudart' },
    ];
  }
  return [server(other ? 'ubuntu-vulkan-x64' : 'ubuntu-x64', 'tar.gz')];
}

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** Сумма из `digest` ассета (`sha256:<хеш>`); пусто — GitHub её не назвал. */
  sha256: string;
}

export interface ReleaseInfo {
  tag: string;
  assets: ReleaseAsset[];
}

/** Выпуск по закреплённому тегу. */
export async function fetchRelease(
  release: LlamaRelease,
  fetchImpl: FetchLike = fetch,
): Promise<ReleaseInfo> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${release.repo}/releases/tags/${release.tag}`,
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentdeck' } },
  );
  if (!response.ok)
    throw localError(
      'local-release-http',
      `GitHub ответил ${response.status} на запрос выпуска llama.cpp`,
      { status: response.status },
    );
  const body = (await response.json()) as {
    tag_name: string;
    assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
  };
  return {
    tag: body.tag_name,
    assets: body.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
      sha256: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase() ?? '',
    })),
  };
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
  gpus: Pick<HardwareGpu, 'vendor'>[];
  cuda?: [number, number];
  release: LlamaRelease;
  handle: JobHandle;
  fetchImpl?: FetchLike;
  extract?: (archive: string, dest: string) => Promise<void>;
}): Promise<string> {
  const { paths, handle, release } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  handle.progress({ phase: 'release' });
  const info = await fetchRelease(release, fetchImpl);
  const assets = assetsFor(release.tag, input.os, input.cpu, input.gpus, input.cuda).map((need) => {
    const asset = info.assets.find((item) => item.name === need.name);
    if (!asset)
      throw localError(
        'local-asset-missing',
        `в выпуске llama.cpp ${info.tag} нет файла ${need.name}`,
        { version: info.tag, name: need.name },
      );
    if (!asset.sha256)
      throw localError(
        'local-sums-missing',
        `у файла ${need.name} в выпуске нет контрольной суммы`,
        {
          version: info.tag,
        },
      );
    return asset;
  });

  mkdirSync(paths.downloads, { recursive: true });
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  handle.progress({ phase: 'download', totalBytes: total, doneBytes: 0 });
  let done = 0;
  const files: { path: string; asset: ReleaseAsset }[] = [];
  for (const asset of assets) {
    const dest = join(paths.downloads, asset.name);
    await downloadResumable(asset.url, dest, asset.size, handle, { done, total }, fetchImpl);
    done += asset.size;
    files.push({ path: dest, asset });
  }

  handle.progress({ phase: 'verify' });
  for (const file of files) await verifySha256(file.path, file.asset.sha256, file.asset.name);

  handle.progress({ phase: 'extract' });
  const final = join(paths.runtime, `llama-${info.tag}`);
  const temp = `${final}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  for (const file of files)
    await (input.extract ?? ((archive, dest) => extractArchive(archive, dest, input.os)))(
      file.path,
      temp,
    );
  if (!locateBinary(temp, input.os))
    throw localError(
      'local-binary-missing',
      `в распакованном архиве нет исполняемого файла ${binaryName(input.os)}`,
    );
  rmSync(final, { recursive: true, force: true });
  renameSync(temp, final);
  for (const file of files) rmSync(file.path, { force: true });
  writeFileSync(
    join(final, 'agentdeck-release.json'),
    JSON.stringify({ tag: info.tag, assets: files.map((file) => file.asset.name) }),
  );
  return locateBinary(final, input.os);
}

/** Тег своей сборки по метке распаковки или по имени каталога. */
export function panelRuntimeTag(binary: string): string {
  for (const dir of [join(binary, '..'), join(binary, '..', '..')]) {
    const match = /llama-(b\d+)$/.exec(dir.replace(/[\\/]+$/, ''));
    if (match?.[1]) return match[1];
  }
  return '';
}
