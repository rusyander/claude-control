import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  LOCAL_LEAN_BASE_TOKENS,
  LOCAL_MCP_MIN_HEADROOM_TOKENS,
  localMcpFits,
  localMcpHeadroom,
} from '@agentdeck/contracts/local-models';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, defaultState, readState, writeState } from './paths.ts';
import { createLocalMcp } from './mcp-service.ts';
import {
  ERROR_RETRY_MS,
  ESTIMATE_CHARS_PER_TOKEN,
  costKeyOf,
  estimateTokens,
  fingerprintOf,
  measureEntry,
  needsMeasure,
  projectKeyOf,
  toolsPayload,
  type LocalMcpSource,
  type McpSourceEntry,
  type McpToolDef,
} from './local-mcp.ts';
import { localCompactAt } from './run-env.ts';
import { modelFilePath } from './hf.ts';

/**
 * MCP-серверы локального прогона (L4, 14.10): чистая арифметика цены и запаса,
 * замер (счётом настоящего сервера моделей и прикидкой), выбор по проекту, что идёт
 * прогону. Источник серверов — подставной (файлы настроек и сеть MCP — внешняя
 * граница); сервис и llama-server заглушка — настоящие.
 */

const entry = (id: string, config: Record<string, unknown> = { command: id }): McpSourceEntry => ({
  id,
  scope: 'user',
  transport: 'stdio',
  config,
  server: {
    id,
    name: id,
    transport: 'stdio',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
  },
});

const TOOLS: McpToolDef[] = [
  { name: 'list_mrs', description: 'List merge requests', inputSchema: { type: 'object' } },
  { name: 'get_mr', description: 'One merge request' },
];

function fakeSource(
  entries: McpSourceEntry[],
  tools: Record<string, McpToolDef[] | Error> = {},
): LocalMcpSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    list: () => entries,
    tools: async (item) => {
      asked.push(item.id);
      const found = tools[item.id] ?? TOOLS;
      if (found instanceof Error) throw found;
      return found;
    },
  };
}

describe('запас окна: арифметика', () => {
  const base = {
    compactAt: 44_344,
    baseTokens: LOCAL_LEAN_BASE_TOKENS,
    servers: [
      {
        id: 'gitlab',
        scope: 'user' as const,
        transport: 'http' as const,
        tokens: 15_040,
        tools: 39,
        picked: false,
      },
      {
        id: 'figma',
        scope: 'user' as const,
        transport: 'http' as const,
        tokens: 3_140,
        tools: 8,
        picked: false,
      },
      {
        id: 'raw',
        scope: 'user' as const,
        transport: 'stdio' as const,
        tokens: null,
        tools: null,
        picked: false,
      },
    ],
  };

  it('запас = порог сжатия − основа − выбранное; без выбора — порог минус основа', () => {
    expect(localMcpHeadroom(base, [])).toBe(44_344 - LOCAL_LEAN_BASE_TOKENS);
    expect(localMcpHeadroom(base, ['gitlab'])).toBe(44_344 - LOCAL_LEAN_BASE_TOKENS - 15_040);
    expect(localMcpHeadroom(base, ['gitlab', 'figma'])).toBe(
      44_344 - LOCAL_LEAN_BASE_TOKENS - 15_040 - 3_140,
    );
  });

  it('несозданный замер считается нулём, чужой id — ничем', () => {
    expect(localMcpHeadroom(base, ['raw', 'nope'])).toBe(44_344 - LOCAL_LEAN_BASE_TOKENS);
  });

  it('сервер влезает, пока после него остаётся не меньше минимума; уже выбранный влезает всегда', () => {
    expect(localMcpFits(base, [], 'gitlab')).toBe(true);
    // 31 744 − 15 040 = 16 704 → ещё figma: 13 564 ≥ 4000.
    expect(localMcpFits(base, ['gitlab'], 'figma')).toBe(true);
    const tight = {
      ...base,
      compactAt: LOCAL_LEAN_BASE_TOKENS + 15_040 + LOCAL_MCP_MIN_HEADROOM_TOKENS - 1,
    };
    expect(localMcpFits(tight, [], 'gitlab')).toBe(false);
    expect(localMcpFits({ ...tight, compactAt: tight.compactAt + 1 }, [], 'gitlab')).toBe(true);
    expect(localMcpFits(tight, ['gitlab'], 'gitlab')).toBe(true);
  });

  it('сервер без цены не берётся, пока его не замерят; уже взятый снимается всегда', () => {
    expect(localMcpFits(base, [], 'raw')).toBe(false);
    expect(localMcpFits(base, ['raw'], 'raw')).toBe(true);
  });

  it('порог сжатия: окно − 8192 − 13000, не ниже нуля', () => {
    expect(localCompactAt(65_536)).toBe(44_344);
    expect(localCompactAt(131_072)).toBe(109_880);
    expect(localCompactAt(10_000)).toBe(0);
  });
});

