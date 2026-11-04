import type { LocalHoldBody, LocalHoldView } from '@agentdeck/contracts/core/local-hold';
import type { CoreHold } from '../core-hold.ts';
import { localError } from '../errors.ts';
import { PRESET_KEY_OF } from '../server.ts';

/**
 * Подставное удержание ядра для проверок раздела: сервис зовёт `hold`/`release`, как зовёт ядро,
 * а проверка видит запуск флагами `llama-server` (`-m`, `--alias`, `-ctk` …) — теми же, что видела
 * при своём запуске панели, поэтому её утверждения о флагах остались в силе. Само удержание ядра
 * (слот, память карты, маршрутизатор) проверяют `apps/core` `hold.integration.test.ts` и живой стенд.
 */

const FLAG_OF: Record<string, string> = Object.fromEntries(
  Object.entries(PRESET_KEY_OF).map(([flag, key]) => [key, flag]),
);

/** Пресет обратно во флаги командной строки: проверки ищут `-ctk`, `-c`, `--cache-ram`. */
export function flagsOfHold(body: LocalHoldBody): string[] {
  const flags = ['-m', body.model.path, '--alias', body.model.id];
  for (const [key, value] of Object.entries(body.model.args ?? {}))
    flags.push(FLAG_OF[key] ?? `--${key}`, value);
  return flags;
}

export interface FakeHoldCall {
  flags: string[];
  env: Record<string, string>;
  body: LocalHoldBody;
}

export interface FakeCoreHold extends CoreHold {
  /** Все удержания по порядку. */
  readonly calls: FakeHoldCall[];
  /** Сколько раз освобождали. */
  readonly releases: number;
}

/**
 * `hold` — что делает «ядро» при загрузке: вернуть номер процесса или бросить отказ
 * (`refuse(...)`). Новое удержание при живом прежнем сначала освобождает прежнее — как ядро.
 */
export function fakeCoreHold(options: {
  hold: (call: FakeHoldCall) => number | Promise<number>;
  release?: (pid: number) => void | Promise<void>;
  /** Ядро уже держит модель (удержание пережило перезапуск панели): номер процесса и имя. */
  initial?: { pid: number; model: string };
}): FakeCoreHold {
  const calls: FakeHoldCall[] = [];
  let releases = 0;
  let held: { pid: number; body: LocalHoldBody; since: string } | undefined = options.initial
    ? {
        pid: options.initial.pid,
        body: {
          server: { command: 'llama-server' },
          model: { id: options.initial.model, path: '', sizeBytes: 1, contextTokens: 1 },
        },
        since: new Date().toISOString(),
      }
    : undefined;
  const view = (): LocalHoldView => ({
    held: held
      ? {
          model: held.body.model.id,
          origin: null,
          pid: held.pid,
          since: held.since,
          ...(held.body.meta ? { meta: held.body.meta } : {}),
        }
      : null,
    live: held !== undefined,
    front: null,
  });
  const drop = async (): Promise<void> => {
    if (!held) return;
    releases += 1;
    const { pid } = held;
    held = undefined;
    await options.release?.(pid);
  };
  return {
    calls,
    get releases() {
      return releases;
    },
    async hold(body) {
      await drop();
      const call = { flags: flagsOfHold(body), env: body.server.env ?? {}, body };
      calls.push(call);
      const pid = await options.hold(call);
      held = { pid, body, since: new Date().toISOString() };
      return view();
    },
    async release() {
      const had = held !== undefined;
      await drop();
      return { released: had, verified: [], leaks: [] };
    },
    async view() {
      return view();
    },
  };
}

/** Отказ «ядра» тем же путём, что `core-hold.ts` превращает ответ API ядра в ошибку раздела. */
export function refuse(code: string, reason: string): Error {
  return localError('local-hold-refused', `ядро отказало (${code}): ${reason}`, { code, reason });
}
