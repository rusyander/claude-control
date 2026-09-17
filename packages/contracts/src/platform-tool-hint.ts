/**
 * «Ответ похож на вызов инструмента, который никто не выполнил» — одна проверка
 * на сервер (проба инструментов при активации) и оба чата панели.
 *
 * Зачем она вообще: модель через контур без прослойки получает инструменты
 * полем, а поле контур может молча выбросить или модель может его не понимать.
 * Тогда она пишет вызов ТЕКСТОМ — и человек видит в ленте JSON вместо правки
 * файла, не понимая, что сломалось. Подсказка называет причину и лечение
 * (включить прослойку), а сам текст НИКОГДА не исполняется: исполняет только
 * прослойка, и только по своей грамматике (развилка 3 CONTOUR-DECISIONS).
 *
 * Грамматика здесь намеренно УЗКАЯ, как и у прослойки: похожим на вызов
 * считается ответ, который ЦЕЛИКОМ — один вызов (голый JSON, JSON в одном
 * ограждении или блок `<tool_call>`). Объект посреди объяснения — это чаще
 * пример из документации, и подсказка там была бы ложной тревогой.
 */

/** Ответ целиком — вызов инструмента, написанный текстом. */
export function looksLikeToolCall(text: string): boolean {
  const body = withoutThinking(text).trim();
  if (!body) return false;

  const tagged = /^<tool_call>([\s\S]*)<\/tool_call>$/.exec(body);
  if (tagged) return callShaped(parseJson((tagged[1] ?? '').trim()));

  const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(body);
  const inner = fenced ? (fenced[1] ?? '').trim() : body;
  // Второе ограждение внутри — уже не «один вызов», а текст с примерами.
  if (fenced && inner.includes('```')) return false;
  return callShaped(parseJson(inner));
}

/** Порог размера модели, от которого агент с правкой файлов проверен вживую. */
export const PLATFORM_AGENT_VERIFIED_FROM_B = 27;

/**
 * Размер модели в миллиардах из её имени (`qwen2.5:7b`, `Qwen3-32B-Instruct`,
 * `gemma-3-27b-it`). Нет числа с `b` — `undefined`: гадать по семейству нельзя.
 * `a3b` у MoE — активные параметры, а не размер, и в счёт не идёт.
 */
export function modelSizeB(model: string): number | undefined {
  const matches = [...model.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)];
  const sizes = matches.map((match) => Number(match[1])).filter((size) => size > 0);
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}

function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}

function parseJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function callShaped(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(callShaped);
  if (!isRecord(value)) return false;
  if (Array.isArray(value.tool_calls)) return callShaped(value.tool_calls);
  if (isRecord(value.function)) return callShaped(value.function);
  const name = value.name ?? value.tool;
  if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) return false;
  return ['arguments', 'parameters', 'input', 'args', 'tool_input'].some((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
