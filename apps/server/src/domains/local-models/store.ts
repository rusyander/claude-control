import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Хранилище моделей Ollama — прямо по файлам, без сервера. Панель его только ЧИТАЕТ
 * (чтобы забрать скачанное жёсткой ссылкой): Ollama человека она не запускает.
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

/**
 * Сколько места занимает каталог целиком, байт. Файл с несколькими жёсткими
 * ссылками (импорт из Ollama: слой и `.gguf` — одни и те же байты) считается один
 * раз: иначе импортированная 17-гигабайтная модель «занимала» бы 34 ГБ.
 */
export async function dirSize(dir: string, seen = new Set<string>()): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(path, seen);
    else if (entry.isFile()) {
      try {
        const info = await stat(path, { bigint: true });
        if (info.nlink > 1n) {
          const id = `${info.dev}:${info.ino}`;
          if (seen.has(id)) continue;
          seen.add(id);
        }
        total += Number(info.size);
      } catch {
        // Файл исчез между чтением каталога и замером — его и не считаем.
      }
    }
  }
  return total;
}

/** Слой с весами модели (GGUF) в манифесте Ollama: путь файла и размер. */
export async function modelLayerOf(
  modelsDir: string,
  tag: string,
): Promise<{ blob: string; sizeBytes: number } | undefined> {
  const manifest = (await readManifest(manifestPathOf(modelsDir, tag))) as
    { layers?: (ManifestLayer & { mediaType?: string })[] } | undefined;
  const layer = manifest?.layers?.find(
    (item) => item.mediaType === 'application/vnd.ollama.image.model',
  );
  return layer ? { blob: blobPathOf(modelsDir, layer.digest), sizeBytes: layer.size } : undefined;
}

/**
 * Убрать слои, на которые не ссылается ни один манифест СОБСТВЕННОГО хранилища
 * панели (прежние загрузки Ollama в `.local-models/models`). Системное хранилище
 * человека сюда не передаётся никогда.
 */
export async function dropUnreferencedBlobs(modelsDir: string): Promise<number> {
  const used = new Set<string>();
  for (const model of await listStoredModels(modelsDir)) {
    const manifest = await readManifest(model.manifest);
    for (const layer of manifest ? layersOf(manifest) : [])
      used.add(blobPathOf(modelsDir, layer.digest));
  }
  let entries: string[];
  try {
    entries = await readdir(join(modelsDir, 'blobs'));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(modelsDir, 'blobs', name);
    if (used.has(path)) continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}