describe('ключи, отпечаток и нужен ли замер', () => {
  it('ключ проекта не различает хвостовой разделитель; на Windows — и регистр', () => {
    expect(projectKeyOf('/work/app/', 'linux')).toBe(projectKeyOf('/work/app', 'linux'));
    expect(projectKeyOf('C:\\Work\\App\\', 'win32')).toBe(projectKeyOf('c:\\work\\app', 'win32'));
    expect(projectKeyOf('/work/App', 'linux')).not.toBe(projectKeyOf('/work/app', 'linux'));
  });

  it('отпечаток меняется вместе с записью сервера', () => {
    expect(fingerprintOf(entry('a'))).toBe(fingerprintOf(entry('a')));
    expect(fingerprintOf(entry('a', { command: 'x' }))).not.toBe(
      fingerprintOf(entry('a', { command: 'y' })),
    );
    expect(costKeyOf(entry('gitlab'))).toBe('user:gitlab');
  });

  const now = Date.parse('2026-10-14T12:00:00Z');
  const record = (over: Record<string, unknown> = {}) => ({
    fingerprint: fingerprintOf(entry('a')),
    tokens: 100,
    tools: 2,
    source: 'server' as const,
    measuredAt: new Date(now - 1000).toISOString(),
    ...over,
  });

  it('замер нужен: записи нет, сервер изменился, прикидка при живом счёте, давняя неудача', () => {
    const e = entry('a');
    expect(needsMeasure(undefined, e, { serverCounts: true, now })).toBe(true);
    expect(needsMeasure(record({ fingerprint: 'other' }), e, { serverCounts: true, now })).toBe(
      true,
    );
    expect(needsMeasure(record({ source: 'estimate' }), e, { serverCounts: true, now })).toBe(true);
    expect(
      needsMeasure(
        record({
          tokens: null,
          error: 'down',
          measuredAt: new Date(now - ERROR_RETRY_MS).toISOString(),
        }),
        e,
        { serverCounts: false, now },
      ),
    ).toBe(true);
  });

  it('замер не нужен: свежий счёт сервера, прикидка без счёта, недавняя неудача', () => {
    const e = entry('a');
    expect(needsMeasure(record(), e, { serverCounts: true, now })).toBe(false);
    expect(needsMeasure(record({ source: 'estimate' }), e, { serverCounts: false, now })).toBe(
      false,
    );
    expect(
      needsMeasure(record({ tokens: null, error: 'down' }), e, { serverCounts: false, now }),
    ).toBe(false);
  });
});

