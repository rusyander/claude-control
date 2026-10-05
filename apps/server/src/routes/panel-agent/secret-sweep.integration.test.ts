import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PANEL_AGENT_HEADER,
  type PanelActionResult,
  type PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';
import type { AnyPanelAction } from './registry.ts';
import {
  CHAT,
  CONTOUR,
  ENDPOINT,
  idOf,
  leaks,
  MCP_HTTP,
  ORIGIN,
  pathWithoutAgentClis,
  ROWS,
  seedFiles,
  seedThroughPanel,
  STORES,
  write,
  type Call,
  type Reach,
  type Seeded,
  type Store,
} from './secret-sweep.fixture.ts';

/**
 * Секреты не доезжают до модели (D8, `panel-agent-005`). Настоящая сборка
 * сервера на временном домашнем каталоге; в КАЖДОМ хранилище секретов лежит
 * своя метка-канарейка; КАЖДОЕ действие агента вызывается настоящим маршрутом
 * `POST /api/agent/actions/:name` — чтение исполняется, изменение доходит до
 * карточки и отклоняется кликом человека. Красное — канарейка в ответе модели,
 * в карточке или в следе агента.
 *
 * Полнота — по `PANEL_ACTIONS`: новое действие без строки в `ROWS`
 * (`secret-sweep.fixture.ts`) красное, и строка
 * говорит, до чего вызов обязан дойти, — строка, тихо скатившаяся в «неверный
 * вход», проверяла бы пустоту.
 *
 * Внешняя граница подменена целиком: `fetch` отвечает 401 и эхом присланных
 * заголовков (враждебный сервер), CLI в PATH нет вовсе. Остальное настоящее.
 */

// ---- ROWS/STORES/seeding moved to secret-sweep.fixture.ts — add rows THERE ----

/**
 * Где модель видит КОНТЕЙНЕР секрета — запись, сервер, контур — без самого
 * значения. Без этого зелёный мог бы значить «до хранилища вызов не дошёл».
 */
const EXPOSED: Readonly<Record<Store, readonly [action: string, marker: string]>> = {
  settingsEnv: ['list_env', 'SWEEP_API_TOKEN'],
  settingsLocalEnv: ['list_env', 'SWEEP_LOCAL_SECRET'],
  secretsEnv: ['list_env', 'SWEEP_VAULT_PASSWORD'],
  mcpEnv: ['list_mcp', 'SWEEP_MCP_API_KEY'],
  mcpArgs: ['list_mcp', '--api-key'],
  mcpHeader: ['list_mcp', MCP_HTTP],
  mcpUrl: ['list_mcp', 'mcp.example.com'],
  projectMcpEnv: ['list_project_mcp', 'SWEEP_PROJECT_MCP_KEY'],
  projectMcpHeader: ['list_project_mcp', 'X-Api-Key'],
  projectSettingsEnv: ['read_project_file', 'SWEEP_PROJECT_SECRET'],
  projectDotenv: ['read_project_file', 'DB_PASSWORD'],
  hookCommand: ['list_hooks', '--token'],
  permissionRule: ['list_permissions', 'api.example.com'],
  scriptBody: ['read_script', 'NOTIFY_API_TOKEN'],
  groupEnv: ['list_env', 'SWEEP_GROUP_TOKEN'],
  contourKey: ['list_contours', CONTOUR],
  endpointToken: ['list_endpoints', ENDPOINT],
  atlassianToken: ['list_integrations', 'atlassian'],
  confluenceToken: ['list_integrations', 'atlassian'],
  forgeToken: ['list_integrations', 'forge'],
  telegramToken: ['list_integrations', 'telegram'],
  tmsToken: ['list_integrations', 'tms'],
  ciToken: ['list_integrations', '"ci"'],
  webhookToken: ['list_integrations', 'webhook'],
  testEnvSecret: ['read_tests_report', 'STAND_PASSWORD'],
  remoteApiToken: ['get_settings', 'remoteAccess'],
  cliOauthToken: ['read_account', '{'],
  panelApiKey: ['read_account', '{'],
  backupPassphrase: ['list_backups', '{'],
  runnerScript: ['read_project_file', 'server.js'],
  chatPastedKey: ['list_chats', CHAT],
  ruleBodyKey: ['list_rules', 'Sweep rule'],
};

// ---- the live app assembly on a throwaway home ----

