import type { Platform, PlatformSmokeTools } from '@agentdeck/contracts';
import { looksLikeToolCall } from '@agentdeck/contracts/platform-tool-hint';
import type { PlatformFetch } from './ca-fetch.ts';
import { toolRouteOf } from './models.ts';
import { serverText } from '../../lib/server-texts.ts';

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
      detail: serverText('contour-tools-dropped'),
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
        detail: serverText('contour-tools-refused', { status: response.status }),
      };
    }
    const { called, text } = readFrames(body);
    if (called) return { ok: true };
    return looksLikeToolCall(text)
      ? {
          ok: false,
          reason: 'call-as-text',
          detail: serverText('contour-tools-call-as-text'),
        }
      : { ok: false, reason: 'no-call', detail: serverText('contour-tools-no-call') };
  } catch (error) {
    return {
      ok: false,
      reason: 'refused',
      detail: serverText('contour-tools-failed', {
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

/**
 * Итоги пробы, после которых прослойку включает сама панель.
 *
 * `refused` сюда не входит намеренно: запрос с инструментом не прошёл — это
 * сказано про ЗАПРОС, а не про модель. За ним стоит и «шлюз не принимает поле»,
 * и обычный сбой минуты, и включать по нему прослойку значило бы лечить таймаут
 * промптом в 100 тысяч знаков. Там остаётся кнопка на карточке.
 */
const SHIM_REASONS: ReadonlySet<string> = new Set(['no-call', 'call-as-text', 'dropped']);

/**
 * Включить ли прослойку за человека по итогу пробы (развилка 3, решение В1).
 *
 * Решение принимается ОДИН раз на контур: отметка `toolShimFromProbe` о том,
 * что панель уже решала, сильнее любого нового итога. Иначе человек, выключивший
 * прослойку ради цены хода, получал бы её обратно на каждой активации.
 *
 * Свои инструменты платформы запирают решение целиком: прослойка с ними —
 * запрещённое сочетание (матрица конфликтов Т7), и дверь сохранения отвергла бы
 * контур, который панель сама же и собрала.
 */
export function shimFromProbe(
  platform: Pick<Platform, 'toolShim' | 'toolShimFromProbe' | 'rules'>,
  tools: PlatformSmokeTools | undefined,
): boolean {
  if (!tools || tools.ok) return false;
  if (platform.toolShim || platform.toolShimFromProbe) return false;
  if (platform.rules.platform.platformTools.length > 0) return false;
  return SHIM_REASONS.has(tools.reason ?? '');
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
