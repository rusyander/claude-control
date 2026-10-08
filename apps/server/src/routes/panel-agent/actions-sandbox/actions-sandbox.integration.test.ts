import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PanelActionResult,
  PanelPendingAction,
  PanelActionsList,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { stopSandboxSweeper } from '../../../domains/sandbox/SandboxSweep.ts';
import { registerConfigRoutes } from '../../config-routes/config-routes.ts';
import { registerEntityRoutes } from '../../entity-routes/entity-routes.ts';
import { registerScriptRoutes } from '../../script-routes/script-routes.ts';
import { registerSandboxRoutes } from '../../sandbox-routes/sandbox-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';
import { setSandboxAskBudgetForTests } from './actions-sandbox.ts';

/**
 * Песочница у агента панели (P3): прогон хука на заготовках и вопрос Claude с
 * временной копией выбранного — настоящими маршрутами окна «Песочница».
 *
 * Дом временный (песочницы лежат под `~/.agentdeck/sandboxes`), конфигурация
 * своя, а `claude` — подделка первой в PATH: она пишет, с каким каталогом
 * конфигурации и флагами её запустили и что лежало в CLAUDE.md песочницы, и
 * отвечает потоком stream-json, как настоящий CLI. Хук — настоящий скрипт,
 * настоящий `node`. Доказательство изоляции — диск: после действия ни одной
 * песочницы, и прогон видел только выбранное.
 */
const ORIGIN = 'http://localhost:8888';
const SECRET = `sk-ant-api03-${'Q'.repeat(40)}`;
const isWindows = process.platform === 'win32';

/** Хук-сторож: блокирует `rm -rf` и `git push` (выход 2 с причиной в stderr). */
const GUARD = `let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
const command = JSON.parse(raw || '{}').tool_input?.command ?? '';
if (/rm -rf|git push/.test(command)) {
  process.stderr.write('guard: blocked ' + command);
  process.exit(2);
}
process.exit(0);
`;

/** Подделка CLI: протокол запуска в журнал, ответ потоком stream-json. */
const FAKE_CLAUDE = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
const md = configDir && existsSync(join(configDir, 'CLAUDE.md'))
  ? readFileSync(join(configDir, 'CLAUDE.md'), 'utf8') : '';
