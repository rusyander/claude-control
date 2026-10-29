import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterEvent,
  CliAdapter,
  PlatformDenyFacts,
  SessionHandle,
  SessionSpec,
} from '../../adapter.types.ts';
import { liveBase } from '../../../platform/__fixtures__/clean-base.ts';

/**
 * Живой стенд набора соответствия: одноразовый дом, каталог конфигурации и рабочая папка;
 * окружение закреплено целиком. Windows (libuv) подставляет «обязательные» переменные
 * профиля из окружения РОДИТЕЛЯ, если их нет в закреплённом, — поэтому дом и профиль
 * задаются здесь явно, иначе CLI читал бы настоящий конфиг человека.
 */

export const HOOK_LOG = fileURLToPath(new URL('./hook-log.mjs', import.meta.url));
export const PERMIT_SERVER = fileURLToPath(new URL('./permit-server.mjs', import.meta.url));

const quote = (value: string): string => `"${value}"`;

export interface LiveRoot {
  root: string;
  home: string;
  cwd: string;
  sessions: string;
  logs: { core: string; recorder: string; user: string; permit: string };
}

export function liveRoot(prefix = 'adp-live-'): LiveRoot {
  const root = realpathSync(mkdtempSync(join(liveBase(), prefix)));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const sessions = join(root, 'sessions');
  for (const dir of [
    home,
    cwd,
    sessions,
    join(home, 'AppData', 'Roaming'),
    join(home, 'AppData', 'Local'),
  ])
    mkdirSync(dir, { recursive: true });
  const logs = {
    core: join(root, 'core-hook.jsonl'),
    recorder: join(root, 'recorder.jsonl'),
    user: join(root, 'user-hook.jsonl'),
    permit: join(root, 'permit.jsonl'),
  };
  return { root, home, cwd, sessions, logs };
}

/** Закреплённое окружение: PATH и системное — от процесса теста, дом и профиль — одноразовые. */
export function livePin(
  live: LiveRoot,
  extra: Record<string, string> = {},
): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'LANG'];
  const pin: Record<string, string> = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) pin[name] = value;
  }
  return {
    ...pin,
    HOME: live.home,
    USERPROFILE: live.home,
    APPDATA: join(live.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(live.home, 'AppData', 'Local'),
    HOMEDRIVE: '',
    HOMEPATH: '',
    ...extra,
  };
}

export function hookCommand(role: string, log: string): string {
  return `${quote(process.execPath)} ${quote(HOOK_LOG)} ${role} --log ${quote(log)}`;
}

/** Дом ядра и токен панели одноразового стенда — запреты платформы каждого сеанса. */
export function liveFacts(live: LiveRoot): PlatformDenyFacts {
  return { coreHome: join(live.root, 'core-home'), tokenFiles: [join(live.root, 'api-token')] };
}

let seq = 0;

export function liveSpec(live: LiveRoot, over: Partial<SessionSpec> = {}): SessionSpec {
  seq += 1;
  const sessionId = over.sessionId ?? crypto.randomUUID();
  return {
    sessionId,
    dir: join(live.sessions, `s${seq}`),
    cwd: live.cwd,
    brief: 'BRIEF_MARKER first brief of the step',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: liveFacts(live),
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on' },
    // Стенд — доверенный репозиторий (отметка панели): случаи слоя `on` проверяют `on`. Случай
    // недоверенной копии снимает отметку сам (F-86).
    trust: { sourceRepo: live.cwd, panelMark: true },
    env: { pin: livePin(live) },
    core: {
      taskId: 'task-live',
      stepId: 'step-live',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'session-token-value',
    },
    ...over,
  };
}

/** Один итератор событий на сессию: ждать условия можно много раз подряд. */
export class EventTap {
  readonly seen: AdapterEvent[] = [];
  private readonly iterator: AsyncIterator<AdapterEvent>;
  private done = false;

  constructor(adapter: CliAdapter, handle: SessionHandle) {
    this.iterator = adapter.events(handle)[Symbol.asyncIterator]();
  }

  get ended(): boolean {
    return this.done;
  }

  async until(match: (event: AdapterEvent) => boolean, timeoutMs = 60_000): Promise<AdapterEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0 || this.done) {
        throw new Error(
          `no matching event (${this.done ? 'stream ended' : 'timeout'}); seen: ${this.seen
            .map((e) => e.type)
            .join(',')}`,
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        this.iterator.next(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), left);
        }),
      ]);
      clearTimeout(timer);
      if (next === 'timeout') continue;
      if (next.done) {
        this.done = true;
        continue;
      }
      this.seen.push(next.value);
      if (match(next.value)) return next.value;
    }
  }
}

export function readJsonLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
