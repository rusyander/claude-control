import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HopControlReply,
  HopRegisterReply,
  HopRegisterSpec,
} from '@agentdeck/contracts/core/hops';
import {
  startStubModel,
  type RouteReply,
  type RouteRequest,
  type Script,
  type StubModel,
} from '@agentdeck/stub-model';
import { readToken } from '../../platform/token-file.ts';
import { startHopHost, type HopHostDeps, type RunningHopHost } from '../host.ts';
import type { HopHostConfig } from '../host.types.ts';

/**
 * Та же форма, что `HopHostHandle` клиента ядра: тесты передают её в `routes/hops`, а сам стенд
 * клиента не импортирует — хост не знает слоя маршрутов (depcruise `core-hop-host-thin`).
 */
export interface StandHandle {
  url: string;
  token: string;
  pid: number;
  dlpPort: number | null;
  gatewayPort: number | null;
  launched: boolean;
}

/** Регистрация по протоколу управления; отказ — исключение с кодом хоста. */
async function registerVia(
  handle: StandHandle,
  spec: HopRegisterSpec,
  sessionKey?: string,
): Promise<HopRegisterReply> {
  const response = await fetch(`${handle.url}/hops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
    body: JSON.stringify({ op: 'register', spec, ...(sessionKey ? { sessionKey } : {}) }),
  });
  const reply = (await response.json()) as HopControlReply;
  if (!reply.ok) throw Object.assign(new Error(reply.detail), { code: reply.code });
  if (reply.op !== 'register') throw new Error(`unexpected reply ${reply.op}`);
  return reply.reply;
}

/**
 * Стенд звена в процессе теста: подставной контур (`@agentdeck/stub-model`, сценарий — данные
 * теста), хост звеньев на временном доме и клиент ядра (`routes/hops`) — регистрация идёт тем же
 * путём, что у ядра. Наблюдатель `route` пакета видит СЫРЫЕ заголовки запроса наверх: след пакета
 * прячет значения доступа, а тесту нужен именно ключ, который подставило звено.
 */

export interface HopStand {
  home: string;
  appData: string;
  stub: StubModel;
  host: RunningHopHost;
  handle: StandHandle;
  /** Сырые запросы, дошедшие до контура (каждый, включая отказанные сценарием). */
  seen: RouteRequest[];
  /** `sessionKey` — значение ключа `env` из пина задачи, как его передаёт ядро (`registerTag`). */
  register(
    over?: Partial<HopRegisterSpec>,
    sessionKey?: string,
  ): Promise<{ port: number; placeholder: string }>;
  close(): Promise<void>;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function hopStand(options: {
  script: Script;
  config?: Partial<HopHostConfig>;
  deps?: HopHostDeps;
  /** Подготовить каталог данных панели до старта хоста (ключи, правила). */
  prepare?: (appData: string) => void;
  /** Свой ответ контура на запрос (451 вендорного тела); `undefined` — дальше сценарию. */
  reply?: (request: RouteRequest) => RouteReply | undefined;
}): Promise<HopStand> {
  const home = tempDir('hop-home-');
  const appData = tempDir('hop-app-');
  options.prepare?.(appData);
  const seen: RouteRequest[] = [];
  const stub = await startStubModel({
    script: options.script,
    route: (request) => {
      if (request.path.endsWith('/messages') || request.path.endsWith('/completions'))
        seen.push(request);
      return options.reply?.(request);
    },
  });
  const host = await startHopHost(
    { home, panelAppData: appData, retryPauseMs: 10, stallMs: 5_000, ...options.config },
    options.deps,
  );
  const token = readToken(join(home, 'hops', 'control.token'));
  if (!('value' in token)) throw new Error('control token unreadable');
  const handle: StandHandle = {
    url: `http://127.0.0.1:${host.ports.control}`,
    token: token.value,
    pid: process.pid,
    dlpPort: host.ports.dlp,
    gatewayPort: host.ports.gateway,
    launched: false,
  };
  let n = 0;
  return {
    home,
    appData,
    stub,
    host,
    handle,
    seen,
    register: (over = {}, sessionKey) => {
      n += 1;
      return registerVia(
        handle,
        {
          tag: `tag-${n}`,
          sessionId: `session-${n}`,
          routeId: 'route-stub',
          upstream: stub.baseUrl,
          from: 'anthropic-messages',
          to: 'anthropic-messages',
          keyRef: null,
          dlp: { required: false, rulesHash: null },
          features: [],
          ...over,
        } as HopRegisterSpec,
        sessionKey,
      );
    },
    close: async () => {
      await host.close();
      await stub.close();
    },
  };
}

/** Запрос CLI к звену: заглушка ключа — в заголовке своего диалекта. */
export async function ask(
  port: number,
  placeholder: string,
  dialect: 'anthropic' | 'openai',
  body: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const anthropic = dialect === 'anthropic';
  const response = await fetch(
    `http://127.0.0.1:${port}${anthropic ? '/v1/messages' : '/v1/chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(anthropic
          ? { 'x-api-key': placeholder, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${placeholder}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

export function anthropicBody(text: string, stream = false): Record<string, unknown> {
  return {
    model: 'stub-model',
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: text }],
  };
}

/** Все файлы под каталогом — для поиска посаженного ключа (P112). */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

export function filesContaining(dir: string, needle: string): string[] {
  return filesUnder(dir).filter((path) => readFileSync(path).includes(needle));
}
