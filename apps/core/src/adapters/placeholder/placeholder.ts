import type { AdapterCaps, CliAdapter } from '../adapter.types.ts';

/**
 * Факты CLI, нужные заготовке: id, бинарь, вход. Приходят параметром от `adapters/<cli>` — реестр
 * сюда не импортируется (P108: общая часть слоя никого не называет); факты запуска реестра
 * подходят по форме.
 */
export interface PlaceholderFacts {
  id: string;
  binary: { command: string };
  login: AdapterCaps['login'];
}

/**
 * Заготовка переходника (этап 10): CLI зарегистрирован в `FACTORIES`, чтобы реестр, compat и
 * панель знали его id, но запускать его ядро ещё не умеет. Все возможности — `false`: compat
 * отказывает по ним раньше запуска, а сам запуск отвечает `adapter_not_built` — никогда не
 * «запустилось кое-как». Возможность включает только настоящий переходник со своим профилем
 * набора соответствия (`adapters/conformance/__fixtures__/profiles/<cli>.ts`); набор держит это различие.
 */

export const NOT_BUILT = 'adapter_not_built';

export function placeholderCaps(facts: PlaceholderFacts): AdapterCaps {
  return {
    resume: false,
    mcp: false,
    strictMcp: false,
    permissionTool: false,
    denyOverlay: false,
    preToolHooks: false,
    layerControl: false,
    attribution: false,
    stream: false,
    effort: false,
    images: false,
    subagents: false,
    skillControl: false,
    subagentHooks: false,
    login: facts.login,
    channels: [],
    windowEvent: false,
    limitsChannel: null,
  };
}

export function createPlaceholderAdapter(facts: PlaceholderFacts): CliAdapter {
  const why = `${NOT_BUILT}: ${facts.id} is registered, its adapter is not built yet`;
  return {
    id: facts.id,
    built: false,
    images: [facts.binary.command],
    caps: placeholderCaps(facts),
    readLayer: () => ({ dirs: [], credentials: [] }),
    bindEndpoint: () => ({ ok: false, code: NOT_BUILT }),
    launch: () => Promise.resolve({ ok: false, reason: why }),
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
    send: () => Promise.reject(new Error(why)),
    stop: () => Promise.resolve({ how: 'already-exited', residual: [], reason: why }),
    // Вопроса о праве заготовка не разбирает: «другое» — судья ядра решает строже, а не мягче.
    mapPermission: (raw) => ({
      action: 'other',
      target: raw.tool,
      tool: raw.tool,
      display: raw.tool,
    }),
    permitCodec: { read: () => undefined, render: () => null },
    usage: () => [],
  };
}
