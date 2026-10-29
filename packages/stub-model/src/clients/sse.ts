/**
 * Строгий разборщик потока SSE — по стандарту WHATWG HTML, «Interpreting an event
 * stream», написан отдельно от пакета: оракул тестов не должен делить код с тем, что
 * проверяет.
 *
 * По стандарту: строки делятся CRLF, LF или CR; пустая строка — конец события;
 * строка с `:` в начале — комментарий; `поле: значение` (один пробел после двоеточия
 * снимается); `data` копится через перевод строки; события без `data` не
 * отправляются; имя по умолчанию — `message`.
 *
 * Строже стандарта (ошибка, а не молчаливый пропуск): неизвестное поле и
 * незаконченное событие в конце потока — стандарт их отбрасывает, и клиент молча
 * теряет последний кадр; здесь это провал кадрирования.
 */
export interface SseEvent {
  event: string;
  data: string;
  /** Было ли поле `event:` явно. */
  named: boolean;
}

const KNOWN_FIELDS = new Set(['event', 'data', 'id', 'retry']);

export function parseSse(text: string): SseEvent[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\n|\r/);
  // Последний элемент после финального перевода строки — пустой; иначе поток оборван посреди строки.
  const tail = lines.pop();
  if (tail !== '') throw new Error(`SSE: stream ends mid-line: ${JSON.stringify(tail)}`);
  const events: SseEvent[] = [];
  let data: string[] = [];
  let event = '';
  let pending = false;
  for (const line of lines) {
    if (line === '') {
      if (data.length)
        events.push({ event: event || 'message', data: data.join('\n'), named: event !== '' });
      data = [];
      event = '';
      pending = false;
      continue;
    }
    pending = true;
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (!KNOWN_FIELDS.has(field)) throw new Error(`SSE: unknown field ${JSON.stringify(field)}`);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'retry' && !/^\d+$/.test(value)) throw new Error(`SSE: bad retry ${value}`);
  }
  if (pending) throw new Error('SSE: stream ends inside an unterminated event');
  return events;
}

/**
 * Разбор JSON без броска: причина провала — текстом. Отказ оракула бросается уже
 * снаружи `catch` и без цепочки `cause` — это провал протокола, а не сбой кода, и
 * `SyntaxError` в выводе теста иначе читался бы как поломка сборки.
 */
function tryJson(text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
}

/** JSON данных события; не JSON — провал протокола с именем события. */
export function dataJson(event: SseEvent): Record<string, unknown> {
  const parsed = tryJson(event.data);
  if (!parsed.ok) throw new Error(`SSE: event ${event.event} data is not JSON (${parsed.why})`);
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`SSE: event ${event.event} data is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Аргументы вызова инструмента, собранные из дельт: не JSON — провал протокола. */
export function argsJson(text: string, where: string): unknown {
  const parsed = tryJson(text);
  if (!parsed.ok) throw new Error(`${where}: tool arguments are not JSON (${parsed.why})`);
  return parsed.value;
}
