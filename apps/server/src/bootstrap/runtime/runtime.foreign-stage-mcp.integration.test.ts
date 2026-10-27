import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ProviderChatRun } from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import type { OpencodeServe } from '../../domains/opencode-serve/opencode-serve.ts';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import { TESTS_CLI_ENV } from '@agentdeck/contracts/chat-group-settings';
import {
  GROUP_DELIVER_AHEAD_ENV,
  GROUP_STAGE_ENV,
} from '../../domains/chat/group-profile/group-profile.ts';
import type {
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { createChat } from '../../domains/provider-chat/store/store.ts';
import { CODEX_MCP_OFF_ENV, withCodexKit } from '../../domains/kit/codex.ts';
import { OPENCODE_TOOL_DENY_ENV } from '../../domains/opencode-serve/tool-deny.ts';
import { getProvider } from '../../providers/registry.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * P-25 (паритет N8, gor-1063 #68): звено группы чужого CLI идёт с тем набором MCP,
 * что и звено Claude (`STAGE_MCP_ROLES`): правки и проверка правок — без серверов,
 * доставка — трекер и хранилище кода, работа и ревью — прежний лёгкий набор. Сервер,
 * который группа попросила (`mcpExtra`), едет в любом звене. Сборка настоящая
 * (`createRuntime`: резолвер ребёнка `setChildRun`, выключатель `setMcpOff`, серверы
 * из конфига самого CLI), `ProviderChatService` настоящий; подменён только прогон —
 * он записывает окружение, с которым CLI был бы запущен. Что CLI делает с этим
 * окружением, доказывают живые `check-foreign-child-env.mjs` (Codex, Qwen) и
 * `check-opencode-mcp-off.mjs` (OpenCode); здесь — какое звено какой набор получает.
 */

const PARENT = 'родитель-p25';

/** Конфиг каждого CLI: трекер, хранилище кода, мессенджер и неизвестный сервер. */
const SERVERS = {
  jira: ['jira-mcp.mjs', 'mcp-atlassian'],
  'gitlab-work': ['gitlab.mjs'],
  'telegram-inbox': ['telegram.mjs'],
  'platform-local': ['platform.mjs'],
} as const;

function seedConfigs(root: string): void {
  const codex = join(root, 'codex-home');
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(codex, 'config.toml'),
    Object.entries(SERVERS)
      .map(
        ([id, args]) =>
          `[mcp_servers.${id}]\ncommand = "node"\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`,
      )
      .join('\n'),
    'utf8',
  );
  const qwen = join(root, 'qwen-home');
  mkdirSync(qwen, { recursive: true });
  writeFileSync(
    join(qwen, 'settings.json'),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        Object.entries(SERVERS).map(([id, args]) => [id, { command: 'node', args }]),
      ),
    }),
    'utf8',
  );
  writeFileSync(
    join(root, 'opencode.json'),
    JSON.stringify({
      mcp: Object.fromEntries(
        Object.entries(SERVERS).map(([id, args]) => [
          id,
          { type: 'local', command: ['node', ...args] },
        ]),
      ),
    }),
    'utf8',
  );
}

const ENV_KEYS = ['CODEX_HOME', 'QWEN_HOME', 'OPENCODE_CONFIG'] as const;

