import type { AbortLike } from '@agentdeck/contracts/core/routes';
import { sleep } from '../../../platform/os-kind.ts';
import { RouteAborted } from '../../lease.ts';
import { matchRouterId } from './model-id.ts';

/**
 * HTTP к своему llama-server в режиме маршрутизатора (`--models-preset`, сборка 11193, замер
 * 28.10): `GET /models` → `{ data: [{ id, status: { value: 'unloaded' | 'loading' | 'loaded',
 * failed?, exit_code? } }] }`, `POST /models/load|unload { model }` → `{ success: true }`.
 * Загрузка и выгрузка асинхронны — исход читается опросом списка, а не ответом на POST.
 */

export type RouterModelState = 'loaded' | 'loading' | 'unloaded' | 'failed';

export interface RouterModel {
  id: string;
  state: RouterModelState;
  /** Код выхода раннера, если загрузка упала. */
  exitCode?: number;
}

export interface RouterClientOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  pollMs?: number;
}

export interface RouterClient {
  healthy(): Promise<boolean>;
  models(): Promise<RouterModel[]>;
  /** Загрузить и дождаться `loaded`; упала или срок вышел — исключение с причиной. */
  /** Снятая задача (`signal`) прерывает ожидание на ближайшем опросе — `RouteAborted` (F-65). */
  load(model: string, timeoutMs: number, signal?: AbortLike): Promise<void>;
  /** Выгрузить и дождаться, что ни одна модель не `loaded`/`loading`. */
  unload(model: string, timeoutMs: number): Promise<RouterModel[]>;
}

function parseModels(body: unknown): RouterModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('router /models: no data array');
  return data.map((row: unknown) => {
    const item = row as {
      id?: unknown;
      status?: { value?: unknown; failed?: unknown; exit_code?: unknown };
    };
    if (typeof item.id !== 'string') throw new Error('router /models: row without id');
    const value = item.status?.value;
    const failed = item.status?.failed === true;
    const exit = item.status?.exit_code;
    let state: RouterModelState = 'unloaded';
    if (value === 'loaded' || value === 'loading') state = value;
    if (failed) state = 'failed';
    return { id: item.id, state, ...(typeof exit === 'number' ? { exitCode: exit } : {}) };
  });
}

export function createRouterClient(
  origin: string,
  options: RouterClientOptions = {},
): RouterClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.requestTimeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 250;

  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`router ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };

  const models = async (): Promise<RouterModel[]> => parseModels(await call('/models'));
  /** Имя модели у маршрутизатора: секцию пресета он мог переименовать (`model-id.ts`). */
  const routerId = async (model: string): Promise<string> => {
    const ids = (await models()).map((item) => item.id);
    return matchRouterId(ids, model) ?? model;
  };

  const until = async (
    what: string,
    timeoutMs: number,
    done: (list: RouterModel[]) => boolean | Error,
    signal?: AbortLike,
  ): Promise<RouterModel[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new RouteAborted(`model load (wait for ${what})`);
      const list = await models();
      const verdict = done(list);
      if (verdict instanceof Error) throw verdict;
      if (verdict) return list;
      if (Date.now() >= deadline) throw new Error(`router: ${what} not reached in ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  };

  return {
    healthy: async () => {
      try {
        await call('/health');
        return true;
      } catch {
        return false;
      }
    },
    models,
    load: async (model, timeoutMs, signal) => {
      if (signal?.aborted) throw new RouteAborted('model load');
      const id = await routerId(model);
      await call('/models/load', { model: id });
      await until(
        `${id} loaded`,
        timeoutMs,
        (list) => {
          const row = list.find((item) => item.id === id);
          if (!row) return new Error(`router does not list ${id}`);
          if (row.state === 'failed')
            return new Error(`router failed to load ${id} (exit ${row.exitCode ?? '?'})`);
          return row.state === 'loaded';
        },
        signal,
      );
    },
    unload: async (model, timeoutMs) => {
      const id = await routerId(model);
      await call('/models/unload', { model: id });
      return until('no loaded model', timeoutMs, (list) =>
        list.every((item) => item.state !== 'loaded' && item.state !== 'loading'),
      );
    },
  };
}
