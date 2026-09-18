import type { Platform, PlatformEmbeddingResult } from '@agentdeck/contracts';
import type { PlatformFetch } from './ca-fetch.ts';
import { foreignTail } from './redact.ts';
import { callUpstream, UpstreamError } from './gateway/upstream.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Эмбеддинги контура: числа для НАШЕГО поиска, а не для показа.
 *
 * Модель называет вызывающий, и подставить её за него панель не может: список
 * моделей ключа приходит пробой, вид объявляет сама платформа, и «взять первую
 * со словом embed в имени» — ровно та догадка, против которой заведён
 * инвариант 13.
 *
 * Ничего не хранится. Своей базы у панели нет, а половина смысла эмбеддинга —
 * в модели, которой он посчитан: сохранённый вектор пережил бы смену модели и
 * молча начал бы врать про похожесть.
 */

/** Не-потоковая ручка, отвечает быстро; ждать её столько же, сколько агента, незачем. */
const EMBEDDINGS_TIMEOUT_MS = 60_000;

/** Больше этого за один раз не отправляем: тело запроса у контура ограничено. */
export const MAX_EMBEDDING_INPUTS = 96;

export interface EmbedOptions {
  platform: Platform;
  token: string;
  model: string;
  input: string[];
  fetchImpl?: PlatformFetch;
}

/** Ошибка эмбеддингов с готовой русской причиной. Маршрут отвечает ею как есть. */
export class EmbeddingError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EmbeddingError';
    this.status = status;
  }
}

export async function embedTexts(options: EmbedOptions): Promise<PlatformEmbeddingResult> {
  const { platform, token, model, input } = options;
  if (input.length === 0)
    throw coded(
      new EmbeddingError('Нечего считать: список текстов пуст.', 400),
      'embeddings-empty',
    );
  if (input.length > MAX_EMBEDDING_INPUTS) {
    throw new EmbeddingError(
      `За один раз считается не больше ${MAX_EMBEDDING_INPUTS} текстов, прислано ${input.length}.`,
      400,
    );
  }
  if (!model.trim())
    throw coded(
      new EmbeddingError('Не названа модель эмбеддингов.', 400),
      'embeddings-model-missing',
    );

  let response: Response;
  try {
    response = await callUpstream({
      platform,
      token,
      path: 'embeddings',
      body: JSON.stringify({ model, input }),
      accept: 'application/json',
      headersTimeoutMs: EMBEDDINGS_TIMEOUT_MS,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    throw new EmbeddingError(
      error instanceof UpstreamError ? `${error.message}.` : String(error),
      502,
    );
  }

  const text = await readBody(response);
  if (response.status >= 400) {
    // Чужой текст чистится от секретов до показа: сервер контура вполне может
    // отразить присланный ключ в теле ошибки.
    const detail = foreignTail(text, token);
    throw new EmbeddingError(
      `Контур не посчитал эмбеддинги (${response.status})${detail ? `: ${detail}` : '.'}`,
      response.status === 401 || response.status === 403 ? response.status : 502,
    );
  }

  const payload = parseJson(text);
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  // ПОРЯДОК ЗДЕСЬ — ЭТО СМЫСЛ. Единственное, что связывает вектор с текстом, —
  // его место в списке, и поле `index` существует ровно потому, что строки
  // вправе приехать в любом порядке. Разложив их как пришло, панель молча
  // отдала бы вектор второго текста под первым — и всякая посчитанная по ним
  // похожесть врала бы, не подавая признаков.
  const ordered = rows.map((row, position) => {
    const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const index = typeof record.index === 'number' ? record.index : position;
    return { index, vector: record.embedding };
  });
  ordered.sort((left, right) => left.index - right.index);

  const vectors: number[][] = [];
  for (const { vector } of ordered) {
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number')) continue;
    vectors.push(vector as number[]);
  }

  if (vectors.length === 0) {
    throw coded(
      new EmbeddingError('В ответе контура нет ни одного вектора.', 502),
      'embeddings-no-vectors',
    );
  }
  // Недосчитались — отказ, а не короткий список: какой из текстов остался без
  // вектора, в ответе не написано, и молчаливый сдвиг на один снова перепутал
  // бы вектор с текстом.
  if (vectors.length !== input.length) {
    throw new EmbeddingError(
      `Контур вернул ${vectors.length} векторов на ${input.length} текстов — сопоставить их не с чем.`,
      502,
    );
  }

  const usage =
    payload?.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : {};

  return {
    model: typeof payload?.model === 'string' ? payload.model : model,
    vectors,
    dimensions: vectors[0]?.length ?? 0,
    promptTokens: numberOf(usage.prompt_tokens),
    totalTokens: numberOf(usage.total_tokens),
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
