import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import { unifiedDiff } from '../../domains/config-preview/unified-diff.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerEntityRoutes } from '../entity-routes.ts';
import { registerConfigPreviewRoutes } from '../config-preview-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия «Конфигурация» (А7) на настоящих маршрутах сущностей и ВРЕМЕННОМ
 * каталоге конфигурации — настоящий `~/.claude` здесь не читается и не пишется.
 * Доказательство — байты файлов на диске, копии в каталоге копий и дифф
 * карточки, сверенный с тем, что реально легло в файл.
 */
const ORIGIN = 'http://localhost:8888';

const CLAUDE_MD = [
  '# Мои правила',
  '',
  '## ПРАВИЛО: Отвечать кратко',
  '',
  'Без воды.',
  '',
  '## ПРАВИЛО: Тесты',
  '',
  'Сначала красный тест.',
  '',
].join('\n');

const SETTINGS = {
  env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET-SETTINGS' },
  permissions: { allow: ['Bash(git status:*)', 'Read'], deny: ['Bash(rm:*)'] },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'GITHUB_TOKEN=ghp-SECRET-HOOK node guard.mjs' }],
      },
    ],
  },
};

const MCP_CONFIG = {
  numStartups: 3,
  mcpServers: {
    gitlab: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gitlab-mcp', '--token', 'glpat-SECRET-ARG', '--port', '3000'],
      env: {
        GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-SECRET-ENV',
        GITLAB_API_URL: 'https://gitlab.example.com',
        API_KEY: '${API_KEY}',
      },
    },
    docs: {
      type: 'http',
      url: 'https://docs.example.com/mcp',
      headers: { Authorization: 'Bearer sk-SECRET-HEADER', Accept: 'application/json' },
    },
  },
};

