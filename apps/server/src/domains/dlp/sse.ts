/**
 * Разбор потока server-sent events — ровно настолько, насколько нужно прокси.
 *
 * Поток приходит кусками TCP, а не кадрами: граница кадра (`\n\n`) запросто
 * оказывается посередине куска, и «разобрать пришедшее» без накопления
 * невозможно. Здесь копится хвост, отдаются только целые кадры, а всё, что
 * панель не опознала, проходит насквозь байт в байт.
 *
 * Формат взят из спецификации SSE: кадр — набор строк `поле: значение`,
 * разделитель кадров — пустая строка, поле данных может повторяться.
 */

export interface SseFrame {
  /** Имя события (`event: content_block_delta`), если было. */
  event?: string;
  /** Строки `data:` в порядке появления. */
  data: string[];
  /** Исходный текст кадра без разделителя — на случай «отдать как есть». */
  raw: string;
}

export interface SseSplit {
  frames: string[];
  /** Незавершённый хвост: ждёт следующего куска. */
  rest: string;
}

/** Разделить накопленный текст на целые кадры и остаток. */
export function splitFrames(buffer: string): SseSplit {
  const frames: string[] = [];
  let rest = buffer;

  for (;;) {
    const boundary = findBoundary(rest);
    if (boundary === undefined) break;
    frames.push(rest.slice(0, boundary.at));
    rest = rest.slice(boundary.at + boundary.length);
  }

  return { frames, rest };
}

/** Границей считается пустая строка — с любым переводом строки (LF или CRLF). */
function findBoundary(text: string): { at: number; length: number } | undefined {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, length: 4 };
  return { at: lf, length: 2 };
}

export function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { data: [], raw };

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Пробел после двоеточия — часть синтаксиса, а не значения.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') frame.event = value;
    else if (field === 'data') frame.data.push(value);
  }

  return frame;
}

/**
 * Собрать кадр обратно. Имя события сохраняется: клиенты Anthropic ориентируются
 * именно на `event:`, а не только на поле `type` внутри данных.
 */
export function serializeFrame(event: string | undefined, data: string): string {
  const head = event ? `event: ${event}\n` : '';
  return `${head}data: ${data}\n\n`;
}
