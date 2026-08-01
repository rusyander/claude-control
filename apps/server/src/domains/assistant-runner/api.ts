import type { ConfigProvider } from '../../providers/types.ts';
import { resolveAssistantModel } from '../models/model-defaults.ts';
import { ANTHROPIC_URL, GOOGLE_BASE, MODELS, OPENAI_BASE } from './constants.ts';
import type { AssistantMessage, AssistantRunResult, RunAssistantDeps } from './types.ts';

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
 * Прямой вызов модельного API провайдера через нативный `fetch` по `apiKind`.
 * БЕЗОПАСНОСТЬ: ключ идёт только в заголовок/квери исходящего запроса и НИКОГДА
 * не попадает в текст ошибки или лог (URL с ключом наружу не отдаём).
 */
export async function runProviderApi(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  key: string,
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiKind = provider.assistant?.apiKind ?? 'none';

  try {
    if (apiKind === 'anthropic') {
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: assistantModel(deps, MODELS.anthropic),
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
      const model = assistantModel(deps, MODELS.google);
      const url = `${GOOGLE_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const base =
      apiKind === 'openai-compat' ? (process.env.OPENAI_BASE_URL ?? OPENAI_BASE) : OPENAI_BASE;
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? assistantModel(deps, MODELS.openai),
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
