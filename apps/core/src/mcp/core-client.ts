import { httpJson, type HttpJsonCall, type HttpJsonOutcome } from '../platform/http-json.ts';

/**
 * Мост MCP → ядро. Сессия переживает перезапуск ядра (01 §Sessions at core death): пока ядро
 * не принимает соединение, мост повторяет — недошедший запрос повторять безопасно. Запрос,
 * который дошёл (ответ потерян, срок вышел), не повторяется: второй `step_done` был бы уже
 * другим вызовом.
 *
 * Исключение — запрос без последствий (`idempotent`: вопрос о праве, чтение): дошедший и
 * оборванный несётся НОВОМУ ядру — тому, что зарегистрировалось после обрыва (`newCore`), и только
 * ему: прежнее живое ядро ответ уже засчитало, второй вопрос оно сочло бы подделкой. `503`
 * (ядро ещё не прикрепило сессию) повторяется в том же окне.
 */

export interface CoreClientOptions {
  url: string;
  token: string;
  /** Сколько ждать ядро, которое не принимает соединение (мс). */
  retryForMs: number;
  stepMs: number;
  timeoutMs: number;
  http?: (call: HttpJsonCall) => Promise<HttpJsonOutcome>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Где ядро слушает сейчас (`<core home>/procs.json`, P83): перезапущенное ядро берёт новый
   * порт, сессия и её мост переживают его (01 §Sessions at core death). `null` — нового нет.
   */
  rediscover?: (current: string) => string | null | Promise<string | null>;
  /** Адрес ядра, запущенного позже `since` (мс); `null` — такого ещё нет. */
  newCore?: (since: number) => string | null | Promise<string | null>;
  /**
   * Сколько повторять `503` (ядро живо, но сессию ещё не прикрепило), мс; по умолчанию 15 с.
   * Постоянный 503 иначе держал бы вопрос CLI всё окно перезапуска (core-s2 F-91).
   */
  unavailableForMs?: number;
}

const UNAVAILABLE_FOR_MS = 15_000;

export interface CallOptions {
  /** Повтор безвреден: дошедший и оборванный запрос можно нести новому ядру. */
  idempotent?: boolean;
}

export interface CoreClient {
  get(path: string): Promise<HttpJsonOutcome>;
  post(path: string, body: unknown, call?: CallOptions): Promise<HttpJsonOutcome>;
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function createCoreClient(opts: CoreClientOptions): CoreClient {
  const http = opts.http ?? httpJson;
  const sleep = opts.sleep ?? wait;
  const now = opts.now ?? Date.now;
  const trim = (url: string): string => url.replace(/\/+$/, '');
  let base = trim(opts.url);

  const send = async (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    idempotent: boolean,
  ): Promise<HttpJsonOutcome> => {
    const until = now() + opts.retryForMs;
    let unavailableUntil: number | undefined;
    // Запрос дошёл и оборвался: ждём ядро, запущенное после обрыва, прежнему не шлём.
    let lost: { at: number; outcome: HttpJsonOutcome } | undefined;
    for (;;) {
      if (lost) {
        const fresh = await opts.newCore?.(lost.at);
        if (!fresh) {
          if (now() >= until) return lost.outcome;
          await sleep(opts.stepMs);
          continue;
        }
        base = trim(fresh);
        lost = undefined;
      }
      const outcome = await http({
        url: `${base}${path}`,
        method,
        bearer: opts.token,
        ...(body === undefined ? {} : { body }),
        timeoutMs: opts.timeoutMs,
      });
      if (outcome.kind === 'reply') {
        // 503 ядра — «не обработано»: повтор безопасен и для вызова с последствиями, но в
        // своём коротком окне (core-s2 F-91).
        if (outcome.status !== 503) return outcome;
        unavailableUntil ??= now() + (opts.unavailableForMs ?? UNAVAILABLE_FOR_MS);
        if (now() >= Math.min(until, unavailableUntil)) return outcome;
      } else if (!outcome.refused) {
        if (!idempotent || !opts.newCore || now() >= until) return outcome;
        lost = { at: now(), outcome };
      } else {
        // Соединение не принято — запрос не дошёл, его можно нести новому ядру.
        const moved = await opts.rediscover?.(base);
        if (moved) base = trim(moved);
        if (now() >= until) return outcome;
      }
      await sleep(opts.stepMs);
    }
  };
  return {
    get: (path) => send('GET', path, undefined, true),
    post: (path, body, call) => send('POST', path, body, call?.idempotent === true),
  };
}
