import type { ConfigProvider } from '../../providers/types.ts';
import { resolveAssistantModel } from '../models/model-defaults.ts';
import { ANTHROPIC_URL, GOOGLE_BASE, MODELS, OPENAI_BASE } from './constants.ts';
import type {
  AssistantEndpoint,
  AssistantMessage,
  AssistantRunResult,
  RunAssistantDeps,
} from './types.ts';

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
          max_tokens: 2048,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
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
            parts: [{ text: m.content }],
          })),
        }),
      });
      if (!res.ok) return apiError(provider.id, await describeHttpError(res));
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const reply = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      return finalizeApi(provider.id, reply);
    }

    // openai + openai-compat → chat/completions (base URL: OpenAI по умолчанию).
    const model = endpoint?.model || assistantModel(deps, MODELS.openai);
    const url = endpoint
      ? endpointUrl(endpoint, model)
      : `${apiKind === 'openai-compat' ? (process.env.OPENAI_BASE_URL ?? OPENAI_BASE) : OPENAI_BASE}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (credential) headers.authorization = `Bearer ${credential}`;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: deps.signal,
      body: JSON.stringify({
        model: endpoint ? model : (process.env.OPENAI_MODEL ?? model),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) return apiError(provider.id, await describeHttpError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = (data.choices?.[0]?.message?.content ?? '').trim();
    return finalizeApi(provider.id, reply);
  } catch (error) {
    return apiError(provider.id, error instanceof Error ? error.message : String(error));
  }
}

function finalizeApi(providerId: string, reply: string): AssistantRunResult {
  if (!reply) return apiError(providerId, 'Модель вернула пустой ответ.');
  return { ok: true, providerId, mode: 'api', reply, experimental: false, reason: 'ok' };
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
