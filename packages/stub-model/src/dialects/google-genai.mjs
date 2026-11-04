/**
 * Google Gemini API (`POST …/models/<модель>:generateContent` и
 * `:streamGenerateContent?alt=sse`) — провод Gemini CLI (`@google/genai`). Формы — по справке
 * Gemini API «Generating content» (`GenerateContentResponse`): ответ — `candidates[0].content`
 * с ролью `model` и частями `{text}` / `{functionCall: {name, args, id}}`, `finishReason`,
 * `usageMetadata`, `modelVersion`, `responseId`.
 *
 * Отличия от трёх других протоколов, ради которых модуль свой:
 * - поток и модель — в ПУТИ, а не в теле: `:streamGenerateContent` — поток, `:generateContent` —
 *   JSON; модель — сегмент перед двоеточием;
 * - поток — события без имени, каждое `data:` — частичный `GenerateContentResponse`; конца
 *   `[DONE]` нет: последний кадр несёт `finishReason` и `usageMetadata`;
 * - вызов инструмента приходит целиком в одной части (аргументы — объект, не строка дельт);
 *   `finishReason` и у вызова — `STOP` (у Gemini нет отдельной причины «вызов инструмента»);
 * - ошибка — `{error: {code, message, status}}` в словаре `google.rpc.Code`; пауза перед
 *   повтором — деталь `google.rpc.RetryInfo.retryDelay`, которую CLI читает сам;
 * - заголовков окна / предела частоты у Gemini API нет — шаг с `window` здесь отказ сценария
 *   (`windowHeaders` у модуля нет), а не придуманные заголовки.
 */
import { contentText } from './inspect.mjs';

/** Имя статуса `google.rpc.Code` по HTTP-статусу шага (как их сопоставляет Google API). */
const STATUS_NAMES = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  // 402 у Google не бывает; ближайшее — «нет оплаты / тариф не позволяет».
  402: 'FAILED_PRECONDITION',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  429: 'RESOURCE_EXHAUSTED',
  // 451 — отказ контура по политике; своего кода у Google нет.
  451: 'PERMISSION_DENIED',
  499: 'CANCELLED',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
  529: 'UNAVAILABLE',
};

const statusName = (error) =>
  error.type ?? STATUS_NAMES[error.status] ?? (error.status >= 500 ? 'INTERNAL' : 'UNKNOWN');

function errorObject(error) {
  const out = { code: error.status, message: error.message, status: statusName(error) };
  if (error.retryAfter !== undefined)
    out.details = [
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${error.retryAfter}s` },
    ];
  return out;
}

const STREAM_PATH = /:streamGenerateContent$/;
const MODEL_PATH = /\/models\/([^/:]+):(?:stream)?[gG]enerateContent$/;

const callId = (meta, part, index) => part.id ?? `call_stub_${meta.n}_${index}`;

/** `promptTokenCount` уже включает прочитанное из кеша — так считает Google; кеш — отдельно. */
const usageOf = (meta) => ({
  promptTokenCount: meta.usage.input,
  candidatesTokenCount: meta.usage.output,
  totalTokenCount: meta.usage.input + meta.usage.output,
  ...(meta.usage.cached ? { cachedContentTokenCount: meta.usage.cached } : {}),
});

const partOf = (meta, part, index) =>
  part.kind === 'text'
    ? { text: part.text }
    : { functionCall: { id: callId(meta, part, index), name: part.name, args: part.args ?? {} } };

/** Частичный ответ потока: одна или несколько частей содержимого модели. */
function chunk(meta, parts, end) {
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        ...(end ? { finishReason: 'STOP' } : {}),
        index: 0,
      },
    ],
    ...(end ? { usageMetadata: usageOf(meta), ...meta.extra } : {}),
    modelVersion: meta.model,
    responseId: `stub-${meta.n}`,
  };
}

/** Тексты частей реплики (`functionResponse`, картинки текста не дают). */
const partsText = (parts) =>
  contentText((Array.isArray(parts) ? parts : []).filter((part) => typeof part?.text === 'string'));

export const googleGenai = {
  id: 'google-genai',
  parts: ['text', 'tool'],

  matches: (method, path) => method === 'POST' && MODEL_PATH.test(path),

  /** `:countTokens` — подсчёт, которым CLI меряет историю перед сжатием; не модельный ход. */
  utility(method, path, raw) {
    if (method !== 'POST' || !/\/models\/[^/:]+:countTokens$/.test(path)) return undefined;
    return { status: 200, body: { totalTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
  },

  /** Модель и поток — из пути (`where.path`), всё прочее — из тела. */
  inspect(body, where = { path: '' }) {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    const declarations = (Array.isArray(body.tools) ? body.tools : []).flatMap((group) =>
      Array.isArray(group?.functionDeclarations) ? group.functionDeclarations : [],
    );
    return {
      model: MODEL_PATH.exec(where.path)?.[1],
      stream: STREAM_PATH.test(where.path),
      userTexts: contents
        .filter((c) => c?.role === 'user' || c?.role === undefined)
        .map((c) => partsText(c.parts))
        .filter((text) => text !== ''),
      tools: declarations.map((fn) => ({
        name: fn?.name ?? '',
        schema: fn?.parameters ?? fn?.parametersJsonSchema,
      })),
      hasToolResult: contents.some(
        (c) => Array.isArray(c?.parts) && c.parts.some((part) => part?.functionResponse),
      ),
    };
  },

  /**
   * Голова потока — кадр с пустой текстовой частью: так поток «начат» до содержимого, и
   * задержка `stallMs` идёт после первого байта, как у остальных протоколов.
   */
  head(meta) {
    return [['', chunk(meta, [{ text: '' }], false)]];
  },

  body(meta, parts) {
    const frames = [];
    parts.forEach((part, index) => {
      if (part.kind === 'text') {
        for (const text of part.chunks) frames.push(['', chunk(meta, [{ text }], false)]);
        return;
      }
      frames.push(['', chunk(meta, [partOf(meta, part, index)], false)]);
    });
    // Конец — кадр с `finishReason` и расходом (и `extra`, как `timings` llama-server).
    frames.push(['', chunk(meta, [{ text: '' }], true)]);
    return frames;
  },

  /** Ошибка посреди потока: кадр `{error}` и обрыв — так её отдаёт Gemini API. */
  failFrames(_meta, error) {
    return [['', { error: errorObject(error) }]];
  },

  json(meta, parts) {
    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts: parts.map((part, index) => partOf(meta, part, index)),
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: usageOf(meta),
      modelVersion: meta.model,
      responseId: `stub-${meta.n}`,
      ...meta.extra,
    };
  },

  errorBody(error) {
    return { error: errorObject(error) };
  },
};
