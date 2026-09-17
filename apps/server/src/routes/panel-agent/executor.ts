import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { InjectRoute, StreamHead } from './registry.ts';

export interface InjectAccess {
  /** Включён ли удалённый доступ — тогда гейт ждёт токен и от своих. */
  requiresToken: () => boolean;
  expectedToken: () => string;
}

/**
 * Сколько исполнитель ждёт кадра сессии от потокового маршрута. CLI называет
 * сессию за пару секунд; дольше — отцепляемся и честно говорим, что имени ещё нет.
 */
export const STREAM_HEAD_TIMEOUT_MS = 20_000;

/** Кадры, после которых начало прогона известно: дальше читать незачем. */
const HEAD_KINDS = new Set(['session', 'done', 'error', 'gone']);

/**
 * Исполнитель действий: `app.inject` того же маршрута, который зовёт окно.
 *
 * Запрос проходит весь путь настоящего — гейт доступа, пустое тело, проверку
 * тела, домен, хук наблюдателя за файлами, — поэтому у агента нет ни одной
 * возможности, которой нет у человека в интерфейсе, и ни одной второй
 * реализации поведения. Origin у внутреннего запроса нет, и гейт его пропускает
 * как не-браузерного клиента; токен добавляется, только когда гейт его требует.
 *
 * Пометка агента ставится и здесь: маршрут решения по карточке её видит и
 * отказывает, так что действие не может подтвердить другое действие.
 */
export function createRouteInjector(
  app: FastifyInstance,
  access: InjectAccess,
  streamHeadTimeoutMs = STREAM_HEAD_TIMEOUT_MS,
): InjectRoute {
  return async ({ method, url, body, stream }) => {
    const headers: Record<string, string> = { [PANEL_AGENT_HEADER]: '1' };
    if (access.requiresToken()) headers.authorization = `Bearer ${access.expectedToken()}`;
    const options = {
      method,
      url,
      headers,
      ...(body === undefined ? {} : { payload: body as object }),
    };
    if (!stream) {
      const response = await app.inject(options);
      return { status: response.statusCode, body: parseBody(response.body) };
    }

    // Поток: ответ приходит, как только маршрут написал заголовки. Отказ до
    // запуска (409/400 JSON) дочитывается целиком, SSE — только до начала прогона.
    const response = await app.inject({ ...options, payloadAsStream: true });
    const source = response.stream();
    const isSse = String(response.headers['content-type'] ?? '').includes('text/event-stream');
    if (!isSse) {
      return { status: response.statusCode, body: parseBody(await readAll(source)) };
    }
    const head = await readHead(source, streamHeadTimeoutMs);
    // Отцепиться, как отцепляется закрытая вкладка: маршрут слушает `close` на
    // ответе, снимает подписчика и пинг, прогон в реестре не трогает.
    const raw = (response.raw as { res?: { emit: (event: string) => boolean } }).res;
    raw?.emit('close');
    source.destroy();
    return { status: response.statusCode, body: head };
  };
}

async function readAll(source: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Кадры `data: {json}` до первого кадра начала прогона или до срока. */
function readHead(source: Readable, timeoutMs: number): Promise<StreamHead> {
  return new Promise((resolve) => {
    const frames: StreamHead['frames'] = [];
    let buffer = '';
    let settled = false;
    const settle = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onEnd);
      resolve({ frames, timedOut });
    };
    const timer = setTimeout(() => settle(true), timeoutMs);
    const onEnd = (): void => settle(false);
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      let at = buffer.indexOf('\n\n');
      while (at >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf('\n\n');
        const line = block.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        const frame = parseBody(line.slice(6));
        if (!frame || typeof frame !== 'object') continue;
        frames.push(frame as Record<string, unknown>);
        if (HEAD_KINDS.has(String((frame as { kind?: unknown }).kind))) {
          settle(false);
          return;
        }
      }
    };
    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onEnd);
  });
}

function parseBody(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