interface Observed {
  action: string;
  index: number;
  reach: Reach | 'invalid' | 'unknown' | 'hung' | 'other';
  /** Всё, что вернулось модели, и карточка, если она была. */
  texts: { where: string; text: string }[];
  note: string;
}

let app: FastifyInstance | undefined;
let shutdown: (() => void) | undefined;
let actions: readonly AnyPanelAction[] = [];
let home = '';
let seeded: Seeded;
const observed: Observed[] = [];
const extraTexts: { where: string; text: string }[] = [];
const upstream: string[] = [];
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  Path: process.env.Path,
};

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

beforeAll(async () => {
  // Длинное написание: реестр проектов хранит его, и короткое имя 8.3 временного
  // каталога (`RUSYAN~1`) не нашло бы зарегистрированный проект.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-sweep-home-')));
  const config = join(home, '.claude');
  const project = join(home, 'work', 'sweep-project');
  mkdirSync(project, { recursive: true });
  // Существующие пустые каталоги — цели действий, которые пишут в новый каталог.
  for (const dir of ['fresh-project', 'transfer', 'plugin']) mkdirSync(join(home, dir));
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  // Редактор в PATH — свой, фальшивый: строка `open_project_in_editor` ждёт
  // карточку, а до неё доходит только там, где редактор найден. У разработчика
  // VS Code стоит, на раннере CI — нет, и строка краснела бы от машины. Карточку
  // здесь не одобряют, так что сам файл не запускается никогда.
  const editorBin = join(home, 'bin');
  mkdirSync(editorBin);
  writeFileSync(join(editorBin, 'code.cmd'), '@echo off\r\n');
  writeFileSync(join(editorBin, 'code'), '#!/bin/sh\n', { mode: 0o755 });
  const path = `${editorBin}${delimiter}${pathWithoutAgentClis()}`;
  process.env.PATH = path;
  if (process.env.Path !== undefined) process.env.Path = path;
  seedFiles(config, project);
  write(join(home, '.agentdeck', 'api-token'), `${STORES.remoteApiToken}\n`);

  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    upstream.push(String(url));
    // Враждебный сервер: отказ с эхом всего, что прислали, — ключ в заголовке
    // вернётся в теле ответа, и действие, отдающее модели тело отказа, его выдаст.
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(JSON.stringify({ error: 'unauthorized', url: String(url), headers }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  });

  // Ни одной записи вне временного каталога: иначе сборка не поднимается вовсе.
  const { detectClaudeLocation } = await import('../../lib/claude-paths.ts');
  const { panelHomeDirPath } = await import('../../lib/brand.mjs');
  const location = detectClaudeLocation().paths;
  for (const dir of [location.root, location.appData, location.mcpConfig, panelHomeDirPath()]) {
    if (!realpathSync(join(dir, '..')).startsWith(home)) {
      throw new Error(`refusing to sweep over ${dir}`);
    }
  }

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

  const group = await seedThroughPanel(human, project);
  seeded = {
    home,
    project,
    group,
    rule: await idOf(human, '/api/rules', 'Sweep rule'),
    hook: await idOf(human, '/api/hooks', 'notify.js'),
    skill: await idOf(human, '/api/skills', 'sweep-skill'),
    script: await idOf(human, '/api/scripts', 'sweep-notify'),
    permission: await idOf(human, '/api/permissions', 'Bash(ls)'),
  };

  for (const action of actions) {
    const row = ROWS[action.name];
    if (!row || 'skip' in row) continue;
    for (const [index, [, input]] of row.entries()) {
      observed.push(
        await sweep(action, index, typeof input === 'function' ? input(seeded) : input),
      );
    }
  }
  for (const url of [
    '/api/agent/journal?limit=10000',
    '/api/agent/pending',
    '/api/agent/actions',
  ]) {
    extraTexts.push({ where: url, text: (await human({ method: 'GET', url })).body });
  }
}, 300_000);

