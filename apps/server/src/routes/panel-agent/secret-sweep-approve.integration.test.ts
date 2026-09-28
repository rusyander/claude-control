import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import {
  PANEL_AGENT_HEADER,
  type PanelActionResult,
  type PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';
import type { AnyPanelAction } from './registry.ts';
import {
  CONTOUR,
  idOf,
  leaks,
  ORIGIN,
  pathWithoutAgentClis,
  ROWS,
  seedFiles,
  seedThroughPanel,
  STORES,
  write,
  type Call,
  type Seeded,
} from './secret-sweep.fixture.ts';

/**
 * Проход ОДОБРЕНИЯ секретного свипа (`panel-agent-005`, ревью U0, M4, 28.09.2026).
 * `secret-sweep.integration.test.ts` доводит изменение до карточки и отклоняет —
 * результат исполнения там не виден. Здесь та же таблица `ROWS` на второй
 * временной сборке, и каждая карточка ОДОБРЯЕТСЯ: смотрим, что вернулось модели
 * после настоящего исполнения. Контур включён и активирован на стаб-платформе
 * (`tools/qa/stub-platform.mjs`), так что действия, говорящие с контуром, доходят
 * до него с настоящим ключом из хранилища.
 *
 * Граница: `fetch` к стабу — настоящий, остальной — враждебный 401 с эхом
 * заголовков. В PATH нет CLI агентов, а сетевые инструменты (npm, npx, curl…)
 * подменены заглушками, которые отказывают: одобренное действие не выйдет в сеть
 * и не поставит пакет. Каталоги всех CLI — под временным домом (проверяется до
 * сборки). Разрушительные строки идут в конце, `delete_project` — последней.
 */

/** Не одобряется: открывает редактор (окно) на машине, где идёт прогон. */
const NOT_APPROVED: Readonly<Record<string, string>> = {
  open_project_in_editor: 'launches a GUI editor on the test machine',
};
const DESTRUCTIVE = /^(delete_|remove_|uninstall_|forget_|reset_|clear_|deactivate_|disable_)/;
const LAST = ['switch_provider', 'delete_project'];
/** Выключают контур — после всех, кто с ним говорит (`reset_contour_agent_session`…). */
const CONTOUR_OFF = ['disable_contour', 'deactivate_contour', 'delete_contour'];
/**
 * Подготовка человеком перед строкой. Активация контура уже подняла шлюз, и
 * `start_gateway` честно отказал бы «ничего не изменится» — гасим его, как это
 * сделал бы человек, чтобы одобрение исполнило настоящий подъём.
 */
const PREPARE: Readonly<Record<string, () => Promise<unknown>>> = {
  start_gateway: async () => {
    const settings = (await human({ method: 'GET', url: '/api/settings' })).json() as {
      platformGateway: Record<string, unknown>;
    };
    await human({
      method: 'PATCH',
      url: '/api/settings',
      payload: { platformGateway: { ...settings.platformGateway, enabled: false } },
    });
    await human({ method: 'POST', url: '/api/platforms/gateway/restart', payload: {} });
  },
  // Снимать нечего, пока контур нигде не применён: применяем к ассистенту (его потребитель).
  disable_contour: async () => {
    const result = (
      await human({
        method: 'POST',
        url: `/api/platforms/${CONTOUR}/apply`,
        payload: { targets: ['assistant'], overwrite: ['assistant'] },
      })
    ).json() as { applied: unknown[]; skipped: unknown[] };
    if (!result.applied.length) throw new Error(`apply skipped: ${JSON.stringify(result.skipped)}`);
  },
  // «Исчерпан» ставит сам шлюз, получив 402 бюджета ключа от контура (сценарий стаба).
  clear_contour_exhausted: async () => {
    const response = await realFetch(
      `http://127.0.0.1:${gatewayPort}/${CONTOUR}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'stub-402', messages: [{ role: 'user', content: 'hi' }] }),
      },
    );
    if (response.status !== 402) throw new Error(`gateway 402 expected, got ${response.status}`);
  },
};
/** Сетевые и установочные инструменты: заглушка отказывает с кодом 1. */
const BLOCKED_TOOLS = ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'curl', 'wget', 'pip', 'uv'];
const BLOCKED_TOOLS_MORE = ['uvx', 'gh', 'glab', 'tailscale', 'code', 'cursor'];

/** m2: ключ пересекает 70-й символ первой реплики (заголовок режется на 70). */
const CHAT_TITLE = '6f4d1b63-8e2c-4d2f-a01b-2c3d4e5f6071';
/** m3: стандартный base64 со «/» — раньше «/» дробил его на куски короче порога. */
const alnum = (count: number) =>
  randomBytes(count * 2)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, count);
// Цифры и заглавные закреплены: форма ключа (≥ 3 цифр, ни одного куска-слова) не
// должна зависеть от жребия — иначе красное раз в несколько прогонов значило бы
// «канарейка не похожа на ключ», а не утечку.
const EXTRA = {
  titleCrossKey: `SwpTt${alnum(16)}4R7Q3x9K`,
  base64SlashKey: `SwpBs${alnum(9)}/K${alnum(10)}+${alnum(8)}7Q3x9K==`,
} as const;
const ALL_STORES: Readonly<Record<string, string>> = { ...STORES, ...EXTRA };

type Reach =
  | 'done'
  | 'failed'
  | 'approved-done'
  | 'approved-failed'
  | 'approved-other'
  | 'invalid'
  | 'other'
  | 'hung';

interface Observed {
  action: string;
  index: number;
  reach: Reach;
  texts: { where: string; text: string }[];
  note: string;
}

let app: FastifyInstance | undefined;
let shutdown: (() => void) | undefined;
let stub: {
  url: string;
  calls: { path: string; authorization?: string }[];
  close: () => Promise<void>;
};
let actions: readonly AnyPanelAction[] = [];
let home = '';
let gatewayPort = 0;
const realFetch = globalThis.fetch;
const observed: Observed[] = [];
const extraTexts: { where: string; text: string }[] = [];
const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'USERPROFILE',
  'HOME',
  'PATH',
  'Path',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CODEX_HOME',
  'QWEN_HOME',
  'KIMI_CODE_HOME',
  'OPENCODE_CONFIG',
  'AGENTDECK_SANDBOX_WORKDIR',
  'REGISTRY_DIR',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const human = async (options: InjectOptions) => {
  const response = await app!.inject({
    ...options,
    headers: { origin: ORIGIN, ...(options.headers ?? {}) },
  });
  if (response.statusCode >= 400) {
    throw new Error(`${options.method} ${options.url} → ${response.statusCode} ${response.body}`);
  }
  return response;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });

/** Каталог заглушек впереди PATH: каждая отказывает, ничего не скачав. */
function blockedToolsDir(): string {
  const dir = join(home, 'sweep-bin');
  for (const tool of [...BLOCKED_TOOLS, ...BLOCKED_TOOLS_MORE]) {
    write(
      join(dir, `${tool}.cmd`),
      `@echo blocked by the approve sweep: ${tool} 1>&2\r\n@exit /b 1\r\n`,
    );
    write(join(dir, tool), `#!/bin/sh\necho "blocked by the approve sweep: ${tool}" >&2\nexit 1\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return dir;
}

function seedExtraStores(config: string, project: string): void {
  const transcripts = join(config, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
  // Ключ начинается на 56-м символе: разрез на 70 оставил бы 14 знаков — больше
  // иглы «prefix-12», но меньше порога детектора.
  const lead = `${'w '.repeat(28)}`;
  const line = (uuid: string, role: 'user' | 'assistant', content: unknown) => ({
    type: role,
    uuid,
    sessionId: CHAT_TITLE,
    timestamp: '2026-09-28T11:00:00.000Z',
    cwd: project,
    message: role === 'user' ? { role, content } : { role, model: 'claude-sonnet-4-5', content },
  });
  write(
    join(transcripts, `${CHAT_TITLE}.jsonl`),
    [
      line('t1', 'user', `${lead}${EXTRA.titleCrossKey} and then some more words`),
      line('t2', 'assistant', [{ type: 'text', text: `Use token ${EXTRA.base64SlashKey} now.` }]),
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
}

beforeAll(async () => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-sweep-approve-')));
  const config = join(home, '.claude');
  const project = join(home, 'work', 'sweep-project');
  mkdirSync(project, { recursive: true });
  for (const dir of ['fresh-project', 'transfer', 'plugin']) mkdirSync(join(home, dir));
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: config,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CODEX_HOME: join(home, '.codex'),
    QWEN_HOME: join(home, '.qwen'),
    KIMI_CODE_HOME: join(home, '.kimi-code'),
    GIT_AUTHOR_NAME: 'sweep',
    GIT_AUTHOR_EMAIL: 's@example.com',
    GIT_COMMITTER_NAME: 'sweep',
    GIT_COMMITTER_EMAIL: 's@example.com',
  };
  Object.assign(process.env, env);
  for (const key of ['OPENCODE_CONFIG', 'AGENTDECK_SANDBOX_WORKDIR', 'REGISTRY_DIR']) {
    delete process.env[key];
  }
  const path = `${blockedToolsDir()}${delimiter}${pathWithoutAgentClis()}`;
  process.env.PATH = path;
  if (process.env.Path !== undefined) process.env.Path = path;
  seedFiles(config, project);
  seedExtraStores(config, project);
  write(join(home, '.agentdeck', 'api-token'), `${STORES.remoteApiToken}\n`);

  // Каталоги всех CLI и панели — под временным домом, иначе одобрение пишет в настоящие.
  const dirs = await import('../../providers/catalog/config-dirs.ts');
  const { detectClaudeLocation } = await import('../../lib/claude-paths.ts');
  const { panelHomeDirPath } = await import('../../lib/brand.mjs');
  const location = detectClaudeLocation().paths;
  const outside = [
    dirs.codexHome(),
    dirs.gooseConfigDir(),
    dirs.qwenHome(),
    dirs.kimiCodeHome(),
    dirs.continueHome(),
    dirs.opencodeConfigDir(),
    location.root,
    location.appData,
    location.mcpConfig,
    panelHomeDirPath(),
  ].filter((dir) => !dir.startsWith(home));
  if (outside.length) throw new Error(`refusing to approve over ${outside.join(', ')}`);

  // Путь не литералом: стаб — `.mjs` без типов, его форма описана здесь.
  const stubModule = pathToFileURL(
    resolve(import.meta.dirname, '../../../../../tools/qa/stub-platform.mjs'),
  ).href;
  const { startStubPlatform } = (await import(stubModule)) as {
    startStubPlatform: (options: { port: number }) => Promise<typeof stub>;
  };
  stub = await startStubPlatform({ port: 0 });
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const target = String(url instanceof Request ? url.url : url);
    if (target.startsWith(stub.url)) return realFetch(url as string, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(JSON.stringify({ error: 'unauthorized', url: target, headers }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  });

  const { default: Fastify } = await import('fastify');
  const { ServerContext } = await import('../../context.ts');
  const { createRuntime } = await import('../../bootstrap/runtime.ts');
  const { buildRouteTable } = await import('../../bootstrap/route-table.ts');
  const { registerAccessGate } = await import('../../lib/access-gate.ts');
  const { registerEmptyBodyGuard } = await import('../../lib/empty-body.ts');
  const { registerCodedErrors } = await import('../../lib/server-text.ts');
  const { allowedOrigins } = await import('../../lib/origin-guard.ts');
  ({ PANEL_ACTIONS: actions } = await import('./actions.ts'));

  const ctx = new ServerContext();
  const instance = Fastify();
  const access = {
    allowedOrigins: allowedOrigins(8888),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  registerAccessGate(instance, access);
  registerEmptyBodyGuard(instance);
  registerCodedErrors(instance);
  const runtime = createRuntime(ctx, 'http://127.0.0.1:1');
  shutdown = () => runtime.shutdown();
  for (const register of buildRouteTable(runtime, access)) register(instance, ctx);
  await instance.ready();
  app = instance;

  // Шлюз — на своём свободном порту: 5179 по умолчанию занят живой панелью.
  await human({
    method: 'PATCH',
    url: '/api/settings',
    payload: {
      platformGateway: {
        enabled: false,
        port: (gatewayPort = await freePort()),
        forceStream: true,
      },
    },
  });
  const group = await seedThroughPanel(human, project, {
    baseUrl: stub.url,
    enabled: true,
    agents: [{ id: 'helper', title: 'Helper' }],
    consumers: ['assistant'],
  });
  await human({ method: 'POST', url: `/api/platforms/${CONTOUR}/activate`, payload: {} });
  // Идентификаторы берутся заново перед КАЖДЫМ вызовом: одобренная правка меняет
  // их (у хука id — от содержимого, скилл переименован). Пропавшая запись — прежний id.
  let seeded: Seeded = {
    home,
    project,
    group,
    rule: '',
    hook: '',
    skill: '',
    script: '',
    permission: '',
  };
  const lookups: [keyof Seeded, string, string][] = [
    ['rule', '/api/rules', 'Sweep rule'],
    ['hook', '/api/hooks', 'PreToolUse'],
    ['skill', '/api/skills', 'sweep-skill'],
    ['script', '/api/scripts', 'sweep-notify'],
    ['permission', '/api/permissions', 'Bash(ls)'],
  ];
  const refresh = async () => {
    const next = { ...seeded };
    for (const [key, url, marker] of lookups) {
      next[key] = await idOf(human, url, marker).catch(() => seeded[key]);
    }
    seeded = next;
  };

  const rank = (name: string) => {
    const last = LAST.indexOf(name);
    if (last >= 0) return 3 + last;
    if (CONTOUR_OFF.includes(name)) return 2;
    // Контейнер (группа) удаляется после своих записей (кейс, шаг).
    return DESTRUCTIVE.test(name) ? (name.endsWith('_group') ? 1.5 : 1) : 0;
  };
  const ordered = [...actions].sort((a, b) => rank(a.name) - rank(b.name));
  let phase = 0;
  for (const action of ordered) {
    const row = ROWS[action.name];
    if (!row || 'skip' in row || action.name in NOT_APPROVED) continue;
    if (phase === 0 && rank(action.name) > 0) {
      // Перед разрушительными — засев заново: удалять есть что, и секреты снова на месте.
      phase = 1;
      seedFiles(config, project, { git: false });
      seedExtraStores(config, project);
    }
    await PREPARE[action.name]?.();
    for (const [index, [, input]] of row.entries()) {
      await refresh();
      observed.push(
        await approve(action, index, typeof input === 'function' ? input(seeded) : input),
      );
    }
  }
  const readChat = actions.find((action) => action.name === 'read_chat')!;
  observed.push(await approve(readChat, 1, { chat: CHAT_TITLE }));
  for (const url of ['/api/agent/journal?limit=10000', '/api/agent/pending']) {
    extraTexts.push({ where: url, text: (await human({ method: 'GET', url })).body });
  }
}, 600_000);

afterAll(async () => {
  shutdown?.();
  await app?.close();
  await stub?.close();
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

const CALL_BUDGET_MS = 30_000;

/** Вызов как у агента; КАЖДАЯ карточка этого действия одобряется человеком. */
async function approve(
  action: AnyPanelAction,
  index: number,
  input: Record<string, unknown> | undefined,
): Promise<Observed> {
  const texts: Observed['texts'] = [];
  let settled = false;
  const call = app!
    .inject({
      method: 'POST',
      url: `/api/agent/actions/${action.name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input: input ?? {} },
    })
    .finally(() => {
      settled = true;
    });
  const decided = new Set<string>();
  const started = Date.now();
  while (!settled && action.risk !== 'read' && Date.now() - started < CALL_BUDGET_MS) {
    const list = (
      await app!.inject({ method: 'GET', url: '/api/agent/pending' })
    ).json() as PanelPendingAction[];
    const card = list.find((item) => item.name === action.name && !decided.has(item.id));
    if (card) {
      decided.add(card.id);
      texts.push({ where: 'card', text: JSON.stringify(card) });
      await human({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        payload: { decision: 'approve' },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const timer = new Promise<'hung'>((resolve) =>
    setTimeout(() => resolve('hung'), CALL_BUDGET_MS).unref(),
  );
  const response = await Promise.race([call, timer]);
  if (response === 'hung') return { action: action.name, index, reach: 'hung', texts, note: '' };
  texts.push({ where: 'result', text: response.body });
  const result = response.json() as PanelActionResult;
  const outcome = result.outcome;
  // Одобренное — исполнено, каким бы ни был исход (`needs-secret` — тоже исход исполнения).
  const reach: Reach = decided.size
    ? outcome === 'done' || outcome === 'failed'
      ? `approved-${outcome}`
      : 'approved-other'
    : outcome === 'done' || outcome === 'failed' || outcome === 'invalid'
      ? outcome
      : 'other';
  return {
    action: action.name,
    index,
    reach,
    texts,
    note: `${outcome}: ${String(result.message ?? '').slice(0, 200)}`,
  };
}

const rowOf = (item: Observed) => (ROWS[item.action] as readonly Call[] | undefined)?.[item.index];

describe('secret sweep, approve pass: executed changes return no stored secret', () => {
  it('the extra stores and every CLI dir sit in the throwaway home', () => {
    expect(ALL_STORES.base64SlashKey).toContain('/');
    expect(observed.length).toBeGreaterThan(250);
  });

  it('every card row of the sweep was approved and executed (none hung, none left pending)', () => {
    const notApproved = observed
      .filter((item) => rowOf(item)?.[0] === 'card' && !item.reach.startsWith('approved-'))
      .map((item) => `${item.action}#${item.index}: ${item.reach} (${item.note})`);
    expect(notApproved).toEqual([]);
    expect(observed.filter((item) => item.reach === 'hung').map((item) => item.action)).toEqual([]);
  });

  it('contour rows reach the active contour on the stub, carrying the stored key upstream', () => {
    // Ревью U0, M4: в свипе все семь доходили только до отказа (контур выключен).
    const contourRows = [
      'ask_contour_agent',
      'read_contour_agent_session',
      'reset_contour_agent_session',
      'contour_embeddings',
      'disable_contour',
      'deactivate_contour',
      'clear_contour_exhausted',
    ];
    const reached = observed
      .filter((item) => contourRows.includes(item.action))
      .map((item) => `${item.action}: ${item.reach}`)
      .sort();
    const want = contourRows
      .map((name) => {
        const read = actions.find((action) => action.name === name)!.risk === 'read';
        return `${name}: ${read ? 'done' : 'approved-done'}`;
      })
      .sort();
    expect(reached).toEqual(want);
    const agentCall = stub.calls.find((call) => call.path.endsWith('/agent/completions'));
    expect(agentCall?.authorization).toBe(`Bearer ${STORES.contourKey}`);
  });

  it('m2/m3 containers are seen: the title chat is listed, the base64 chat is read', () => {
    const listed = observed.find((item) => item.action === 'list_chats' && item.reach === 'done');
    expect(listed?.texts.some(({ text }) => text.includes(CHAT_TITLE))).toBe(true);
    const read = observed.find((item) => item.action === 'read_chat' && item.index === 1);
    expect(read?.reach).toBe('done');
    expect(read?.texts.some(({ text }) => text.includes('Use token'))).toBe(true);
  });

  it('no canary (any form) in a result, a card, the journal or the pending list', () => {
    const found = [
      ...observed.flatMap((item) =>
        leaks(item.texts, ALL_STORES).map((leak) => `${item.action}#${item.index}: ${leak}`),
      ),
      ...leaks(extraTexts, ALL_STORES),
    ];
    expect(found).toEqual([]);
  });

  it('report: rows that still reach only a refusal (printed for the ledger)', () => {
    const refused = observed
      .filter((item) => item.reach === 'failed' || item.reach === 'invalid')
      .map((item) => `${item.action}#${item.index}: ${item.note}`);
    if (process.env.SWEEP_APPROVE_REPORT) {
      write(
        process.env.SWEEP_APPROVE_REPORT,
        JSON.stringify(
          observed.map(({ action, index, reach, note }) => ({ action, index, reach, note })),
          null,
          2,
        ),
      );
    }
    expect(refused.length).toBeLessThan(observed.length);
  });
});
