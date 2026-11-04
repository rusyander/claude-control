import type { HopRequestRules } from '@agentdeck/contracts/core/hops';

/**
 * Правила тела верха (`HopRegisterSpec.requestRules`, Т7): поля по пути провода и перевод в поток.
 * Звено не знает, что поля значат, — что класть, решило ядро (`contour-rules.ts`). Кладутся ПОСЛЕ
 * перевода диалекта и ДО маски: маска обязана видеть их так же, как остальное тело.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Положить значение по пути (`a.b` — вложенное). Объекты по дороге КОПИРУЮТСЯ: у клиента в них
 * могут лежать свои параметры — дополнить, не затерев и не переписав его тело.
 */
function setWire(body: Record<string, unknown>, path: string, value: unknown): void {
  const [head = '', ...rest] = path.split('.');
  if (rest.length === 0) {
    body[head] = value;
    return;
  }
  const inner = body[head];
  const copy = isRecord(inner) ? { ...inner } : {};
  setWire(copy, rest.join('.'), value);
  body[head] = copy;
}

function getWire(body: Record<string, unknown>, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function applyRequestRules(
  body: Record<string, unknown>,
  rules: HopRequestRules | null,
): Record<string, unknown> {
  if (!rules) return body;
  const next = { ...body };
  for (const field of rules.set) setWire(next, field.path, field.value);
  return next;
}

/** Стоит ли в теле значение, с которым верх не принимает поток. */
export function refusesStream(
  body: Record<string, unknown>,
  rules: HopRequestRules | null,
): boolean {
  if (!rules) return false;
  return rules.streamless.some((rule) => {
    const value = getWire(body, rule.path);
    return typeof value === 'string' && rule.values.includes(value);
  });
}

/**
 * Поток наверх. Без правил — поток всегда (`nonstream-120s`: контур режет любой ответ на 120 с,
 * поток хотя бы показывает ответ, пока он идёт). Значение, отвергающее поток, сильнее перевода:
 * иначе каждый такой ход кончался бы отказом; ответ приходит цельным телом и собирается в кадры.
 */
export function upstreamStreamBody(
  body: Record<string, unknown>,
  rules: HopRequestRules | null,
): Record<string, unknown> {
  if (refusesStream(body, rules)) {
    const { stream: _stream, stream_options: _options, ...whole } = body;
    return whole;
  }
  if (rules && !rules.forceStream && body.stream !== true) return body;
  return {
    ...body,
    stream: true,
    stream_options: {
      ...(isRecord(body.stream_options) ? body.stream_options : {}),
      include_usage: true,
    },
  };
}

/**
 * Цельный ответ верха → кадры потока, чтобы конвейер оставался ОДИН: разборщик кадров молча
 * выбросил бы цельное тело — клиент получил бы пустой ответ, нулевой расход и 200. `undefined` —
 * это вообще не ответ модели.
 */
export function framesFromCompletion(
  text: string,
  vendorFields: readonly string[],
): string | undefined {
  // Верх прислал поток, не назвав его потоком: это всё-таки кадры.
  const head = text.trimStart();
  if (head.startsWith('data:') || head.startsWith('event:')) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const choice = isRecord(payload.choices[0]) ? payload.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  // В кадре потока номер вызова обязателен — по нему склеиваются куски аргументов.
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord).map((call, index) => ({ index, ...call }))
    : [];
  const skeleton = {
    ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    object: 'chat.completion.chunk',
  };
  const content =
    typeof message.content === 'string' || Array.isArray(message.content) ? message.content : '';
  const chunk = {
    ...skeleton,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      },
    ],
  };
  const usage = { ...skeleton, choices: [], usage: isRecord(payload.usage) ? payload.usage : {} };
  // Вендорные поля (вердикты по выходу) — отдельными кадрами ПОСЛЕ текста, как в потоке.
  const vendor = vendorFields
    .filter((field) => payload[field] !== undefined)
    .map((field) => `data: ${JSON.stringify({ [field]: payload[field] })}\n\n`);
  return `data: ${JSON.stringify(chunk)}\n\n${vendor.join('')}data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
}
