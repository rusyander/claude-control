import { join } from 'node:path';
import type { ModelQuant } from '@agentdeck/contracts/local-models';
import { downloadResumable, verifySha256, type FetchLike } from './download.ts';
import { localError } from './errors.ts';
import type { JobHandle } from './jobs.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Hugging Face: какие GGUF есть в репозитории и как их скачать.
 *
 * Список квантований берётся из дерева репозитория, а не из каталога: файл
 * могли переименовать или выложить новое квантование уже после того, как
 * каталог сверили. Контрольная сумма — `lfs.oid` файла в том же ответе (для LFS
 * это sha256 содержимого), а не файл рядом.
 */

export const HF_ORIGIN = 'https://huggingface.co';

const REPO_PATTERN = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const FILE_PATTERN = /^[A-Za-z0-9][\w.+-]*\.gguf$/;

/** Репозиторий и файл — только то, что бывает у настоящих: из них строится путь на диске. */
export function validRepoFile(repo: string, file: string): boolean {
  return REPO_PATTERN.test(repo) && FILE_PATTERN.test(file) && !repo.includes('..');
}

export interface HfFile {
  path: string;
  size: number;
  /** sha256 содержимого (LFS `oid`); пусто — файл не в LFS, суммы нет. */
  sha256: string;
}

export type RepoQuant = ModelQuant & { sha256: string };

const QUANT_PATTERN =
  /-((?:UD-)?(?:IQ\d(?:_[A-Z]+)?|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?))\.gguf$/i;

/** Метка квантования по имени файла; не веса одним файлом (проектор, части, imatrix) — `undefined`. */
export function quantIdOf(file: string): string | undefined {
  if (/^(mmproj|imatrix)/i.test(file)) return undefined;
  return QUANT_PATTERN.exec(file)?.[1];
}

/** Файлы корня репозитория: дерево `main`, без вложенных каталогов. */
export async function listRepoFiles(repo: string, fetchImpl: FetchLike = fetch): Promise<HfFile[]> {
  if (!REPO_PATTERN.test(repo))
    throw localError('local-model-unknown', `репозиторий ${repo} назван неверно`, { tag: repo });
  const response = await fetchImpl(`${HF_ORIGIN}/api/models/${repo}/tree/main`, {
    headers: { 'user-agent': 'agentdeck' },
  });
  if (!response.ok)
    throw localError('local-download-http', `Hugging Face ответил ${response.status}`, {
      status: response.status,
    });
  const tree = (await response.json()) as {
    type: string;
    path: string;
    size?: number;
    lfs?: { oid?: string; size?: number };
  }[];
  return tree
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({
      path: entry.path,
      size: entry.lfs?.size ?? entry.size ?? 0,
      sha256: entry.lfs?.oid?.toLowerCase() ?? '',
    }));
}

/** Квантования репозитория, от меньшего к большему. */
export function quantsOf(files: HfFile[]): RepoQuant[] {
  const quants: RepoQuant[] = [];
  for (const file of files) {
    const id = quantIdOf(file.path);
    if (id && file.size > 0 && /\.gguf$/.test(file.path))
      quants.push({ id, file: file.path, sizeBytes: file.size, sha256: file.sha256 });
  }
  return quants.sort((a, b) => a.sizeBytes - b.sizeBytes);
}

export function resolveUrl(repo: string, file: string): string {
  return `${HF_ORIGIN}/${repo}/resolve/main/${file}`;
}

/** Где лежит файл модели: `models/<владелец>/<репозиторий>/<файл>`. */
export function modelFilePath(paths: LocalPaths, repo: string, file: string): string {
  return join(paths.models, ...repo.split('/'), file);
}

/**
 * Скачать файл модели с докачкой и проверить сумму. Размер и сумма — из живого
 * дерева репозитория: если файл поменяли после сверки каталога, берётся новый.
 * Файл на месте и сумма сходится — ничего не качается.
 */
export async function downloadModelFile(input: {
  paths: LocalPaths;
  repo: string;
  file: string;
  handle: JobHandle;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const { paths, repo, file, handle } = input;
  if (!validRepoFile(repo, file))
    throw localError('local-model-unknown', `файл ${repo}/${file} назван неверно`, {
      tag: `${repo}/${file}`,
    });
  const fetchImpl = input.fetchImpl ?? fetch;
  handle.progress({ phase: 'manifest' });
  const listed = (await listRepoFiles(repo, fetchImpl)).find((item) => item.path === file);
  if (!listed)
    throw localError('local-asset-missing', `в репозитории ${repo} нет файла ${file}`, {
      version: repo,
      name: file,
    });
  if (!listed.sha256)
    throw localError('local-checksum-missing', `для ${file} нет контрольной суммы`, { name: file });
  const dest = modelFilePath(paths, repo, file);
  handle.progress({ phase: 'pull', totalBytes: listed.size, doneBytes: 0 });
  await downloadResumable(
    resolveUrl(repo, file),
    dest,
    listed.size,
    handle,
    { done: 0, total: listed.size },
    fetchImpl,
  );
  handle.progress({ phase: 'verify', doneBytes: listed.size });
  await verifySha256(dest, listed.sha256, file);
  return dest;
}
