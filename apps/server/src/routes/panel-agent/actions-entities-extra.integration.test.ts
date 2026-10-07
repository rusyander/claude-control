import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Hook } from '@agentdeck/contracts';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerEntityRoutes } from '../entity-routes.ts';
import { registerResourceRoutes } from '../resource-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/** Маршрут окна для проверок, которым он не важен: контура нет, шлюз не поднят. */
const NO_ROUTE = { runRoute: () => ({ env: {} }), gatewayPort: () => 0 };

/**
 * Действия строк сущностей (имя скилла, порядок хуков, файл переменной и
 * права, правка права, MCP, файлы структуры скилла) на настоящих маршрутах окна
 * и ВРЕМЕННОМ каталоге конфигурации. Доказательство — байты на диске после
 * решения человека. MCP — настоящий stdio-процесс `tools/qa/mcp-marker.mjs`.
 */
const ORIGIN = 'http://localhost:8888';
const MARKER = resolve(import.meta.dirname, '../../../../../tools/qa/mcp-marker.mjs');

const SETTINGS = {
  env: { PLAIN: 'one' },
  permissions: { allow: ['Read', 'Bash(ls:*)'], deny: [] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node first.mjs' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node second.mjs' }] },
    ],
  },
};

describe('panel-agent actions: entity rows and skill structure', () => {
  let base: string;
  let root: string;
  let appData: string;
  let pending: PanelPendingActions;
  let app: FastifyInstance;

  const paths = () => ({
    root,
    appData,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    commands: join(root, 'commands'),
    mcpConfig: join(base, '.claude.json'),
  });
  const json = (file: string) =>
    existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as {
          env?: Record<string, string>;
          permissions?: { allow?: string[]; deny?: string[] };
          hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        })
      : {};
  const skillPath = (...parts: string[]) => join(root, 'skills', ...parts);

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-entities-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(skillPath('review'), { recursive: true });
    writeFileSync(paths().settings, `${JSON.stringify(SETTINGS, null, 2)}\n`);
    writeFileSync(
      paths().mcpConfig,
      `${JSON.stringify(
        {
          mcpServers: {
            marker: { type: 'stdio', command: process.execPath, args: [MARKER] },
            dying: { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(2)'] },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      skillPath('review', 'SKILL.md'),
      '---\nname: review\ndescription: Code review\n---\n\n# Review\n',
    );
    writeFileSync(skillPath('review', 'notes.md'), 'Old notes.\n');
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );

    const store = new AppStore(appData);
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: { paths: paths() },
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
    registerResourceRoutes(app, ctx, NO_ROUTE);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const post = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-entities' },
    });

  const call = async (name: string, input: unknown) =>
    (await post(name, input)).json<PanelActionResult>();

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject' = 'approve',
    between?: () => void | Promise<void>,
  ): Promise<{ card?: PanelPendingAction; result: PanelActionResult }> => {
    let settled = false;
    const running = post(name, input).then((res) => {
      settled = true;
      return res.json<PanelActionResult>();
    });
    let card: PanelPendingAction | undefined;
    while (!settled && !card) {
      [card] = await listPending();
      if (!card) await new Promise((done) => setTimeout(done, 10));
    }
    if (card) {
      await between?.();
      const answered = await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision },
      });
      expect(answered.statusCode).toBe(200);
    }
    return { ...(card ? { card } : {}), result: await running };
  };

  const hooks = async (): Promise<Hook[]> =>
    (await app.inject({ method: 'GET', url: '/api/hooks' })).json();

  // --- Скилл: имя ---

  it('rename_skill: папка переименована; занятое имя и отказ человека — папка на месте', async () => {
    mkdirSync(skillPath('taken'));
    writeFileSync(skillPath('taken', 'SKILL.md'), '---\nname: taken\ndescription: t\n---\n');
    const taken = await call('rename_skill', { id: 'review', newId: 'taken' });
    expect(taken.outcome).toBe('failed');
    expect(taken.message).toContain('is taken');

    const rejected = await decided(
      'rename_skill',
      { id: 'review', newId: 'code-review' },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect(existsSync(skillPath('review', 'SKILL.md'))).toBe(true);

    const { card, result } = await decided('rename_skill', { id: 'review', newId: 'code-review' });
    expect(card?.risk).toBe('change');
    expect(card?.preview.summaryCode).toBe('summary-rename-skill');
    expect(card?.preview.diff).toContain('code-review');
    expect(result.outcome).toBe('done');
    expect(existsSync(skillPath('review'))).toBe(false);
    expect(readFileSync(skillPath('code-review', 'notes.md'), 'utf8')).toBe('Old notes.\n');

    const ghost = await call('rename_skill', { id: 'review', newId: 'x' });
    expect(ghost.outcome).toBe('failed');
    expect(ghost.message).toContain('list_skills');
  });

  // --- Хук: порядок ---

  it('move_hook: второй хук поднят над первым; первый вверх — отказ до карточки', async () => {
    const [first, second] = await hooks();
    expect(first!.command).toBe('node first.mjs');

    const edge = await call('move_hook', { id: first!.id, direction: 'up' });
    expect(edge.outcome).toBe('failed');
    expect(edge.message).toContain('already first');
    expect(await listPending()).toEqual([]);

    const { card, result } = await decided('move_hook', { id: second!.id, direction: 'up' });
    expect(card?.preview.summaryCode).toBe('summary-move-hook-up');
    expect(card?.preview.diff).toContain('node second.mjs');
    expect(result.outcome).toBe('done');
    const order = json(paths().settings).hooks!.PreToolUse!.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(order).toEqual(['node second.mjs', 'node first.mjs']);
  });

  it('move_hook: порядок изменился после показа карточки — stale_preview, файл не тронут повторно', async () => {
    const [, second] = await hooks();
    const { result } = await decided(
      'move_hook',
      { id: second!.id, direction: 'up' },
      'approve',
      () => {
        const changed = structuredClone(SETTINGS);
        changed.hooks.PreToolUse.reverse();
        writeFileSync(paths().settings, `${JSON.stringify(changed, null, 2)}\n`);
      },
    );
    expect(result).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    const order = json(paths().settings).hooks!.PreToolUse!.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(order).toEqual(['node second.mjs', 'node first.mjs']);
  });

  // --- Переменная и право: файл ---

  it('move_env: переменная уехала в settings.local.json; неверный источник — отказ', async () => {
    const wrong = await call('move_env', { key: 'PLAIN', source: 'settings-local' });
    expect(wrong.outcome).toBe('failed');
    expect(wrong.message).toContain('list_env');

    const { card, result } = await decided('move_env', { key: 'PLAIN', source: 'settings' });
    expect(card?.preview.summaryCode).toBe('summary-move-env');
    expect(result.outcome).toBe('done');
    expect(json(paths().settings).env?.PLAIN).toBeUndefined();
    expect(json(paths().settingsLocal).env?.PLAIN).toBe('one');
  });

  it('move_permission и edit_permission_rule: файл и решение меняются, неизвестный id — отказ', async () => {
    const moved = await decided('move_permission', { id: 'allow:Bash(ls:*)' });
    expect(moved.card?.preview.summaryCode).toBe('summary-move-permission');
    expect(moved.result.outcome).toBe('done');
    expect(json(paths().settings).permissions?.allow).toEqual(['Read']);
    expect(json(paths().settingsLocal).permissions?.allow).toEqual(['Bash(ls:*)']);

    const edited = await decided('edit_permission_rule', {
      id: 'allow:Read',
      decision: 'deny',
      pattern: 'Read(./secrets/**)',
    });
    expect(edited.card?.preview.summaryCode).toBe('summary-edit-permission');
    expect(edited.card?.preview.diff).toContain('deny');
    expect(edited.result.outcome).toBe('done');
    const after = json(paths().settings).permissions!;
    expect(after.allow ?? []).not.toContain('Read');
    expect(after.deny).toEqual(['Read(./secrets/**)']);

    const ghost = await call('edit_permission_rule', {
      id: 'allow:Nope',
      decision: 'ask',
      pattern: 'Nope',
    });
    expect(ghost.outcome).toBe('failed');
    expect(ghost.message).toContain('list_permissions');
  });

  // --- MCP ---

  it('check_mcp_health и list_mcp_tools: настоящий stdio-сервер отвечает, падающий — failed', async () => {
    const health = await decided('check_mcp_health', { id: 'marker' });
    expect(health.card?.preview.summaryCode).toBe('summary-check-mcp-health');
    expect(health.result.outcome).toBe('done');
    expect(health.result.result).toMatchObject({ health: 'connected' });

    const tools = await decided('list_mcp_tools', { id: 'marker' });
    expect(tools.result.outcome).toBe('done');
    expect(JSON.stringify(tools.result.result)).toContain('"marker"');

    const dying = await decided('check_mcp_health', { id: 'dying' });
    expect(dying.result.result).toMatchObject({ health: 'failed' });

    const unknown = await call('check_mcp_health', { id: 'ghost' });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('list_mcp_servers');
    expect(await listPending()).toEqual([]);
  }, 60_000);

  // --- Файлы структуры скилла ---

  it('list_skill_templates + apply_skill_template: недостающие файлы созданы, SKILL.md не тронут', async () => {
    const list = await call('list_skill_templates', {});
    expect(JSON.stringify(list.result)).toContain('skill-references');

    const skillBefore = readFileSync(skillPath('review', 'SKILL.md'), 'utf8');
    const { card, result } = await decided('apply_skill_template', {
      skill: 'review',
      templateId: 'skill-references',
    });
    expect(card?.preview.summaryCode).toBe('summary-apply-skill-template');
    expect(result.outcome).toBe('done');
    expect(existsSync(skillPath('review', 'references', 'rules.md'))).toBe(true);
    expect(readFileSync(skillPath('review', 'SKILL.md'), 'utf8')).toBe(skillBefore);

    const again = await call('apply_skill_template', {
      skill: 'review',
      templateId: 'skill-references',
    });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('Nothing would change');

    const unknown = await call('apply_skill_template', { skill: 'review', templateId: 'nope' });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('list_skill_templates');
  });

  it('save/read/move/delete_skill_file: файл модуля проходит весь путь; секрет и SKILL.md — отказ', async () => {
    const secret = await call('save_skill_file', {
      skill: 'review',
      file: 'references/key.md',
      content: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(secret.outcome).toBe('failed');
    expect(existsSync(skillPath('review', 'references', 'key.md'))).toBe(false);

    const saved = await decided('save_skill_file', {
      skill: 'review',
      file: 'references/api.md',
      content: '# API\n\nCall it twice.\n',
    });
    expect(saved.card?.preview.summaryCode).toBe('summary-save-skill-file-create');
    expect(saved.card?.preview.diff).toContain('Call it twice.');
    expect(saved.result.outcome).toBe('done');
    expect(readFileSync(skillPath('review', 'references', 'api.md'), 'utf8')).toBe(
      '# API\n\nCall it twice.\n',
    );

    const files = await call('list_skill_files', { skill: 'review' });
    expect(JSON.stringify(files.result)).toContain('references/api.md');
    const read = await call('read_skill_file', { skill: 'review', file: 'references/api.md' });
    expect(JSON.stringify(read.result)).toContain('Call it twice.');

    const moved = await decided('move_skill_file', {
      skill: 'review',
      from: 'notes.md',
      to: 'references/notes.md',
    });
    expect(moved.result.outcome).toBe('done');
    expect(existsSync(skillPath('review', 'notes.md'))).toBe(false);
    expect(readFileSync(skillPath('review', 'references', 'notes.md'), 'utf8')).toBe(
      'Old notes.\n',
    );
    const clash = await call('move_skill_file', {
      skill: 'review',
      from: 'references/api.md',
      to: 'references/notes.md',
    });
    expect(clash.outcome).toBe('failed');
    expect(clash.message).toContain('already exists');

    const entry = await call('delete_skill_file', { skill: 'review', file: 'SKILL.md' });
    expect(entry.outcome).toBe('failed');
    expect(entry.message).toContain('delete_skill');

    const deleted = await decided('delete_skill_file', {
      skill: 'review',
      file: 'references/api.md',
    });
    expect(deleted.card?.risk).toBe('danger');
    expect(deleted.card?.preview.diff).toContain('-Call it twice.');
    expect(deleted.result.outcome).toBe('done');
    expect(existsSync(skillPath('review', 'references', 'api.md'))).toBe(false);
    expect(existsSync(skillPath('review', 'SKILL.md'))).toBe(true);
  });

  it('read_skill_file: нет файла, нет скилла, путь наружу — отказ словами, а не пустое «готово»', async () => {
    const missing = await call('read_skill_file', { skill: 'review', file: 'references/none.md' });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('list_skill_files');

    const ghost = await call('read_skill_file', { skill: 'ghost', file: 'SKILL.md' });
    expect(ghost.outcome).toBe('failed');
    expect(ghost.message).toContain('list_skills');

    const outside = await call('read_skill_file', { skill: 'review', file: '../review/SKILL.md' });
    expect(outside.outcome).toBe('invalid');
    expect(outside.message).toContain('inside the skill folder');
  });

  it('путь наружу папки скилла и имя с разделителем — отказ до карточки', async () => {
    const attempts: Array<[string, Record<string, string>]> = [
      ['save_skill_file', { skill: 'review', file: '../escape.md', content: 'x' }],
      ['save_skill_file', { skill: 'review', file: 'references\\..\\..\\escape.md', content: 'x' }],
      ['save_skill_file', { skill: 'review', file: '/tmp/escape.md', content: 'x' }],
      ['save_skill_file', { skill: 'review', file: 'C:/escape.md', content: 'x' }],
      ['move_skill_file', { skill: 'review', from: 'notes.md', to: '../escape.md' }],
      ['move_skill_file', { skill: 'review', from: '../review/notes.md', to: 'n.md' }],
      ['delete_skill_file', { skill: 'review', file: '../review' }],
      ['rename_skill', { id: 'review', newId: '../escape' }],
      ['rename_skill', { id: 'review', newId: 'a\\b' }],
    ];
    for (const [name, input] of attempts) {
      const { card, result } = await decided(name, input);
      expect({ name, input, card: card?.preview.summaryCode }).toEqual({
        name,
        input,
        card: undefined,
      });
      expect(result.outcome).toBe('invalid');
    }
    expect(await listPending()).toEqual([]);
    expect(existsSync(skillPath('escape.md'))).toBe(false);
    expect(existsSync(skillPath('escape'))).toBe(false);
    expect(readFileSync(skillPath('review', 'notes.md'), 'utf8')).toBe('Old notes.\n');
  });
});
