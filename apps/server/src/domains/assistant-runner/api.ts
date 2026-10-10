import type { ConfigProvider } from '../../providers/types/types.ts';
import { resolveAssistantModel } from '../models/model-defaults.ts';
import { ANTHROPIC_URL, GOOGLE_BASE, MODELS, OPENAI_BASE } from './constants.ts';
import type {
  AssistantEndpoint,
  AssistantMessage,
  AssistantRunResult,
  RunAssistantDeps,
} from './types.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { vendorApiRefusal } from '../provider-keys/provider-keys.ts';
import {
  anthropicImageBlocks,
  googleImageParts,
  openAiImageParts,
} from '../../lib/agent-images/agent-images.ts';

/**
 * Содержимое реплики в форме API: без картинок — прежняя строка байт в байт,
 * с картинками — массив частей, картинки перед текстом (так советует API).
 */
function anthropicContent(m: AssistantMessage): unknown {
  if (!m.images?.length) return m.content;
  return [...anthropicImageBlocks(m.images), { type: 'text', text: m.content }];
}

function openAiContent(m: AssistantMessage): unknown {
  if (!m.images?.length) return m.content;
  return [...openAiImageParts(m.images), { type: 'text', text: m.content }];
}

function googleParts(m: AssistantMessage): unknown[] {
  return [...(m.images?.length ? googleImageParts(m.images) : []), { text: m.content }];
}

/**
 * Потолок длины ответа для Anthropic (у него `max_tokens` обязателен). Замер
 * 10.10: русский текст — около 2 символов на токен (медиана по транскриптам),
 * а помощник структуры пишет файлы навыка целиком — 10–20 КБ у многофайлового
 * навыка набора. Прежние 2048 обрезали ответ уже на ~4 КБ. 16384 вмещают ~32 КБ
 * русского текста и укладываются в окно помощника структуры (240 с).
 */
export const API_MAX_OUTPUT_TOKENS = 16_384;

/** Актуальное поколение зашитой модели — или она сама, если каталога нет. */
function assistantModel(deps: RunAssistantDeps, fallback: string): string {
  return resolveAssistantModel(deps.models ?? [], fallback);
}

function apiError(providerId: string, message: string): AssistantRunResult {
  return {
    ok: false,
    providerId,
    mode: 'api',
    reply: '',
    experimental: false,
    reason: 'api_error',
    error: message,
  };
}

/**
 * Отказ без запроса: ключ этого провайдера некуда отправить, не отдав его чужому
 * вендору (`vendorApiRefusal`). Режим `none` — вызова не было вовсе.
 */
function vendorRefused(
  provider: ConfigProvider,
  code: 'assistant-api-base-unknown',
): AssistantRunResult {
  const params = { provider: provider.name };
  return coded(
    {
      ok: false,
      providerId: provider.id,
      mode: 'none',
      reply: '',
      experimental: false,
      reason: 'unsupported',
      error: serverText(code, params),
    },
    code,
    params,
  );
}

/** Базовый адрес без хвостовых слэшей — их дописывает уже путь запроса. */
function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Адрес запроса при СВОЁМ эндпоинте. Смысл базового адреса задан видом API и
 * совпадает с тем, что ждут переменные окружения самих CLI: у anthropic и
 * google это корень хоста, у openai-совместимого — адрес вместе с версией.
 */
function endpointUrl(endpoint: AssistantEndpoint, model: string): string {
  const base = trimBase(endpoint.baseUrl);
  if (endpoint.apiKind === 'anthropic') return `${base}/v1/messages`;
  if (endpoint.apiKind === 'google') return `${base}/v1beta/models/${model}:generateContent`;
  return `${base}/chat/completions`;
}

/**
 * Прямой вызов модельного API через нативный `fetch`.
 *
 * Куда именно уходит запрос, решают две вещи: свой эндпоинт из настроек панели
 * (`deps.endpoint`), если он выбран, иначе `apiKind` провайдера и облако вендора.
 * Свой эндпоинт задаёт и вид API, и адрес, и модель — CLI провайдера тут ни при
 * чём: пользователь выбрал, куда уходят его данные.
 *
 * БЕЗОПАСНОСТЬ: ключ идёт только в заголовок/квери исходящего запроса и НИКОГДА
 * не попадает в текст ошибки или лог (URL с ключом наружу не отдаём). У своего
 * эндпоинта токена может не быть вовсе (локальная модель) — тогда запрос уходит
 * без авторизации, а не с пустым заголовком.
 */
