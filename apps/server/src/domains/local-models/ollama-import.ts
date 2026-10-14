import { existsSync, linkSync, mkdirSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { localError } from './errors.ts';
import { isGguf, readGgufFacts } from './gguf.ts';
import type { JobHandle } from './jobs.ts';
import type { ImportedModel, LocalPaths } from './paths.ts';
import { modelLayerOf } from './store.ts';

/**
 * Модели, уже скачанные Ollama, — в llama.cpp без повторной загрузки.
 *
 * Слой с весами в хранилище Ollama — обычный GGUF под именем `sha256-<хеш>`.
 * Он прикрепляется к `models/ollama-import/<имя>.gguf` жёсткой ссылкой (те же
 * байты на диске, второй копии на 17 ГБ нет, удаление любой из двух ссылок
 * другую не задевает), после чего llama.cpp ПРОБУЕТ его открыть. Открыл —
 * модель импортирована. Не открыл (формат или архитектура, которых этой сборке
 * не хватает) — ссылка убирается, а человеку предлагается скачать модель заново.
 * Файл, который сервер не откроет, в списке установленных не нужен.
 *
 * Хранилище Ollama только читается: ни сервер Ollama, ни её приложение не
 * запускаются.
 */

/** Имя файла по тегу: `qwen3.6:27b-coding` → `qwen3.6-27b-coding.gguf`. */
export function importFileName(tag: string): string {
  return `${tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}.gguf`;
}

export type TestLoad = (file: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * Забрать модель из хранилища Ollama. На другом томе жёсткая ссылка невозможна —
 * тогда копия через временный файл: оборванная копия не должна выглядеть готовым
 * файлом.
 */
export async function importOllamaModel(input: {
  paths: LocalPaths;
  /** Хранилища, где искать манифест: собственное прежнее панели и системное. */
  stores: string[];
  tag: string;
  handle: JobHandle;
  testLoad: TestLoad;
}): Promise<ImportedModel> {
  const { paths, tag, handle } = input;
  let layer: { blob: string; sizeBytes: number } | undefined;
  for (const store of input.stores) {
    layer = await modelLayerOf(store, tag);
    if (layer) break;
  }
  if (!layer || !existsSync(layer.blob))
    throw localError('local-import-failed', `модель ${tag} не найдена в хранилище Ollama`, {
      tag,
      reason: 'manifest',
    });
  if (!isGguf(layer.blob))
    throw localError('local-import-failed', `слой модели ${tag} не GGUF`, {
      tag,
      reason: 'format',
    });

  handle.progress({ phase: 'import', totalBytes: layer.sizeBytes, doneBytes: 0 });
  mkdirSync(paths.ollamaImport, { recursive: true });
  const name = importFileName(tag);
  const target = join(paths.ollamaImport, name);
  if (!existsSync(target)) {
    try {
      linkSync(layer.blob, target);
    } catch {
      const temp = `${target}.part`;
      copyFileSync(layer.blob, temp);
      renameSync(temp, target);
    }
  }
  handle.progress({ doneBytes: layer.sizeBytes, phase: 'test' });

  const facts = readGgufFacts(target);
  const loaded = facts
    ? await input.testLoad(target)
    : ({ ok: false, reason: 'GGUF header is unreadable' } as const);
  if (!loaded.ok) {
    rmSync(target, { force: true });
    throw localError('local-load-failed', `llama.cpp не открыл модель ${tag}: ${loaded.reason}`, {
      tag,
      reason: loaded.reason,
    });
  }
  return {
    file: `ollama-import/${name}`,
    sizeBytes: layer.sizeBytes,
    mtp: (facts?.nextn ?? 0) > 0,
    importedAt: new Date().toISOString(),
  };
}
