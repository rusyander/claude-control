import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { localError } from './errors.ts';
import type { JobHandle } from './jobs.ts';

/**
 * Хранилище моделей Ollama — прямо по файлам, без сервера.
 *
 * Хранилище простое и стабильное с первых версий: `manifests/<хост>/<пространство>/<модель>/<тег>`
 * — JSON со списком слоёв, `blobs/sha256-<хеш>` — сами слои. Чтение файлов, а не
 * `/api/tags`, по двум причинам: список установленного виден и при остановленном
 * сервере (страница не обязана поднимать его ради списка), и системный Ollama
 * человека не надо запускать, чтобы забрать его модели.
 */

const DEFAULT_HOST = 'registry.ollama.ai';
const DEFAULT_NAMESPACE = 'library';

interface ManifestLayer {
  digest: string;
  size: number;
}
interface Manifest {
  config?: ManifestLayer;
  layers?: ManifestLayer[];
}

export interface StoredModel {
  tag: string;
  sizeBytes: number;
  modifiedAt: string;
  manifest: string;
}

/** Где модели системного Ollama: `OLLAMA_MODELS` человека или `~/.ollama/models`. */
export function systemModelsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.OLLAMA_MODELS?.trim() || join(home, '.ollama', 'models');
}

/** `qwen3-coder:30b` → путь манифеста; `user/m:t` и `hf.co/u/m:t` — тоже. */
export function manifestPathOf(modelsDir: string, tag: string): string {
  const colon = tag.lastIndexOf(':');
  const hasTag = colon > tag.lastIndexOf('/');
  const name = hasTag ? tag.slice(0, colon) : tag;
  const version = hasTag ? tag.slice(colon + 1) : 'latest';
  const parts = name.split('/');
  const first = parts[0] ?? '';
  const host = parts.length >= 2 && first.includes('.') ? first : DEFAULT_HOST;
  const rest = host === DEFAULT_HOST ? parts : parts.slice(1);
  const path = rest.length === 1 ? [DEFAULT_NAMESPACE, ...rest] : rest;
  return join(modelsDir, 'manifests', host, ...path, version);
}

/** Обратное: части пути манифеста → тег так, как его пишет человек. */
export function tagOf(host: string, path: string[], version: string): string {
  const shortHost = host === DEFAULT_HOST;
  const name = shortHost && path[0] === DEFAULT_NAMESPACE ? path.slice(1) : path;
  return `${[...(shortHost ? [] : [host]), ...name].join('/')}:${version}`;
}

export function blobPathOf(modelsDir: string, digest: string): string {
  return join(modelsDir, 'blobs', digest.replace(':', '-'));
}

function layersOf(manifest: Manifest): ManifestLayer[] {
  return [...(manifest.config ? [manifest.config] : []), ...(manifest.layers ?? [])];
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

async function walk(dir: string, depth: number): Promise<string[][]> {
  if (depth === 0) return [[]];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[][] = [];
  for (const entry of entries) {
    for (const tail of await walk(join(dir, entry), depth - 1)) out.push([entry, ...tail]);
  }
  return out;
}

/** Все модели хранилища. Битый манифест пропускается: он не модель, а мусор загрузки. */
export async function listStoredModels(modelsDir: string): Promise<StoredModel[]> {
  const root = join(modelsDir, 'manifests');
  if (!existsSync(root)) return [];
  const found: StoredModel[] = [];
  // Глубина 4 — хост/пространство/модель/тег; у `hf.co` бывает лишний уровень.
  for (const depth of [4, 5]) {
    for (const parts of await walk(root, depth)) {
      const file = join(root, ...parts);
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      const manifest = await readManifest(file);
      if (!manifest?.layers?.length) continue;
      const [host = DEFAULT_HOST, ...rest] = parts;
      const version = rest.pop() ?? 'latest';
      found.push({
        tag: tagOf(host, rest, version),
        sizeBytes: layersOf(manifest).reduce((sum, layer) => sum + layer.size, 0),
        modifiedAt: info.mtime.toISOString(),
        manifest: file,
      });
    }
  }
  return found.sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Сколько места занимает каталог целиком, байт. */
export async function dirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(path);
    else if (entry.isFile()) {
      try {
        total += (await stat(path)).size;
      } catch {
        // Файл исчез между чтением каталога и замером — его и не считаем.
      }
    }
  }
  return total;
}

/**
 * Забрать модель системного Ollama в хранилище панели без скачивания.
 *
 * Слой — жёсткой ссылкой: те же байты на диске, без второй копии на 20 ГБ, и
 * удаление в любом из двух хранилищ другое не задевает. На другом томе ссылка
 * невозможна — тогда копия, через временный файл: оборванная копия не должна
 * выглядеть готовым слоем. Манифест пишется последним: пока его нет, модели
 * для сервера нет, и наполовину перенесённая не всплывёт в списке.
 */
export async function importStoredModel(input: {
  fromDir: string;
  toDir: string;
  tag: string;
  handle: JobHandle;
}): Promise<void> {
  const source = manifestPathOf(input.fromDir, input.tag);
  const manifest = await readManifest(source);
  if (!manifest?.layers?.length) {
    throw localError('local-import-failed', `модель ${input.tag} не найдена в системном Ollama`, {
      tag: input.tag,
      reason: 'manifest',
    });
  }
  const layers = layersOf(manifest);
  const total = layers.reduce((sum, layer) => sum + layer.size, 0);
  input.handle.progress({ phase: 'import', totalBytes: total, doneBytes: 0 });
  let done = 0;
  await mkdir(join(input.toDir, 'blobs'), { recursive: true });
  for (const layer of layers) {
    if (input.handle.signal.aborted)
      throw localError('local-download-cancelled', 'загрузка отменена');
    const from = blobPathOf(input.fromDir, layer.digest);
    const to = blobPathOf(input.toDir, layer.digest);
    if (!existsSync(to)) {
      if (!existsSync(from)) {
        throw localError('local-import-failed', `у модели ${input.tag} нет слоя ${layer.digest}`, {
          tag: input.tag,
          reason: layer.digest,
        });
      }
      try {
        await link(from, to);
      } catch {
        const temp = `${to}.part`;
        await copyFile(from, temp);
        await rename(temp, to);
      }
    }
    done += layer.size;
    input.handle.progress({ doneBytes: done });
  }
  const target = manifestPathOf(input.toDir, input.tag);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

/** Удалить частичную копию слоя, оставшуюся от оборванного переноса. */
export async function dropPartials(modelsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(join(modelsDir, 'blobs'));
  } catch {
    return;
  }
  for (const name of entries.filter((entry) => entry.endsWith('.part'))) {
    await rm(join(modelsDir, 'blobs', name), { force: true });
  }
}