appendFileSync(process.env.U5C_FAKE_LOG, JSON.stringify({
  argv: process.argv.slice(2), configDir, cwd: process.cwd(), prompt, md,
  credentials: existsSync(join(configDir, '.credentials.json')),
}) + '\\n');
if (prompt.includes('HANG')) await new Promise(() => setInterval(() => {}, 1000));
writeFileSync(join(process.cwd(), 'answer.txt'), '42');
const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-1', model: 'fake', tools: [] });
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
out(delta('Отвечаю кратко. '));
out(delta('Ключ ${SECRET} не нужен.'));
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: 't1', input: { file_path: 'answer.txt' } }] } });
out({ type: 'result', subtype: 'success', total_cost_usd: 0.0123, duration_ms: 5, session_id: 'fake-1' });
`;

describe('panel-agent actions: sandbox', () => {
  let base: string;
  let home: string;
  let root: string;
  let appData: string;
  let bin: string;
  let log: string;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    U5C_FAKE_LOG: process.env.U5C_FAKE_LOG,
  };

  const sandboxes = () => join(home, '.agentdeck', 'sandboxes');
  const leftovers = () => (existsSync(sandboxes()) ? readdirSync(sandboxes()) : []);
  const launches = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                argv: string[];
                configDir: string;
                cwd: string;
                prompt: string;
                md: string;
                credentials: boolean;
              },
          )
      : [];

  beforeEach(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-agent-u5c-sandbox-')));
    home = join(base, 'home');
    root = join(home, '.claude');
    appData = join(root, 'agentdeck');
    bin = join(base, 'bin');
    log = join(base, 'launches.jsonl');
    for (const dir of [appData, join(root, 'hooks'), bin]) mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.U5C_FAKE_LOG = log;
    delete process.env.ANTHROPIC_API_KEY;

    writeFileSync(join(root, 'hooks', 'guard.mjs'), GUARD);
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: `node "${join(root, 'hooks', 'guard.mjs')}"`,
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# Правила\n\n## ПРАВИЛО: Краткость\n\nОтвечай в две строки.\n\n## ПРАВИЛО: Личное\n\nНИКОГДА-НЕ-В-ПЕСОЧНИЦУ\n',
    );
    writeFileSync(join(root, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake"}}');
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );

    // Подделка `claude` первой в PATH: настоящий CLI этот тест не запускает.
    writeFileSync(join(bin, 'fake-claude.mjs'), FAKE_CLAUDE);
    if (isWindows) {
      writeFileSync(
        join(bin, 'claude.cmd'),
        `@echo off\r\n"${process.execPath}" "${join(bin, 'fake-claude.mjs')}" %*\r\n`,
      );
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-claude.mjs')}" "$@"\n`,
        { mode: 0o755 },
      );
    }
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ''}`;

    const store = new AppStore(appData);
    pending = new PanelPendingActions(10_000);
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
          commands: join(root, 'commands'),
          mcpConfig: join(home, '.claude.json'),
        },
      },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerConfigRoutes(app, ctx);
    registerEntityRoutes(app, ctx);
    registerScriptRoutes(app, ctx);
    registerSandboxRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    stopSandboxSweeper();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = async (name: string, input: unknown): Promise<PanelActionResult> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-u5c-sandbox' },
    });
    expect(res.statusCode).toBe(200);
    return res.json<PanelActionResult>();
  };

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const list = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (list[0]) return list[0];
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject',
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const result = call(name, input);
    const card = await waitPending();
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
    return { card, result: await result };
  };

  const fieldsOf = (card: PanelPendingAction) =>
    Object.fromEntries(card.preview.fields.map((field) => [field.labelCode, field.value]));

  const hookId = async () =>
    (await app.inject({ method: 'GET', url: '/api/hooks' })).json<Array<{ id: string }>>()[0]?.id ??
    '';
  const ruleId = async (title: string) =>
    (await app.inject({ method: 'GET', url: '/api/rules' }))
      .json<Array<{ id: string; title: string }>>()
      .find((rule) => rule.title === title)?.id ?? '';

  it('действия в реестре с заявленным риском', async () => {
    const { actions } = (
      await app.inject({ method: 'GET', url: '/api/agent/actions' })
    ).json<PanelActionsList>();
    const risk = Object.fromEntries(actions.map((action) => [action.name, action.risk]));
    expect(risk).toMatchObject({
      list_sandbox_fixtures: 'read',
      sandbox_probe_hook: 'danger',
      sandbox_ask: 'danger',
    });
    expect(risk).not.toHaveProperty('sandbox_mcp_call');
  });

  it('list_sandbox_fixtures: заготовки маршрута с ожиданием блокировки', async () => {
    const result = await call('list_sandbox_fixtures', {});
    expect(result.outcome).toBe('done');
    const fixtures = (result.result as { fixtures: Array<{ id: string; expectsBlock: boolean }> })
      .fixtures;
    expect(fixtures.find((item) => item.id === 'bash-destructive')?.expectsBlock).toBe(true);
    expect(fixtures.find((item) => item.id === 'bash-safe')?.expectsBlock).toBe(false);
  });

  it('sandbox_probe_hook: решения хука по заготовкам, запускалась копия, песочница стёрта', async () => {
    const hook = await hookId();
    const { card, result } = await decided(
      'sandbox_probe_hook',
      { hook, fixtures: ['bash-safe', 'bash-destructive', 'bash-git-push'] },
      'approve',
    );
    expect(card.risk).toBe('danger');
    expect(fieldsOf(card)['label-command']).toContain('guard.mjs');
    expect(fieldsOf(card)['label-sandbox-events']).toBe(
      'bash-safe, bash-destructive, bash-git-push',
    );

    expect(result.outcome).toBe('done');
    const data = result.result as {
      command: string;
      results: Array<{ fixtureId: string; decision: string; matchesExpectation: boolean }>;
    };
    // Команда прогона — копия внутри песочницы, а не настоящий ~/.claude/hooks.
    // Сравнение по хвосту пути: случайное имя временной папки сетка результата
    // порой принимает за секрет и прячет, а место копии хвост называет и так.
    expect(data.command).toContain(join('.agentdeck', 'sandboxes'));
    expect(data.command).toContain(join('config', 'hooks', 'guard.mjs'));
    expect(data.command).not.toContain(join('.claude', 'hooks'));
    const decisions = Object.fromEntries(data.results.map((row) => [row.fixtureId, row.decision]));
    expect(decisions).toEqual({
      'bash-safe': 'pass',
      'bash-destructive': 'block',
      'bash-git-push': 'block',
    });
    expect(data.results.every((row) => row.matchesExpectation)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('sandbox_probe_hook: своё событие вместо заготовок; неизвестная заготовка — отказ до карточки', async () => {
    const hook = await hookId();
    const own = await decided(
      'sandbox_probe_hook',
      {
        hook,
        event: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /tmp/x' },
        }),
      },
      'approve',
    );
    expect(own.result.outcome).toBe('done');
    const rows = (own.result.result as { results: Array<{ decision: string; stderr?: string }> })
      .results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('block');
    expect(leftovers()).toEqual([]);

    const unknown = await call('sandbox_probe_hook', { hook, fixtures: ['no-such-fixture'] });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('no-such-fixture');
    expect((await app.inject({ method: 'GET', url: '/api/agent/pending' })).json()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('sandbox_ask: ответ, инструменты, файлы; прогон видел только выбранное правило; копия стёрта', async () => {
    const rule = await ruleId('Краткость');
    expect(rule).not.toBe('');
    const { card, result } = await decided(
      'sandbox_ask',
      { question: 'Сколько будет 6×7?', rules: [rule] },
      'approve',
    );
    expect(card.risk).toBe('danger');
    expect(fieldsOf(card)['label-sandbox-question']).toBe('Сколько будет 6×7?');
    expect(fieldsOf(card)['label-sandbox-rules']).toBe('Краткость');

    expect(result.outcome).toBe('done');
    const data = result.result as {
      answer: string;
      tools: string[];
      files: string[];
      costUsd?: number;
      error?: string;
    };
    expect(data.error).toBeUndefined();
    expect(data.answer).toContain('Отвечаю кратко.');
    // Секрет в ответе модели агенту не уходит.
    expect(data.answer).not.toContain(SECRET);
    expect(data.tools).toEqual(['Write']);
    expect(data.files).toContain('answer.txt');
    expect(data.costUsd).toBe(0.0123);

    const [launch] = launches();
    expect(launch?.prompt).toBe('Сколько будет 6×7?');
    // Каталог конфигурации — песочница, не настоящий ~/.claude; слои — только `user`.
    expect(launch?.configDir.startsWith(sandboxes())).toBe(true);
    expect(launch?.cwd.startsWith(sandboxes())).toBe(true);
    const flag = launch?.argv.indexOf('--setting-sources') ?? -1;
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(launch?.argv[flag + 1]).toBe('user');
    expect(launch?.credentials).toBe(true);
    expect(launch?.md).toContain('Отвечай в две строки.');
    expect(launch?.md).not.toContain('НИКОГДА-НЕ-В-ПЕСОЧНИЦУ');
    // Копия доступа не пережила действие.
    expect(leftovers()).toEqual([]);
  });

  it('sandbox_ask: без доступа к аккаунту — отказ с причиной, CLI не запускался, копия стёрта', async () => {
    rmSync(join(root, '.credentials.json'));
    const { result } = await decided('sandbox_ask', { question: 'Привет' }, 'approve');
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('no access to the account');
    expect(result.message).toContain('The temporary sandbox was removed.');
    expect(launches()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('sandbox_ask: потолок времени останавливает прогон маршрутом «Стоп»', async () => {
    const restore = setSandboxAskBudgetForTests(1_500);
    try {
      const { result } = await decided('sandbox_ask', { question: 'HANG please' }, 'approve');
      expect(result.outcome).toBe('done');
      const data = result.result as { note?: string; answer: string };
      expect(data.note).toContain('Stopped after');
      expect(data.answer).toBe('');
      expect(launches()).toHaveLength(1);
      expect(leftovers()).toEqual([]);
    } finally {
      restore();
    }
  }, 30_000);

  it('отклонено человеком — песочница не собирается, CLI не запускается', async () => {
    const { result } = await decided('sandbox_ask', { question: 'Нет' }, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(launches()).toEqual([]);
    expect(leftovers()).toEqual([]);

    const probe = await decided('sandbox_probe_hook', { hook: await hookId() }, 'reject');
    expect(probe.result.outcome).toBe('rejected');
    expect(leftovers()).toEqual([]);
  });
});