export async function runProviderApi(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  key: string,
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const endpoint = deps.endpoint;
  // Облако вендора — только своему провайдеру и только по адресу из каталога.
  // Проверка ДО любого запроса: отказ после него ключ уже не вернул бы.
  const refusal = endpoint ? undefined : vendorApiRefusal(provider);
  if (refusal) return vendorRefused(provider, refusal);
  const apiKind = endpoint ? endpoint.apiKind : (provider.assistant?.apiKind ?? 'none');
  // У своего эндпоинта ключ — его собственный токен; ключ провайдера сюда не
  // подставляем: он от другого сервиса и на чужом адресе бесполезен.
  const credential = endpoint ? (endpoint.token ?? '') : key;

  try {
    if (apiKind === 'anthropic') {
      const model = endpoint?.model || assistantModel(deps, MODELS.anthropic);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (credential) headers['x-api-key'] = credential;

      const res = await fetchImpl(endpoint ? endpointUrl(endpoint, model) : ANTHROPIC_URL, {
        method: 'POST',
        headers,
        signal: deps.signal,
        body: JSON.stringify({
          model,
          max_tokens: API_MAX_OUTPUT_TOKENS,
          messages: messages.map((m) => ({ role: m.role, content: anthropicContent(m) })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as {
        content?: { type?: string; text?: string }[];
        stop_reason?: string;
      };
      if (data.stop_reason === 'max_tokens') return truncated(provider.id);
      const reply = (data.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
        .trim();
      return finalizeApi(provider.id, reply);
    }

    if (apiKind === 'google') {
      // Ключ — в квери; URL с ключом в ошибки/логи НЕ включаем.
      const model = endpoint?.model || assistantModel(deps, MODELS.google);
      const base = endpoint
        ? endpointUrl(endpoint, model)
        : `${GOOGLE_BASE}/${model}:generateContent`;
      const url = credential ? `${base}?key=${encodeURIComponent(credential)}` : base;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: deps.signal,
        body: JSON.stringify({
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: googleParts(m),
          })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      };
      if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') return truncated(provider.id);
      const reply = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      return finalizeApi(provider.id, reply);
    }

    // openai → облако OpenAI; openai-compat → адрес вендора из каталога
    // (`assistant.apiBaseUrl`, без него отказ выше). `OPENAI_BASE_URL` процесса
    // сюда не попадает: её завели для другого инструмента, и ключ чужого вендора
    // уехал бы по ней туда, куда его не посылали.
    const model = endpoint?.model || assistantModel(deps, MODELS.openai);
    const vendorBase =
      apiKind === 'openai-compat' ? trimBase(provider.assistant?.apiBaseUrl ?? '') : OPENAI_BASE;
    const url = endpoint ? endpointUrl(endpoint, model) : `${vendorBase}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credential) headers.authorization = `Bearer ${credential}`;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: deps.signal,
      body: JSON.stringify({
        model: endpoint ? model : (process.env.OPENAI_MODEL ?? model),
        messages: messages.map((m) => ({ role: m.role, content: openAiContent(m) })),
      }),
    });
    if (!res.ok) return apiError(provider.id, await describeHttpError(res));
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    if (data.choices?.[0]?.finish_reason === 'length') return truncated(provider.id);
    const reply = (data.choices?.[0]?.message?.content ?? '').trim();
    return finalizeApi(provider.id, reply);
  } catch (error) {
    return apiError(provider.id, error instanceof Error ? error.message : String(error));
  }
}

function finalizeApi(providerId: string, reply: string): AssistantRunResult {
  if (!reply)
    return coded(apiError(providerId, 'Модель вернула пустой ответ.'), 'assistant-empty-reply');
  return { ok: true, providerId, mode: 'api', reply, experimental: false, reason: 'ok' };
}

/**
 * Ответ оборвался на пределе длины. Отдавать обрезок нельзя: помощник формы и
 * помощник структуры разбирают его как JSON, и половина файла записалась бы на
 * диск как целый файл — честный отказ вместо этого.
 */
function truncated(providerId: string): AssistantRunResult {
  return coded(
    apiError(providerId, serverText('assistant-reply-truncated')),
    'assistant-reply-truncated',
  );
}

/** Краткое описание HTTP-ошибки API без раскрытия секретов. */
async function describeHttpError(res: Response): Promise<string> {
  let detail: string;
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return `API ответил ${res.status}${detail ? `: ${detail}` : ''}`;
}