describe('замер одного сервера', () => {
  const fixed = () => new Date('2026-10-14T12:00:00Z');

  it('инструменты считаются в виде, в каком их шлёт Claude Code: mcp__<сервер>__<имя>', () => {
    const payload = toolsPayload({ id: 'gitlab' }, TOOLS) as {
      name: string;
      input_schema: unknown;
    }[];
    expect(payload.map((tool) => tool.name)).toEqual([
      'mcp__gitlab__list_mrs',
      'mcp__gitlab__get_mr',
    ]);
    // Нет схемы у сервера — пустая схема объекта, а не отсутствие поля.
    expect(payload[1]?.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('счёт сервера моделей — «server», а прикидка по символам — «estimate»', async () => {
    const source = fakeSource([entry('a')]);
    const got = await measureEntry({
      entry: entry('a'),
      source,
      count: async (tools) => {
        expect(tools).toHaveLength(2);
        return 321;
      },
      now: fixed,
    });
    expect(got).toMatchObject({ tokens: 321, tools: 2, source: 'server' });
    const estimated = await measureEntry({ entry: entry('a'), source, now: fixed });
    expect(estimated.source).toBe('estimate');
    expect(estimated.tokens).toBe(estimateTokens(toolsPayload({ id: 'a' }, TOOLS)));
    expect(estimated.tokens).toBe(
      Math.ceil(JSON.stringify(toolsPayload({ id: 'a' }, TOOLS)).length / ESTIMATE_CHARS_PER_TOKEN),
    );
  });

  it('сервер моделей не ответил на счёт — прикидка, а не провал замера', async () => {
    const got = await measureEntry({
      entry: entry('a'),
      source: fakeSource([entry('a')]),
      count: () => Promise.reject(new Error('busy')),
      now: fixed,
    });
    expect(got.source).toBe('estimate');
    expect(got.error).toBeUndefined();
  });

  it('MCP-сервер не ответил: запись с причиной и без цифр', async () => {
    const got = await measureEntry({
      entry: entry('a'),
      source: fakeSource([entry('a')], { a: new Error('connect ECONNREFUSED') }),
      count: async () => 1,
      now: fixed,
    });
    expect(got).toMatchObject({ tokens: null, tools: null, error: 'connect ECONNREFUSED' });
  });
});

describe('служба MCP локального прогона', () => {
  let state = defaultState();
  const memory = (
    entries: McpSourceEntry[],
    tools = {},
    count?: () => Promise<((t: unknown[]) => Promise<number>) | undefined>,
    context = 65_536,
  ) => {
    const source = fakeSource(entries, tools);
    return {
      source,
      mcp: createLocalMcp({
        source,
        read: () => state,
        update: (change) => change(state),
        context: () => context,
        ...(count ? { count } : {}),
        now: () => new Date('2026-10-14T12:00:00Z'),
      }),
    };
  };
  beforeEach(() => {
    state = defaultState();
  });

  it('по умолчанию ни один сервер не выбран и прогону ничего не едет', () => {
    const { mcp } = memory([entry('gitlab'), entry('figma')]);
    const info = mcp.describe('/work/app');
    expect(info.picked).toEqual([]);
    expect(info.servers.map((server) => server.picked)).toEqual([false, false]);
    expect(info.headroom).toBe(localCompactAt(65_536) - LOCAL_LEAN_BASE_TOKENS);
    expect(mcp.run('/work/app')).toBeUndefined();
  });

  it('замер кладёт цену, запас уменьшается на выбранное', async () => {
    const { mcp } = memory([entry('gitlab'), entry('figma')], {}, async () => async () => 5_000);
    const measured = await mcp.measure('/work/app');
    expect(measured.servers.map((server) => [server.id, server.tokens, server.source])).toEqual([
      ['gitlab', 5_000, 'server'],
      ['figma', 5_000, 'server'],
    ]);
    const picked = mcp.pick('/work/app', ['gitlab']);
    expect(picked.headroom).toBe(localCompactAt(65_536) - LOCAL_LEAN_BASE_TOKENS - 5_000);
  });

  it('замер без названных серверов трогает только те, у кого цены нет; названные — всегда', async () => {
    const { mcp, source } = memory([entry('a'), entry('b')], {}, async () => async () => 100);
    await mcp.measure('/p');
    expect(source.asked.sort()).toEqual(['a', 'b']);
    source.asked.length = 0;
    await mcp.measure('/p');
    expect(source.asked).toEqual([]);
    await mcp.measure('/p', ['b']);
    expect(source.asked).toEqual(['b']);
  });

  it('проектный сервер из .mcp.json сам не запускается: только по явной просьбе', async () => {
    const own = { ...entry('repo-tool'), scope: 'project' as const };
    const { mcp, source } = memory([entry('a'), own], {}, async () => async () => 100);
    await mcp.measure('/p');
    expect(source.asked).toEqual(['a']);
    await mcp.measure('/p', ['repo-tool']);
    expect(source.asked).toEqual(['a', 'repo-tool']);
  });

  it('сервер упал при замере: цены нет, причина названа, остальные замерены', async () => {
    const { mcp } = memory(
      [entry('a'), entry('b')],
      { a: new Error('нет связи') },
      async () => async () => 100,
    );
    const info = await mcp.measure('/p');
    const byId = Object.fromEntries(info.servers.map((server) => [server.id, server]));
    expect(byId.a).toMatchObject({ tokens: null, error: 'нет связи' });
    expect(byId.b).toMatchObject({ tokens: 100 });
  });

  it('запись о другом сервере (команду поменяли) цены не даёт', async () => {
    const first = memory([entry('a', { command: 'x' })], {}, async () => async () => 100);
    await first.mcp.measure('/p');
    const changed = memory([entry('a', { command: 'y' })]);
    expect(changed.mcp.describe('/p').servers[0]?.tokens).toBeNull();
  });

  it('выбор помнится по проекту, а не вообще; пустой выбор стирает запись', () => {
    const { mcp } = memory([entry('a'), entry('b')]);
    mcp.pick('/work/one', ['a']);
    expect(mcp.describe('/work/one').picked).toEqual(['a']);
    expect(mcp.describe('/work/two').picked).toEqual([]);
    mcp.pick('/work/one', []);
    expect(Object.keys(state.mcpPicks)).toEqual([]);
  });

  it('выбор очищается от неизвестных серверов и повторов, исчезнувший из файла не едет', () => {
    const entries = [entry('a'), entry('b')];
    const { mcp } = memory(entries);
    expect(mcp.pick('/p', ['b', 'ghost', 'b']).picked).toEqual(['b']);
    // Сервер «b» убрали из файла настроек: выбор остаётся в состоянии, но прогону не едет.
    entries.pop();
    expect(mcp.describe('/p').picked).toEqual([]);
    expect(mcp.run('/p')).toBeUndefined();
  });

  it('прогону едут ровно выбранные записи — как они лежат в файле настроек', () => {
    const { mcp } = memory([
      entry('gitlab', {
        type: 'http',
        url: 'https://gitlab.example/mcp',
        headers: { Authorization: 'Bearer ${GL}' },
      }),
      entry('figma'),
    ]);
    mcp.pick('/p', ['gitlab']);
    expect(mcp.run('/p')).toEqual({
      ids: ['gitlab'],
      config: {
        mcpServers: {
          gitlab: {
            type: 'http',
            url: 'https://gitlab.example/mcp',
            headers: { Authorization: 'Bearer ${GL}' },
          },
        },
      },
    });
  });
});

// ── Сервис целиком: счёт настоящей заглушки llama-server ────────────────────

interface StubServer {
  port: number;
  calls: { method: string; path: string }[];
  close: () => Promise<void>;
}
interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
  startStubLlama: (options?: Record<string, unknown>) => Promise<StubServer>;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_497;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let stub: StubServer | undefined;
let starting: Promise<void>[];

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});

function service(source: LocalMcpSource) {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    freeBytes: () => 40 * 1024 ** 3,
    mcp: source,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: (() => {
      starting.push(
        stubs.startStubLlama({ port: PORT, countTools: true }).then((started) => {
          stub = started;
        }),
      );
      return { pid: 4343, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: () => {
      const old = stub;
      stub = undefined;
      starting.push(old ? old.close() : Promise.resolve());
    },
  });
}

describe('сервис: цена с настоящего сервера моделей и выбор поверх состояния', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-local-mcp-'));
    starting = [];
    stub = undefined;
    const paths = localPaths(root, ENV());
    const runtimeDir = join(paths.runtime, 'llama-b11583');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, BINARY), '');
    const model = loadCatalog().models.find((item) => item.tag === TAG);
    const quant = model?.quants.find((item) => item.id === model.defaultQuant);
    if (!model || !quant) throw new Error('27B not in catalog');
    stubs.writeGguf(modelFilePath(paths, model.repo, quant.file), { nextn: 1 });
  });
  afterEach(async () => {
    await Promise.all(starting);
    await stub?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('сервер не запущен: цена — прикидка, окно — наименьшее окно агента', async () => {
    const local = service(fakeSource([entry('gitlab')]));
    const info = await local.mcpMeasure('/work/app');
    expect(info.servers[0]).toMatchObject({ id: 'gitlab', source: 'estimate' });
    expect(info.context).toBe(info.compactAt + 8_192 + 13_000);
  });

  it('сервер запущен: цена — разность счёта с инструментами и без, источник «server»', async () => {
    const local = service(fakeSource([entry('gitlab')]));
    await local.startServer({ tag: TAG });
    const info = await local.mcpMeasure('/work/app');
    const server = info.servers[0];
    expect(server?.source).toBe('server');
    // Заглушка прибавляет четверть длины JSON инструментов; пустой запрос несёт «[]» → +1.
    const payload = toolsPayload({ id: 'gitlab' }, TOOLS);
    expect(server?.tokens).toBe(Math.ceil(JSON.stringify(payload).length / 4) - 1);
    // Спросили именно счёт: без него запрос к заглушке не доходит.
    expect(stub?.calls.filter((call) => call.path === '/v1/messages/count_tokens')).toHaveLength(2);
    // Окно — настоящее окно запущенного сервера.
    expect(info.context).toBe(
      readState(localPaths(root, ENV())).choices[TAG]?.context ?? info.context,
    );
  });

  it('выбор переживает перезапуск панели (лежит в state.json) и отдаётся прогону', async () => {
    const source = fakeSource([entry('gitlab'), entry('figma')]);
    service(source).mcpPick('/work/app', ['figma']);
    const again = service(source);
    expect(again.mcpInfo('/work/app').picked).toEqual(['figma']);
    expect(again.mcpRun('/work/app')?.ids).toEqual(['figma']);
    expect(again.mcpRun('/work/other')).toBeUndefined();
  });

  it('состояние без полей MCP (написано прежней панелью) читается с пустым выбором', () => {
    const paths = localPaths(root, ENV());
    const old = { ...defaultState() } as Record<string, unknown>;
    delete old.mcpPicks;
    delete old.mcpCosts;
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.state, JSON.stringify(old));
    const state = readState(paths);
    expect(state.mcpPicks).toEqual({});
    expect(state.mcpCosts).toEqual({});
    writeState(paths, state);
  });

  it('выбор не той формы в state.json не роняет прогон: берутся только списки строк', () => {
    const paths = localPaths(root, ENV());
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({
        ...defaultState(),
        mcpPicks: { '/work/app': 'gitlab', '/work/two': ['figma', 7] },
        mcpCosts: [],
      }),
    );
    const state = readState(paths);
    expect(state.mcpPicks).toEqual({ '/work/two': ['figma'] });
    expect(state.mcpCosts).toEqual({});
    const source = fakeSource([entry('gitlab'), entry('figma')]);
    expect(() => service(source).mcpRun('/work/app')).not.toThrow();
  });
});
