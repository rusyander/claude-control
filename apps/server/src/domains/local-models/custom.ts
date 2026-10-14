import type { ModelQuant } from '@agentdeck/contracts/local-models';
import type { FetchLike } from './download.ts';
import { localError } from './errors.ts';
import { GGUF_HEAD_BYTES, parseGgufFacts, type GgufFacts } from './gguf.ts';
import { HF_ORIGIN, listRepoFiles, quantsOf, resolveUrl, type RepoQuant } from './hf.ts';

/**
 * «Любая модель»: репозиторий Hugging Face, которого нет в каталоге панели.
 *
 * Всё, что каталог знает о своих моделях заранее, здесь читается на месте: файлы
 * и их размеры — из дерева репозитория, устройство (слои, головы внимания,
 * предел окна) — из начала одного GGUF-файла диапазоном `Range`, без скачивания
 * гигабайт. Устройство нужно, чтобы посчитать память под окно; без него вариант
 * не показывается вовсе, а не гадается.
 */

const REPO_IN_TEXT = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** Репозиторий из `владелец/репозиторий`, ссылки на него или `hf.co/…:КВАНТ`; иначе — `undefined`. */
export function parseRepoInput(input: string): string | undefined {
  let text = input.trim();
  text = text.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?(?:huggingface\.co|hf\.co)\//i, '');
  // Ссылки вида `…/tree/main`, `…/blob/main/файл`, `…?show_file_info=…`.
  text = text.replace(/[?#].*$/, '').replace(/\/(?:tree|blob|resolve)\/.*$/, '');
  // Запись Ollama: `hf.co/владелец/репозиторий:Q4_K_M`.
  text = text.replace(/:[\w.-]+$/, '').replace(/\/+$/, '');
  return REPO_IN_TEXT.test(text) && !text.includes('..') ? text : undefined;
}

/** Квантования, которые берут первым: самые ходовые, средние по размеру и качеству. */
const PREFERRED_QUANTS = [
  'Q4_K_M',
  'UD-Q4_K_M',
  'UD-Q4_K_XL',
  'Q4_K_S',
  'IQ4_XS',
  'Q5_K_M',
  'Q8_0',
];

/** Какое квантование качается по умолчанию: ходовое Q4, иначе самое крупное из умещающихся в 20 ГБ, иначе меньшее. */
export function defaultQuantOf(quants: ModelQuant[]): ModelQuant | undefined {
  for (const id of PREFERRED_QUANTS) {
    const found = quants.find((quant) => quant.id === id);
    if (found) return found;
  }
  const sorted = [...quants].sort((a, b) => a.sizeBytes - b.sizeBytes);
  const small = sorted.filter((quant) => quant.sizeBytes <= 20 * 1024 ** 3);
  return small.at(-1) ?? sorted[0];
}

/** Начало файла: читаем поток, пока не наберётся нужное, и закрываем — сервер мог не понять `Range`. */
async function readHead(url: string, fetchImpl: FetchLike): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'agentdeck', range: `bytes=0-${GGUF_HEAD_BYTES - 1}` },
    redirect: 'follow',
  });
  if (!response.ok || !response.body)
    throw localError('local-download-http', `Hugging Face ответил ${response.status}`, {
      status: response.status,
    });
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    while (have < GGUF_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      have += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, GGUF_HEAD_BYTES);
}

/** Сколько параметров у репозитория по его карточке (`gguf.total`); нет — `undefined`. */
async function paramsOf(repo: string, fetchImpl: FetchLike): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`${HF_ORIGIN}/api/models/${repo}`, {
      headers: { 'user-agent': 'agentdeck' },
    });
    if (!response.ok) return undefined;
    const info = (await response.json()) as { gguf?: { total?: unknown } };
    const total = info.gguf?.total;
    return typeof total === 'number' && total > 0 ? total / 1e9 : undefined;
  } catch {
    return undefined;
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Устройство для подсчёта кеша: слои с кешем, головы, длина головы; не прочиталось — `undefined`. */
export function archOf(facts: GgufFacts):
  | {
      layers: number;
      kvLayers: number;
      kvHeads: number;
      headDim: number;
    }
  | undefined {
  const kvHeads = facts.headCountKv || facts.headCount;
  const headDim =
    facts.keyLength ||
    (facts.headCount > 0 ? Math.round(facts.embeddingLength / facts.headCount) : 0);
  if (facts.blockCount <= 0 || kvHeads <= 0 || headDim <= 0) return undefined;
  const kvLayers =
    facts.fullAttentionInterval > 0
      ? Math.ceil(facts.blockCount / facts.fullAttentionInterval)
      : facts.blockCount;
  return { layers: facts.blockCount, kvLayers, kvHeads, headDim };
}

/**
 * Запись модели вне каталога — в форме, которую разбирает схема каталога.
 * Агентность не проверена (`toolsProbe: 'unknown'`) до пробы при подключении.
 */
export async function buildCustomModel(
  repo: string,
  fetchImpl: FetchLike,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const quants: RepoQuant[] = quantsOf(await listRepoFiles(repo, fetchImpl));
  const chosen = defaultQuantOf(quants);
  if (!chosen)
    throw localError('local-custom-no-gguf', `в репозитории ${repo} нет файлов GGUF`, { repo });
  const facts = parseGgufFacts(await readHead(resolveUrl(repo, chosen.file), fetchImpl));
  const arch = facts ? archOf(facts) : undefined;
  if (!facts || !arch)
    throw localError('local-custom-no-arch', `не прочитать устройство модели из ${repo}`, { repo });
  const fromCard = await paramsOf(repo, fetchImpl);
  // Нет карточки — прикидка по размеру: в Q4 на параметр уходит около 0,6 байта.
  const paramsB = Math.max(0.1, round1(fromCard ?? chosen.sizeBytes / 0.6 / 1e9));
  const moe = facts.expertCount > 0 && facts.expertUsed > 0;
  const activeParamsB = moe
    ? round1(Math.max(0.1, paramsB * Math.min(1, facts.expertUsed / facts.expertCount + 0.08)))
    : paramsB;
  return {
    tag: `hf:${repo}`,
    title: repo.split('/')[1] ?? repo,
    family: 'custom',
    coding: 'general',
    repo,
    quants: quants.map(({ id, file, sizeBytes }) => ({ id, file, sizeBytes })),
    defaultQuant: chosen.id,
    paramsB,
    activeParamsB,
    arch,
    contextMax: facts.contextLength > 0 ? facts.contextLength : 32_768,
    mtp: facts.nextn > 0,
    agentic: true,
    custom: true,
    toolsProbe: 'unknown',
    released: '',
    source: `Hugging Face, ${now.toISOString().slice(0, 10)}`,
  };
}