describe('звено группы чужого CLI — набор MCP по виду звена (P-25)', () => {
  let root: string;
  let appData: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let runs: ProviderChatRunOptions[];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-p25-')));
    appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    seedConfigs(root);
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.CODEX_HOME = join(root, 'codex-home');
    process.env.QWEN_HOME = join(root, 'qwen-home');
    process.env.OPENCODE_CONFIG = join(root, 'opencode.json');
    store = new AppStore(appData);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    runs = [];
    // Прогон CLI — внешняя граница: окружение записано, ответ «Готово.».
    (runtime.providerChats as unknown as { createRun: () => ProviderChatRunLike }).createRun =
      () => ({
        start: (options, onEvent) => {
          runs.push(options);
          onEvent({ type: 'done', reply: 'Готово.', transport: 'stream' });
          return Promise.resolve();
        },
        stop: () => undefined,
      });
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  const settle = () => new Promise((done) => setTimeout(done, 100));

  /** Ход звена `patch` в CLI `providerId` — окружение, с которым он запущен. */
  async function envOf(
    providerId: string,
    patch: Partial<ChatLink>,
    extra: string[] = [],
    group: Partial<SplitPlanGroupRecord> = {},
  ): Promise<Record<string, string>> {
    const chat = createChat(appData, providerId, { title: 'G', workdir: project });
    const key = foreignChatKey(providerId, chat!.id);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: project,
      createdAt: '2026-10-26T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'G', tasks: ['PROJ-1 поправить подпись'] }] },
      groups: [
        {
          index: 0,
          title: 'G',
          branch: 'feature/g1',
          after: [],
          status: 'started',
          chatId: key,
          path: project,
          ...(extra.length > 0 ? { mcpExtra: extra } : {}),
          ...group,
        },
      ],
    } as unknown as SplitPlanRecord);
    store.setChatLink(key, {
      parentChatId: PARENT,
      groupIndex: 0,
      branch: 'feature/g1',
      createdAt: '2026-10-26T01:00:00.000Z',
      ...patch,
    });
    const before = runs.length;
    const sent = runtime.providerChats.send(
      appData,
      providerId,
      chat!.id,
      { text: 'Продолжай' },
      { provider: getProvider(providerId), models: [] },
    );
    expect(sent.ok).toBe(true);
    await settle();
    const run = runs[before];
    expect(run).toBeDefined();
    return (run?.platformEnv ?? {}) as Record<string, string>;
  }

  /** Снятые серверы — в словах каждого CLI, именами серверов, по алфавиту. */
  const OFF: Record<string, (env: Record<string, string>) => string[]> = {
    // Codex: ровно то, что уйдёт в argv (`-c mcp_servers.<имя>.enabled=false`).
    codex: (env) =>
      withCodexKit(['exec'], env, 'exec')
        .args.filter((arg) => /^mcp_servers\..*\.enabled=false$/.test(arg))
        .map((arg) => arg.slice('mcp_servers.'.length, -'.enabled=false'.length))
        .sort(),
    // Qwen Code: `mcp.excluded` итогового слоя системных настроек прогона.
    qwen: (env) => {
      const file = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
      if (!file) return [];
      const settings = JSON.parse(readFileSync(file, 'utf8')) as {
        mcp?: { excluded?: string[] };
      };
      return [...(settings.mcp?.excluded ?? [])].sort();
    },
    // OpenCode: правила `deny` вида `<сервер>_*`.
    opencode: (env) =>
      (JSON.parse(env[OPENCODE_TOOL_DENY_ENV] ?? '[]') as string[])
        .filter((rule) => rule.endsWith('_*'))
        .map((rule) => rule.slice(0, -2))
        .sort(),
  };

  const ALL = ['gitlab-work', 'jira', 'platform-local', 'telegram-inbox'];

  for (const providerId of ['codex', 'qwen', 'opencode'] as const) {
    it(`${providerId}: правки и проверка правок — без серверов, доставка — трекер и хранилище кода`, async () => {
      const off = OFF[providerId]!;
      // Работа (связь без звена) и ревью — прежний лёгкий набор: снят только мессенджер.
      expect(off(await envOf(providerId, {}))).toEqual(['telegram-inbox']);
      expect(off(await envOf(providerId, { stage: 'review' }))).toEqual(['telegram-inbox']);
      // Правки и проход проверки правок (ревью со списком правок) — ни одного сервера.
      expect(off(await envOf(providerId, { stage: 'fix', fixFindings: ['🟡 F-1'] }))).toEqual(ALL);
      expect(off(await envOf(providerId, { stage: 'review', fixFindings: ['🟡 F-1'] }))).toEqual(
        ALL,
      );
      // Доставка — трекер и хранилище кода; неизвестный сервер и мессенджер сняты.
      expect(off(await envOf(providerId, { stage: 'deliver' }))).toEqual([
        'platform-local',
        'telegram-inbox',
      ]);
      // Попрошенный группой сервер едет и в звене правок.
      expect(
        off(await envOf(providerId, { stage: 'fix', fixFindings: ['🟡 F-1'] }, ['gitlab-work'])),
      ).toEqual(['jira', 'platform-local', 'telegram-inbox']);
    });
  }

  it('codex: строка о снятых в звене правок называет пустой набор', async () => {
    const env = await envOf('codex', { stage: 'fix', fixFindings: ['🟡 F-1'] });
    expect(JSON.parse(env[CODEX_MCP_OFF_ENV] ?? '{}').off).toHaveLength(4);
    const run = runs.at(-1);
    const text = JSON.stringify(run);
    expect(text).toContain('MCP servers in this run: none.');
  });

  /**
   * P-30 (g8 F4): `tests-cli delivery` берёт трекер у панели — адрес `AGENTDECK_URL` (по умолчанию
   * 127.0.0.1:5178), токен из `~/.agentdeck/api-token`, состояние из `CLAUDE_CONFIG_DIR` или `~/.claude`.
   * Группа чужого CLI зовёт тот же tests-cli (`AGENTDECK_TESTS_CLI`), а прогон CLI идёт с окружением
   * панели плюс окружение звена (`cli-spawn`: `{ ...process.env, ...extra }`). Паритет держится, пока
   * звено ничего из этого не переопределяет и путь к tests-cli доходит, — это и проверено здесь.
   */
  const PANEL_REACH = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'AGENTDECK_URL'];
  for (const providerId of ['codex', 'qwen', 'opencode'] as const) {
    it(`${providerId}: звено доставки и ревью доходят до трекера панели тем же tests-cli (P-30)`, async () => {
      const saved = process.env[TESTS_CLI_ENV];
      delete process.env[TESTS_CLI_ENV];
      try {
        const review = await envOf(providerId, { stage: 'review' }, [], { deliver: true });
        const deliver = await envOf(providerId, { stage: 'deliver' }, [], { deliver: true });
        for (const env of [review, deliver]) {
          expect(env[TESTS_CLI_ENV]).toMatch(/[\\/]tools[\\/]tests-cli\.mjs$/);
          expect(PANEL_REACH.filter((key) => key in env)).toEqual([]);
        }
        expect(review[GROUP_STAGE_ENV]).toBe('review');
        // Доставка впереди — ревью не гоняет полный гейт; в самой доставке метки нет.
        expect(review[GROUP_DELIVER_AHEAD_ENV]).toBe('1');
        expect(deliver[GROUP_STAGE_ENV]).toBe('deliver');
        expect(deliver[GROUP_DELIVER_AHEAD_ENV]).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env[TESTS_CLI_ENV];
        else process.env[TESTS_CLI_ENV] = saved;
      }
    });
  }

  /**
   * P-30, общий сервер: ключи звена (стадия, доставка впереди, tests-cli панели) обязательны —
   * ход группы OpenCode, Kimi и Goose уходит с общего/живого сервера (тот поднят с окружением
   * панели и их не несёт) в свой запуск, и они доходят до процесса CLI. Прочее окружение ребёнка
   * остаётся необязательным (B2-F16). Окружение и `optionalEnvKeys` — из настоящей сборки
   * (createRuntime → ProviderChatService), решение о пути — настоящий ProviderChatRun; подменены
   * только сервер сессий, живой ход и процесс CLI.
   */
  const recordingSpawn = (seen: { env?: NodeJS.ProcessEnv }[]) =>
    ((_command: string, _args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ env: spawnOptions?.env });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => {},
        on: () => {},
        end: () =>
          setTimeout(() => {
            (child.stdout as EventEmitter).emit('data', Buffer.from('ок'));
            child.emit('close', 0);
          }, 0),
      };
      child.kill = () => child.emit('close', null);
      return child;
    }) as unknown as NonNullable<ProviderChatRunOptions['spawnImpl']>;

  for (const providerId of ['opencode', 'kimi', 'goose'] as const) {
    it(`${providerId}: ход звена группы идёт своим запуском и несёт ключи звена (P-30)`, async () => {
      const saved = process.env[TESTS_CLI_ENV];
      delete process.env[TESTS_CLI_ENV];
      try {
        await envOf(providerId, { stage: 'review' }, [], { deliver: true });
        const recorded = runs.at(-1)!;
        // Прочее окружение ребёнка — по-прежнему необязательное; ключи звена — нет.
        expect(recorded.optionalEnvKeys ?? []).toContain('AGENTDECK_BRIEF_OUTPUT');
        for (const key of [GROUP_STAGE_ENV, GROUP_DELIVER_AHEAD_ENV, TESTS_CLI_ENV])
          expect(recorded.optionalEnvKeys ?? []).not.toContain(key);
        const ask = vi.fn(async () => ({ reply: 'общим сервером', sessionId: 's' }));
        const liveTurn = vi.fn(() => undefined);
        const seen: { env?: NodeJS.ProcessEnv }[] = [];
        await new ProviderChatRun().start(
          {
            provider: getProvider(providerId),
            history: [
              { id: 'm1', role: 'user', content: 'Продолжай', at: '2026-10-26T00:00:00.000Z' },
            ],
            chatId: 'chat',
            appDataDir: appData,
            detect: () => true,
            sessionServe: { ask, steer: async () => false } as unknown as OpencodeServe,
            liveTurn,
            spawnImpl: recordingSpawn(seen),
            timeoutMs: 5_000,
            ...(recorded.platformEnv ? { platformEnv: recorded.platformEnv } : {}),
            ...(recorded.optionalEnvKeys ? { optionalEnvKeys: recorded.optionalEnvKeys } : {}),
          },
          () => {},
        );
        expect(ask).not.toHaveBeenCalled();
        expect(liveTurn).not.toHaveBeenCalled();
        const env = seen[0]?.env ?? {};
        expect(env[GROUP_STAGE_ENV]).toBe('review');
        expect(env[GROUP_DELIVER_AHEAD_ENV]).toBe('1');
        expect(env[TESTS_CLI_ENV]).toMatch(/[\\/]tools[\\/]tests-cli\.mjs$/);
      } finally {
        if (saved === undefined) delete process.env[TESTS_CLI_ENV];
        else process.env[TESTS_CLI_ENV] = saved;
      }
    });
  }
});