afterAll(async () => {
  shutdown?.();
  await app?.close();
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

const CALL_BUDGET_MS = 20_000;

/**
 * Вызов как у агента: заголовок агента, без Origin. Изменение ждёт карточку,
 * её содержимое снимается, затем человек её отклоняет — исполнения нет.
 */
async function sweep(
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
  let card: PanelPendingAction | undefined;
  const started = Date.now();
  while (!settled && action.risk !== 'read' && Date.now() - started < CALL_BUDGET_MS) {
    const list = (
      await app!.inject({ method: 'GET', url: '/api/agent/pending' })
    ).json() as PanelPendingAction[];
    card = list.find((item) => item.name === action.name);
    if (card) {
      texts.push({ where: 'card', text: JSON.stringify(card) });
      await human({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        payload: { decision: 'reject' },
      });
      break;
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
  const reach: Observed['reach'] = card
    ? result.outcome === 'rejected'
      ? 'card'
      : 'other'
    : result.outcome === 'done' || result.outcome === 'failed'
      ? result.outcome
      : result.outcome === 'invalid' || result.outcome === 'unknown'
        ? result.outcome
        : 'other';
  return {
    action: action.name,
    index,
    reach,
    texts,
    note: `${result.outcome}: ${String(result.message ?? '').slice(0, 160)}`,
  };
}

describe('secret sweep: no stored secret reaches the model through any panel action', () => {
  it('every panel action has a row, and every row is a panel action', () => {
    expect(actions.length).toBeGreaterThan(200);
    const names = new Set(actions.map((action) => action.name));
    expect({
      withoutRow: [...names].filter((name) => !(name in ROWS)),
      stale: Object.keys(ROWS).filter((name) => !names.has(name)),
    }).toEqual({ withoutRow: [], stale: [] });
  });

  it('every call reaches what its row declares (a card, a done read, a failed read)', () => {
    const mismatched = observed
      .filter((item) => {
        const row = ROWS[item.action] as readonly Call[];
        return row[item.index]![0] !== item.reach;
      })
      .map((item) => {
        const row = ROWS[item.action] as readonly Call[];
        return `${item.action}#${item.index}: want ${row[item.index]![0]}, got ${item.reach} (${item.note})`;
      });
    expect(mismatched).toEqual([]);
    const calls = Object.values(ROWS).reduce(
      (sum, row) => sum + ('skip' in row ? 0 : row.length),
      0,
    );
    expect(observed).toHaveLength(calls);
  });

  it('every store is seeded where the panel reads it: the model sees the container', () => {
    const missing = (Object.keys(EXPOSED) as Store[]).filter((store) => {
      const [action, marker] = EXPOSED[store];
      return !observed.some(
        (item) =>
          item.action === action &&
          item.reach === 'done' &&
          item.texts.some(({ text }) => text.includes(marker)),
      );
    });
    expect(missing).toEqual([]);
  });

  it('no canary in any result, failure message, confirmation card, the pending list or the journal', () => {
    const found = [
      ...observed.flatMap((item) =>
        leaks(item.texts).map((leak) => `${item.action}#${item.index}: ${leak}`),
      ),
      ...leaks(extraTexts),
    ];
    expect(found).toEqual([]);
  });

  it('planted: a canary in a result is found, a masked tail is not', () => {
    const value = STORES.settingsEnv;
    const one = { settingsEnv: value };
    expect(leaks([{ where: 'x', text: `{"value":"${value}"}` }], one)).toEqual([
      'settingsEnv (value) → x: …{"value":"',
      'settingsEnv (prefix-12) → x: …{"value":"',
      'settingsEnv (split) → x: …{"value":"',
    ]);
    expect(leaks([{ where: 'x', text: `{"value":"••••••${value.slice(-4)}"}` }], one)).toEqual([]);
  });

  it('planted (review U0, M4): a prefix, a base64 wrap at any alignment and a split are found', () => {
    const value = STORES.settingsEnv;
    const one = { settingsEnv: value };
    const kinds = (text: string) =>
      leaks([{ where: 'x', text }], one).map((leak) => leak.split(' → ')[0]);
    expect(kinds(`cut: ${value.slice(0, 14)}…`)).toEqual(['settingsEnv (prefix-12)']);
    for (const [pad, prefix] of [
      [0, ''],
      [1, 'a'],
      [2, 'ab'],
    ] as const) {
      const wrapped = Buffer.from(`${prefix}${value} tail`).toString('base64');
      expect(kinds(`Basic ${wrapped}`)).toContain(`settingsEnv (base64+${pad})`);
      const url = Buffer.from(`${prefix}${value} tail`).toString('base64url');
      expect(kinds(`token=${url}`)).toContain(`settingsEnv (base64url+${pad})`);
    }
    const half = Math.floor(value.length / 2);
    expect(kinds(`"a":"${value.slice(0, half)}","b":"${value.slice(half)}"`)).toContain(
      'settingsEnv (split)',
    );
    // Одна половина без другой — не утечка: короткий обрезок встречается где угодно.
    expect(kinds(`"a":"${value.slice(half)}"`)).toEqual([]);
  });
});
