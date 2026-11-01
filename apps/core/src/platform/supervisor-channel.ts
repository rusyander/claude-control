import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { removeChannel } from './control-channel.ts';
import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Канал надзора (07:69-71, P131): сторож панели (`dev-watch`, `keepalive`) называет ядру pid
 * звеньев пересылки — сервера панели и Vite — сразу после их запуска, до первой команды через
 * них. Имя канала (именованный канал Windows, unix-сокет в личном каталоге) видно любому
 * процессу машины, поэтому право говорить даёт только файл `supervisor-token` в доме ядра.
 *
 * Сам токен по каналу не ходит: обе стороны доказывают знание HMAC над свежими числами друг
 * друга. Подслушавший канал не получает ни токена, ни повторяемого сообщения, а клиент не
 * примет ответ самозванца, занявшего имя канала раньше ядра.
 *
 * Протокол — по строке JSON на сообщение:
 *   ядро → `{"hello":S}`
 *   сторож → `{"op":"hops.set","hops":[pid…],"nonce":C,"proof":hmac("hops.set\nS\nC\npid,pid")}`
 *   ядро → `{"body":"<json>","proof":hmac("reply\nC\n<json>")}` и закрывает соединение.
 * Та же схема записана в `apps/server/src/lib/hop-recorder.mjs` (панель кода ядра не
 * импортирует); расхождение валит интеграционный тест P131, который гоняет их друг с другом.
 */

export const SUPERVISOR_TOKEN_FILE = 'supervisor-token';
export const MAX_HOPS = 16;
const MAX_LINE = 64 * 1024;
const TIMEOUT_MS = 5_000;
const NONCE = /^[0-9a-f]{32,128}$/;

export type HopsReply =
  | {
      ok: true;
      accepted: number[];
      refused: { pid: number; reason: string }[];
      recordedAt: number;
    }
  | { ok: false; code: string; detail: string };

export interface SupervisorHandler {
  /** Заменить набор доверенных звеньев; ответ уходит сторожу как есть. */
  hopsSet(pids: readonly number[]): Promise<HopsReply>;
}

export function proofOf(token: string, parts: readonly string[]): string {
  return createHmac('sha256', token).update(parts.join('\n')).digest('hex');
}

function sameProof(given: unknown, want: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Разбор просьбы сторожа; ошибка — код отказа, ничего из просьбы не применено. */
function parseRequest(
  line: string,
  token: string,
  hello: string,
): { pids: number[]; nonce: string } | { nonce?: string; code: string; detail: string } {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { code: 'bad-request', detail: 'not JSON' };
  }
  if (!message || typeof message !== 'object') return { code: 'bad-request', detail: 'not object' };
  const { op, hops, nonce, proof } = message as Record<string, unknown>;
  if (typeof nonce !== 'string' || !NONCE.test(nonce))
    return { code: 'bad-request', detail: 'nonce is not hex' };
  if (op !== 'hops.set') return { nonce, code: 'bad-op', detail: `unknown op ${String(op)}` };
  const valid =
    Array.isArray(hops) &&
    hops.length <= MAX_HOPS &&
    hops.every((pid) => Number.isInteger(pid) && (pid as number) > 0);
  if (!valid)
    return { nonce, code: 'bad-hops', detail: `hops: up to ${MAX_HOPS} positive integer pids` };
  const pids = hops as number[];
  if (!sameProof(proof, proofOf(token, ['hops.set', hello, nonce, pids.join(',')])))
    return { nonce, code: 'bad-proof', detail: 'proof does not match supervisor-token' };
  return { pids, nonce };
}

function serve(socket: Socket, token: string, handler: SupervisorHandler): void {
  const hello = randomBytes(16).toString('hex');
  let buffer = '';
  let done = false;
  socket.setEncoding('utf8');
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  const answer = (nonce: string | undefined, body: HopsReply) => {
    const text = JSON.stringify(body);
    // Без числа клиента доказать ответ нечем: клиент такой ответ всё равно не примет.
    const proof = nonce ? proofOf(token, ['reply', nonce, text]) : '';
    socket.end(`${JSON.stringify({ body: text, proof })}\n`);
  };
  socket.on('data', (chunk: string) => {
    if (done) return;
    buffer += chunk;
    const at = buffer.indexOf('\n');
    if (at < 0) {
      if (buffer.length > MAX_LINE) socket.destroy();
      return;
    }
    done = true;
    const parsed = parseRequest(buffer.slice(0, at), token, hello);
    if ('code' in parsed) {
      answer(parsed.nonce, { ok: false, code: parsed.code, detail: parsed.detail });
      return;
    }
    handler.hopsSet(parsed.pids).then(
      (reply) => answer(parsed.nonce, reply),
      (error: unknown) =>
        answer(parsed.nonce, {
          ok: false,
          code: 'hops-failed',
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  });
  socket.write(`${JSON.stringify({ hello })}\n`);
}

export interface SupervisorChannel {
  path: string;
  close(): Promise<void>;
}

/**
 * Поднять канал на `path` (имя выбирает загрузка: канал Windows или сокет в личном каталоге
 * POSIX). Прежний сокет того же имени убирается — имя содержит `bootId`, живого владельца у
 * него быть не может.
 */
export async function openSupervisorChannel(opts: {
  path: string;
  token: string;
  handler: SupervisorHandler;
  os?: OsKind;
}): Promise<SupervisorChannel> {
  const os = opts.os ?? currentOs();
  removeChannel(opts.path, os);
  const server: Server = createServer((socket) => serve(socket, opts.token, opts.handler));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Канал не держит процесс ядра живым: остановку ведёт загрузка.
  server.unref();
  return {
    path: opts.path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          removeChannel(opts.path, os);
          resolve();
        });
      }),
  };
}