describe('panel-agent actions: configuration', () => {
  let base: string;
  let root: string;
  let appData: string;
  let store: AppStore;
  let hub: EventHub;
  let frames: Array<Record<string, unknown>>;
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
    mcpConfig: join(base, '.claude.json'),
  });
  const backupDir = (): string => join(appData, 'backups');

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-a7-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(join(root, 'skills', 'review'), { recursive: true });
    writeFileSync(paths().claudeMd, CLAUDE_MD);
    writeFileSync(paths().settings, `${JSON.stringify(SETTINGS, null, 2)}\n`);
    writeFileSync(paths().mcpConfig, `${JSON.stringify(MCP_CONFIG, null, 2)}\n`);
    writeFileSync(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Code review\nmodel: opus\n---\n\n# Review\n\nRead the diff.\n',
    );
    writeFileSync(join(root, 'skills', 'review', 'notes.md'), 'extra');

    store = new AppStore(appData);
    hub = createEventHub();
    frames = [];
    hub.subscribe((payload) => frames.push(JSON.parse(payload) as Record<string, unknown>));
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: { paths: paths() },
      backupDir: backupDir(),
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
    registerConfigPreviewRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub, pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-a7' },
    });

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decide = (id: string, decision: 'approve' | 'reject') =>
    app.inject({
      method: 'POST',
      url: `/api/agent/pending/${id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });

  /** Действие с решением человека: карточка и итог. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject',
    beforeDecision?: () => void,
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const running = call(name, input);
    const card = await waitPending();
    beforeDecision?.();
    expect((await decide(card.id, decision)).statusCode).toBe(200);
    return { card, result: (await running).json<PanelActionResult>() };
  };

  /**
   * Все файлы временного конфига (и state.json) байт в байт. Журнал действий
   * агента — след самой панели, а не конфигурация: его запись и есть исход.
   */
  const snapshot = (): Record<string, string> => {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.name === 'agent-actions.jsonl') continue;
        if (entry.isDirectory()) walk(full);
        else files[relative(base, full)] = readFileSync(full, 'base64');
      }
    };
    walk(base);
    return files;
  };

  const backups = (): string[] => (existsSync(backupDir()) ? readdirSync(backupDir()) : []);

  it('чтение: секреты MCP и хуков скрыты, хотя маршрут окна отдаёт их как есть', async () => {
    const raw = await app.inject({ method: 'GET', url: '/api/mcp' });
    // Маршрут окна секреты НЕ маскирует — поэтому маска обязана быть в действии.
    expect(raw.body).toContain('glpat-SECRET-ENV');

    const mcp = (await call('list_mcp', {})).json<PanelActionResult>();
    expect(mcp.outcome).toBe('done');
    const text = JSON.stringify(mcp.result);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('${API_KEY}');
    expect(text).toContain('https://gitlab.example.com');
    expect(text).toContain('application/json');
    expect(text).toContain('3000');

    const hooks = (await call('list_hooks', {})).json<PanelActionResult>();
    expect(hooks.outcome).toBe('done');
    expect(JSON.stringify(hooks.result)).not.toContain('SECRET');
    expect(JSON.stringify(hooks.result)).toContain('node guard.mjs');

    const rules = (await call('list_rules', {})).json<PanelActionResult>();
    expect((rules.result as { rules: Array<{ id: string }> }).rules.map((rule) => rule.id)).toEqual(
      ['otvechat-kratko', 'testy'],
    );
    const permissions = (await call('list_permissions', {})).json<PanelActionResult>();
    expect(JSON.stringify(permissions.result)).toContain('deny');
    const skills = (await call('list_skills', {})).json<PanelActionResult>();
    expect(JSON.stringify(skills.result)).toContain('review');
    expect(await pending.list()).toEqual([]);
  });

  it('отказ человека: ни одна правка не трогает ни байта, копий нет', async () => {
    const before = snapshot();
    const cases: Array<[string, unknown]> = [
      ['save_rule', { id: 'testy', title: 'Тесты', body: 'Другой текст.' }],
      ['toggle_rule', { id: 'testy', isEnabled: false }],
      ['delete_rule', { id: 'otvechat-kratko' }],
      ['save_skill', { name: 'Новый скилл', description: 'Что-то делает', body: '# Тело' }],
      ['delete_skill', { id: 'review' }],
      ['add_permission_rule', { decision: 'allow', pattern: 'Bash(ls:*)' }],
      ['remove_permission_rule', { id: 'deny:Bash(rm:*)' }],
      ['save_mcp_server', { name: 'fresh', transport: 'http', url: 'https://x.example.com/mcp' }],
      ['delete_mcp_server', { id: 'docs' }],
    ];
    for (const [name, input] of cases) {
      const { card, result } = await decided(name, input, 'reject', () => {
        // Карточка висит — предпросмотр уже посчитан, и он тоже ничего не записал.
        expect(snapshot()).toEqual(before);
      });
      expect(result.outcome, name).toBe('rejected');
      expect(card.preview.diff ?? card.preview.fields.length, name).toBeTruthy();
      expect(snapshot(), name).toEqual(before);
    }
    expect(backups()).toEqual([]);
    expect(store.getDisabledIds('rule')).toEqual([]);
  });

  it('правка правила: в файл ложится ровно дифф карточки, копия сделана', async () => {
    const file = paths().claudeMd;
    const before = readFileSync(file, 'utf8');
    const { card, result } = await decided(
      'save_rule',
      { id: 'testy', title: 'Тесты', body: 'Сначала красный тест, потом зелёный.' },
      'approve',
    );
    expect(result.outcome).toBe('done');
    const after = readFileSync(file, 'utf8');
    expect(after).not.toBe(before);
    expect(card.preview.diff).toBe(unifiedDiff(file, before, after).diff);
    expect(card.preview.diff).toContain('+Сначала красный тест, потом зелёный.');
    expect(backups().some((name) => name.startsWith('CLAUDE.md.'))).toBe(true);
  });

  it('выключение правила: дифф совпадает с записью, отметка стоит только после одобрения', async () => {
    const file = paths().claudeMd;
    const before = readFileSync(file, 'utf8');
    const { card, result } = await decided(
      'toggle_rule',
      { id: 'otvechat-kratko', isEnabled: false },
      'approve',
      () => expect(store.isDisabled('rule', 'otvechat-kratko')).toBe(false),
    );
    expect(result.outcome).toBe('done');
    expect(store.isDisabled('rule', 'otvechat-kratko')).toBe(true);
    expect(card.preview.diff).toBe(unifiedDiff(file, before, readFileSync(file, 'utf8')).diff);
  });

  it('удаление правила и MCP-сервера: одобрено — ровно дифф и копия', async () => {
    const md = paths().claudeMd;
    const mdBefore = readFileSync(md, 'utf8');
    const rule = await decided('delete_rule', { id: 'testy' }, 'approve');
    expect(rule.result.outcome).toBe('done');
    expect(rule.card.risk).toBe('danger');
    // А9 D3: человек узнаёт правило по заголовку, слаг — вторым полем.
    expect(rule.card.preview).toMatchObject({
      summary: 'Удалить правило «Тесты»',
      summaryCode: 'summary-rule-delete',
      summaryParams: { title: 'Тесты' },
    });
    expect(rule.card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-id', value: 'testy' }),
    );
    // А9 D4: каждая подпись карточки — кодом, окно переводит её.
    for (const field of rule.card.preview.fields) expect(field.labelCode).toBeDefined();
    expect(rule.card.preview.diff).toBe(unifiedDiff(md, mdBefore, readFileSync(md, 'utf8')).diff);

    const mcp = paths().mcpConfig;
    const mcpBefore = readFileSync(mcp, 'utf8');
    const server = await decided('delete_mcp_server', { id: 'docs' }, 'approve');
    expect(server.result.outcome).toBe('done');
    const mcpAfter = readFileSync(mcp, 'utf8');
    expect(mcpAfter).not.toContain('docs.example.com');
    expect(server.card.preview.diff).toBe(unifiedDiff(mcp, mcpBefore, mcpAfter).diff);
    // Удаляемый заголовок с токеном виден в диффе только маской.
    expect(server.card.preview.diff).not.toContain('SECRET');
    expect(backups().some((name) => name.startsWith('.claude.json.'))).toBe(true);
  });

  it('права и скилл: дифф карточки = изменение файла', async () => {
    const settings = paths().settings;
    const settingsBefore = readFileSync(settings, 'utf8');
    const add = await decided(
      'add_permission_rule',
      { decision: 'allow', pattern: 'Bash(ls:*)' },
      'approve',
    );
    expect(add.result.outcome).toBe('done');
    const settingsAfter = readFileSync(settings, 'utf8');
    expect(add.card.preview.diff).toBe(unifiedDiff(settings, settingsBefore, settingsAfter).diff);
    expect(add.card.preview.diff).toContain('+      "Bash(ls:*)",');
    expect(settingsAfter).toContain('sk-ant-SECRET-SETTINGS');
    expect(add.card.preview.diff).not.toContain('SECRET');
    expect(backups().some((name) => name.startsWith('settings.json.'))).toBe(true);

    const skillFile = join(root, 'skills', 'review', 'SKILL.md');
    const skillBefore = readFileSync(skillFile, 'utf8');
    const skill = await decided(
      'save_skill',
      { id: 'review', name: 'review', description: 'Строгое ревью' },
      'approve',
    );
    expect(skill.result.outcome).toBe('done');
    const skillAfter = readFileSync(skillFile, 'utf8');
    // Без тела правка сохраняет нынешнее тело и чужие поля шапки.
    expect(skillAfter).toContain('Read the diff.');
    expect(skillAfter).toContain('model: opus');
    expect(skill.card.preview.diff).toBe(unifiedDiff(skillFile, skillBefore, skillAfter).diff);
  });

  it('удаление скилла отклонено — папка на месте; одобрено — копия в истории', async () => {
    const dir = join(root, 'skills', 'review');
    const rejected = await decided('delete_skill', { id: 'review' }, 'reject');
    expect(rejected.card.preview.fields.map((field) => field.value).join(' ')).toContain(
      'notes.md',
    );
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);

    const approved = await decided('delete_skill', { id: 'review' }, 'approve');
    expect(approved.result.outcome).toBe('done');
    expect(existsSync(dir)).toBe(false);
    expect(backups().some((name) => name.includes('review'))).toBe(true);
  });

  it('заметка «Кроме файла» едет кодом: английское окно не читает русскую строку', async () => {
    // Значение поля пишет сама панель, а не данные пользователя. Без кода
    // подпись переводилась, а значение оставалось русским — ровно в том поле,
    // ради которого карточку и читают перед одобрением.
    const rejected = await decided('delete_skill', { id: 'review' }, 'reject');
    const notes = rejected.card.preview.fields.filter(
      (field) => field.labelCode === 'label-besides-file',
    );

    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.valueCode).toBeTruthy();
      expect(note.value).not.toBe('');
    }
    expect(notes.map((note) => note.valueCode)).toContain('note-skill-folder-delete');
  });

  it('MCP: секрет от агента не принимается, пустой секрет не затирает сохранённый, дальше — шаг человека', async () => {
    const mcp = paths().mcpConfig;
    const before = readFileSync(mcp, 'utf8');
    const literal = (
      await call('save_mcp_server', {
        name: 'leak',
        transport: 'stdio',
        command: 'node',
        env: { SERVICE_TOKEN: 'tok-SECRET-FROM-AGENT' },
      })
    ).json<PanelActionResult>();
    expect(literal.outcome).toBe('invalid');
    expect(literal.message).toContain('env.SERVICE_TOKEN');
    expect(await pending.list()).toEqual([]);
    expect(readFileSync(mcp, 'utf8')).toBe(before);

    frames.length = 0;
    const { card, result } = await decided(
      'save_mcp_server',
      {
        id: 'gitlab',
        name: 'gitlab',
        transport: 'stdio',
        env: {
          GITLAB_PERSONAL_ACCESS_TOKEN: '',
          GITLAB_API_URL: 'https://gitlab2.example.com',
          NEW_SERVICE_TOKEN: '',
        },
      },
      'approve',
    );
    const after = readFileSync(mcp, 'utf8');
    expect(card.preview.diff).toBe(unifiedDiff(mcp, before, after).diff);
    expect(card.preview.diff).not.toContain('SECRET');
    // Сохранённый токен на месте, аргументы не присланы — остались прежними.
    expect(after).toContain('glpat-SECRET-ENV');
    expect(after).toContain('glpat-SECRET-ARG');
    expect(after).toContain('gitlab2.example.com');
    expect(result.outcome).toBe('needs-secret');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    // А9 D2: страница — форма ЭТОГО сервера с фокусом в пустом секрете, а не список.
    expect(result.page).toEqual({ route: '/mcp', focus: 'mcp-secret:gitlab' });
    expect(frames.some((frame) => frame.type === 'agent-open-page')).toBe(true);
    expect(card.preview.fields.find((field) => field.label === 'Секреты введёте вы')?.value).toBe(
      'env.NEW_SERVICE_TOKEN',
    );
  });

  /**
   * Секреты НАСТОЯЩИХ форм (ревью 17.09.2026, `mask-probe.ts`): прежняя маска
   * ловила только имена и слово «SECRET» фикстуры выше, а эти значения уходили
   * модели как есть. Значения собраны из кусков — в репозитории их нет.
   */
  const j = (...parts: string[]): string => parts.join('');
  const REAL = {
    bearer: j('Zq7xLm29', 'PvR4tKw8'),
    xAuth: j('Hn3bV8', 'cQ1wE5rT'),
    userinfo: j('pW9', 'mK2sX7'),
    ghp: j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
    hex: j('3f9a1c7e5b2d4a6f', '8e0c1b3d5f7a9c2e'),
    dbPass: j('Db', 'Pa55w0rdX'),
    hook: j('Tk4', 'nY7uI0oP'),
    perm: j('Pm8', 'qW3eR6tY'),
  };

  const writeRealShapes = (indent: number): void => {
    const config = {
      numStartups: 3,
      mcpServers: {
        remote: {
          type: 'stdio',
          command: 'npx',
          args: [
            'mcp-remote',
            'https://mcp.example.com/sse',
            '--header',
            `Authorization: Bearer ${REAL.bearer}`,
          ],
        },
        docker: {
          type: 'stdio',
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', `GITHUB_PERSONAL_ACCESS_TOKEN=${REAL.ghp}`, 'gh-mcp'],
        },
        xauth: {
          type: 'http',
          url: `https://svc:${REAL.userinfo}@api.example.com/mcp`,
          headers: { 'X-Auth': REAL.xAuth },
        },
        db: {
          type: 'stdio',
          command: 'node',
          args: ['db.mjs'],
          env: { DATABASE_URL: `postgres://app:${REAL.dbPass}@db.local/app`, CONTOUR: REAL.hex },
        },
      },
    };
    writeFileSync(paths().mcpConfig, `${JSON.stringify(config, null, indent)}\n`);
    const settings = {
      permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${REAL.perm}":*)`] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `curl -H "X-Auth: ${REAL.hook}" https://hooks.example.com`,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(paths().settings, `${JSON.stringify(settings, null, 2)}\n`);
  };
  const leaked = (text: string): string[] =>
    Object.entries(REAL)
      .filter(([, value]) => text.includes(value))
      .map(([key]) => key);

  it('секреты настоящих форм: ни чтение, ни карточка, ни поток событий их не несут', async () => {
    writeRealShapes(2);
    for (const name of ['list_mcp', 'list_hooks', 'list_permissions']) {
      const result = (await call(name, {})).json<PanelActionResult>();
      expect(result.outcome, name).toBe('done');
      expect(leaked(JSON.stringify(result)), name).toEqual([]);
    }
    const list = JSON.stringify((await call('list_mcp', {})).json<PanelActionResult>());
    expect(list).toContain('mcp-remote');
    expect(list).toContain('api.example.com');

    // Карточка правки сервера и её кадры в потоке: соседние строки диффа тоже под маской.
    frames.length = 0;
    const running = call('save_mcp_server', {
      id: 'db',
      name: 'db',
      transport: 'stdio',
      env: { LOG_LEVEL: 'debug' },
    });
    const card = await waitPending();
    expect(card.preview.diff).toContain('LOG_LEVEL');
    expect(leaked(JSON.stringify(card)), 'card').toEqual([]);
    expect(leaked(JSON.stringify(await pending.list())), 'pending').toEqual([]);
    expect(leaked(JSON.stringify(frames)), 'sse').toEqual([]);
    expect((await decide(card.id, 'reject')).statusCode).toBe(200);
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');

    // Id права с секретом непрозрачен, но удаление по нему находит право.
    const perms = (await call('list_permissions', {})).json<PanelActionResult>().result as {
      permissions: Array<{ id: string }>;
    };
    const [perm] = perms.permissions;
    expect(perm?.id).toMatch(/^masked:[0-9a-f]{16}$/);
    frames.length = 0;
    const removed = await decided('remove_permission_rule', { id: perm!.id }, 'approve');
    expect(leaked(JSON.stringify([removed.card, frames])), 'remove card').toEqual([]);
    expect(removed.result.outcome).toBe('done');
    expect(readFileSync(paths().settings, 'utf8')).not.toContain(REAL.perm);
  });

  it('секрет открытым текстом в заголовке, адресе и аргументах — отказ до карточки', async () => {
    const before = readFileSync(paths().mcpConfig, 'utf8');
    const attempts: Array<[unknown, string]> = [
      [
        {
          name: 'a',
          transport: 'http',
          url: 'https://x.example.com/mcp',
          headers: { 'X-Auth': REAL.xAuth },
        },
        'headers.X-Auth',
      ],
      [
        { name: 'b', transport: 'http', url: `https://svc:${REAL.userinfo}@x.example.com/mcp` },
        'url',
      ],
      [
        {
          name: 'c',
          transport: 'stdio',
          command: 'npx',
          args: ['mcp-remote', 'https://x', '--header', `Authorization: Bearer ${REAL.bearer}`],
        },
        'args.3',
      ],
      [
        {
          name: 'd',
          transport: 'stdio',
          command: 'docker',
          args: ['run', '-e', `GITHUB_PERSONAL_ACCESS_TOKEN=${REAL.ghp}`],
        },
        'args.2',
      ],
    ];
    for (const [input, path] of attempts) {
      const result = (await call('save_mcp_server', input)).json<PanelActionResult>();
      expect(result.outcome, path).toBe('invalid');
      expect(result.message, path).toContain(path);
      expect(leaked(JSON.stringify(result)), path).toEqual([]);
    }
    expect(await pending.list()).toEqual([]);
    expect(readFileSync(paths().mcpConfig, 'utf8')).toBe(before);
  });

  it('сервер с сохранёнными секретами агент не перенацеливает; сервер без секретов — можно', async () => {
    writeRealShapes(2);
    const before = snapshot();
    const moves: Array<[string, unknown]> = [
      [
        'url',
        { id: 'xauth', name: 'xauth', transport: 'http', url: 'https://evil.example.net/mcp' },
      ],
      [
        'args',
        {
          id: 'remote',
          name: 'remote',
          transport: 'stdio',
          args: ['mcp-remote', 'https://evil.example.net/sse'],
        },
      ],
      ['command', { id: 'db', name: 'db', transport: 'stdio', command: 'evil' }],
      [
        'transport',
        { id: 'db', name: 'db', transport: 'http', url: 'https://evil.example.net/mcp' },
      ],
    ];
    for (const [field, input] of moves) {
      const result = (await call('save_mcp_server', input)).json<PanelActionResult>();
      expect(result.outcome, field).toBe('failed');
      expect(result.message, field).toContain('stored secrets');
      expect(result.message, field).toContain(field);
    }
    expect(await pending.list()).toEqual([]);
    expect(snapshot()).toEqual(before);

    writeFileSync(
      paths().mcpConfig,
      `${JSON.stringify({ mcpServers: { plain: { type: 'http', url: 'https://a.example.com/mcp' } } }, null, 2)}\n`,
    );
    const { result } = await decided(
      'save_mcp_server',
      { id: 'plain', name: 'plain', transport: 'http', url: 'https://b.example.com/mcp' },
      'approve',
    );
    expect(result.outcome).toBe('done');
    expect(readFileSync(paths().mcpConfig, 'utf8')).toContain('b.example.com');
  });

  it('файл с чужим отступом: карточка называет переписывание формы', async () => {
    writeRealShapes(4);
    const running = call('save_mcp_server', {
      id: 'db',
      name: 'db',
      transport: 'stdio',
      env: { LOG_LEVEL: 'debug' },
    });
    const card = await waitPending();
    const note = card.preview.fields.find((field) => field.label === 'Форма файла');
    expect(note?.value).toContain('отступ 2 пробела');
    expect((await decide(card.id, 'reject')).statusCode).toBe(200);
    await running;
  });

  it('неизвестная цель и другой активный CLI — отказ до карточки, файлы целы', async () => {
    const before = snapshot();
    const missing = (
      await call('toggle_rule', { id: 'нет-такого', isEnabled: false })
    ).json<PanelActionResult>();
    expect(missing.outcome).toBe('failed');
    const nothing = (
      await call('toggle_rule', { id: 'testy', isEnabled: true })
    ).json<PanelActionResult>();
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('Nothing would change');

    store.updateSettings({ provider: 'codex' });
    const foreign = (await call('list_rules', {})).json<PanelActionResult>();
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('codex');
    const edit = (
      await call('add_permission_rule', { decision: 'allow', pattern: 'Read' })
    ).json<PanelActionResult>();
    expect(edit.outcome).toBe('failed');
    expect(await pending.list()).toEqual([]);
    const after = snapshot();
    delete after[relative(base, join(appData, 'state.json'))];
    const expected = { ...before };
    delete expected[relative(base, join(appData, 'state.json'))];
    expect(after).toEqual(expected);
  });

  it('карточка устарела: цель изменилась между показом и кликом — stale_preview, ни байта агента', async () => {
    const md = paths().claudeMd;
    const settings = paths().settings;
    const mcp = paths().mcpConfig;
    const skillDir = join(root, 'skills', 'review');
    const edit = (file: string, from: string, to: string) => () => {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(from);
      writeFileSync(file, text.replace(from, to));
    };
    // Человек правит цель руками / маршрутом окна, пока карточка ждёт клика.
    const cases: Array<[string, unknown, () => void | Promise<void>]> = [
      [
        'save_rule',
        { id: 'testy', title: 'Тесты', body: 'Текст агента.' },
        edit(md, 'Сначала красный тест.', 'Правка человека.'),
      ],
      [
        'toggle_rule',
        { id: 'testy', isEnabled: false },
        async () => {
          const res = await app.inject({
            method: 'POST',
            url: `/api/entities/rule/otvechat-kratko/enabled`,
            headers: { origin: ORIGIN },
            payload: { isEnabled: false },
          });
          expect(res.statusCode).toBe(200);
        },
      ],
      ['delete_skill', { id: 'review' }, () => writeFileSync(join(skillDir, 'human.md'), 'новый')],
      [
        'add_permission_rule',
        { decision: 'allow', pattern: 'Bash(ls:*)' },
        edit(settings, '"Read"', '"Read", "Write"'),
      ],
      ['delete_mcp_server', { id: 'docs' }, edit(mcp, 'gitlab-mcp', 'gitlab-mcp-human')],
    ];
    for (const [name, input, humanEdit] of cases) {
      const running = call(name, input);
      const card = await waitPending();
      await humanEdit();
      const edited = snapshot();
      const backupsBefore = backups();
      frames.length = 0;
      expect((await decide(card.id, 'approve')).statusCode, name).toBe(200);
      const result = (await running).json<PanelActionResult>();
      expect(result, name).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
      expect(result.message, name).toMatch(/call .+ again/i);
      // На диске — правка человека, записи агента нет, новых копий нет.
      expect(snapshot(), name).toEqual(edited);
      expect(backups(), name).toEqual(backupsBefore);
      expect(frames, name).toContainEqual(
        expect.objectContaining({
          type: 'agent-decided',
          id: card.id,
          outcome: 'failed',
          messageCode: 'stale_preview',
        }),
      );
      const journal = readFileSync(agentJournalPath(appData), 'utf8').trim().split('\n');
      expect(JSON.parse(journal.at(-1) ?? '{}'), name).toMatchObject({
        name,
        outcome: 'failed',
        decidedBy: 'human',
        messageCode: 'stale_preview',
        summaryFacts: expect.arrayContaining(['fact-stale']),
      });
      // А9 D4: карточка любой правки конфигурации — сводка и подписи кодом.
      expect(card.preview.summaryCode, name).toBeDefined();
      for (const field of card.preview.fields) expect(field.labelCode, name).toBeDefined();
    }
    expect(await pending.list()).toEqual([]);

    // Сам Claude Code пишет в ~/.claude.json своё (счётчики) — карточка MCP от
    // этого не устаревает: отпечаток — секция серверов, а не весь файл.
    const server = await decided('delete_mcp_server', { id: 'docs' }, 'approve', () =>
      edit(mcp, '"numStartups": 3', '"numStartups": 4')(),
    );
    expect(server.result.outcome).toBe('done');
    expect(readFileSync(mcp, 'utf8')).not.toContain('docs.example.com');
    expect(readFileSync(mcp, 'utf8')).toContain('"numStartups": 4');
  });
});
