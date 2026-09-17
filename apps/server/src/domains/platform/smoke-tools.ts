import type { Platform, PlatformSmokeTools } from '@agentdeck/contracts';
import { looksLikeToolCall } from '@agentdeck/contracts/platform-tool-hint';
import type { PlatformFetch } from './ca-fetch.ts';
import { toolRouteOf } from './models.ts';

/**
 * Проба инструментов при активации (развилка 3 CONTOUR-DECISIONS): ОДИН вопрос,
 * вызывает ли модель инструмент полем `tools`.
 *
 * Спрашиваем только когда прослойка выключена. С прослойкой инструменты едут
 * текстом протокола, и поле не участвует; с инструментами самой платформы
 * клиентские не отправляются вовсе. Без прослойки же молчаливый провал — самый
 * дорогой: агент «работает», файлы не меняются, а в ленте JSON, который никто не
 * исполнил. Карточка называет это при активации, а не после первой задачи.
 *
 * Идёт ЧЕРЕЗ СВОЙ ШЛЮЗ, как и пробный запрос: перевод `tools` в диалект контура
 * живёт там, и прямой вопрос контуру проверил бы не тот путь, которым пойдёт CLI.
 * Ответ никогда не исполняется — здесь только читается, был ли вызов.
 */

/** Потолок ответа: вызов короткий, а reasoning-модели нужен запас на размышления. */
const TOOLS_MAX_TOKENS = 512;
const TOOLS_TIMEOUT_MS = 30_000;
const PROBE_TOOL = 'report_status';

export interface SmokeToolsInput {
  platform: Platform;
  model: string;
  port: number;
  fetchImpl: PlatformFetch;
}

/** `undefined` — спрашивать не о чем: прослойка включена или у контура свои инструменты. */
export async function smokeTools(input: SmokeToolsInput): Promise<PlatformSmokeTools | undefined> {
  const { platform } = input;
  if (platform.rules.platform.platformTools.length > 0) return undefined;
  const route = toolRouteOf(platform);
  if (route === 'shim') return undefined;
  if (route === 'none') {
    return {
      ok: false,
      reason: 'dropped',
      detail:
        'Тип контура выбрасывает поле инструментов — без прослойки агент не сможет править файлы.',
    };
  }

  try {
    const response = await input.fetchImpl(
      `http://127.0.0.1:${input.port}/${platform.id}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          max_tokens: TOOLS_MAX_TOKENS,
          stream: true,
          messages: [
            {
              role: 'user',
              content: `Вызови инструмент ${PROBE_TOOL} с аргументом status = "ready". Ничего не пиши текстом.`,
            },
          ],
          tools: [
            {
              name: PROBE_TOOL,
              description: 'Сообщить панели, что модель готова к работе.',
              input_schema: {
                type: 'object',
                properties: { status: { type: 'string' } },
                required: ['status'],
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(TOOLS_TIMEOUT_MS),
      },
    );
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        ok: false,
        reason: 'refused',
        detail: `Запрос с инструментом отклонён (${response.status}).`,
      };
    }
    const { called, text } = readFrames(body);
    if (called) return { ok: true };
    return looksLikeToolCall(text)
      ? {
          ok: false,
          reason: 'call-as-text',
          detail:
            'Модель написала вызов текстом: поле инструментов до неё не дошло или она его не понимает.',
        }
      : { ok: false, reason: 'no-call', detail: 'Модель ответила без вызова инструмента.' };
  } catch (error) {
    return {
      ok: false,
      reason: 'refused',
      detail: `Проба инструментов не прошла: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

/** Был ли в потоке Anthropic блок `tool_use`, и какой текст модель написала. */
function readFrames(body: string): { called: boolean; text: string } {
  let called = false;
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice('data:'.length).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const frame = JSON.parse(raw) as {
        content_block?: { type?: unknown };
        delta?: { text?: unknown };
      };
      if (frame.content_block?.type === 'tool_use') called = true;
      if (typeof frame.delta?.text === 'string') text += frame.delta.text;
    } catch {
      // Кадр, который не разобрался, — не причина терять остальные.
    }
  }
  return { called, text };
}
