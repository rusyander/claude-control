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
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { SECRET_MASK } from '../../../lib/secret-mask/secret-mask.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { agentJournalPath } from '../../../domains/panel-agent/journal/journal.ts';
import { unifiedDiff } from '../../../domains/config-preview/unified-diff.ts';
import { registerConfigRoutes } from '../../config-routes/config-routes.ts';
import { registerEntityRoutes } from '../../entity-routes/entity-routes.ts';
import { registerConfigPreviewRoutes } from '../../config-preview-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';

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
    // Переключение по непрозрачному id: страница получает тот же id, а не шаблон с секретом.
    frames.length = 0;
    const off = await decided(
      'toggle_permission_rule',
      { id: perm!.id, isEnabled: false },
      'approve',
    );
    expect(off.result).toMatchObject({
      outcome: 'done',
      page: { route: '/permissions', focus: perm!.id },
    });
    expect(leaked(JSON.stringify([off.card, off.result, frames])), 'toggle').toEqual([]);
    const on = await decided(
      'toggle_permission_rule',
      { id: perm!.id, isEnabled: true },
      'approve',
    );
    expect(on.result.outcome).toBe('done');
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

  it('MCP, прочитанный маской и присланный обратно: секреты на диске целы, правка легла', async () => {
    writeRealShapes(2);
    type Shown = {
      name: string;
      transport: string;
      command?: string;
      args: string[];
      url?: string;
      env: Record<string, string>;
      headers: Record<string, string>;
    };
    const listed = (await call('list_mcp', {})).json<PanelActionResult>().result as {
      servers: Shown[];
    };
    // Ровно те поля записи, что модель прочла, — служебные поля окна не шлются.
    const shown = (name: string): Shown => {
      const { transport, command, args, url, env, headers } = listed.servers.find(
        (item) => item.name === name,
      )!;
      return { name, transport, command, args, url, env, headers };
    };
    const edits: Array<[string, Record<string, unknown>]> = [
      ['xauth', { headers: { ...shown('xauth').headers, Accept: 'application/json' } }],
      ['db', { env: { ...shown('db').env, DEBUG: '1' } }],
      ['remote', { env: { DEBUG: '1' } }],
    ];
    for (const [name, change] of edits) {
      const { result } = await decided(
        'save_mcp_server',
        { ...shown(name), id: name, ...change },
        'approve',
      );
      expect(result.outcome, name).toBe('done');
    }
    const after = readFileSync(paths().mcpConfig, 'utf8');
    expect(after).not.toContain(SECRET_MASK);
    expect(
      Object.keys(REAL).filter((key) => after.includes(REAL[key as keyof typeof REAL])),
    ).toEqual(['bearer', 'xAuth', 'userinfo', 'ghp', 'hex', 'dbPass']);
    expect(after.match(/"DEBUG": "1"/g)).toHaveLength(2);
    expect(after).toContain('"Accept": "application/json"');

    // Маска в правленом значении — отказ: пароль не уезжает на новый хост.
    const before = snapshot();
    const moved = (
      await call('save_mcp_server', {
        ...shown('db'),
        id: 'db',
        env: {
          ...shown('db').env,
          DATABASE_URL: shown('db').env.DATABASE_URL!.replace('db.local', 'evil.example.net'),
        },
      })
    ).json<PanelActionResult>();
    expect(moved.outcome).toBe('failed');
    expect(moved.message).toContain('env.DATABASE_URL');
    expect(await pending.list()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('правило с секретом и длинным телом: полное чтение по id, правка по маске не стирает ключ', async () => {
    const key = j('Zx9kLmN0pQrS7t', 'UvWxYz12345');
    const tail = 'Хвост правила, который обрезан в списке.';
    const body = `Ключ контура: key=${key}\n\n${'Длинное пояснение. '.repeat(100)}\n${tail}`;
    writeFileSync(paths().claudeMd, `${CLAUDE_MD}\n## ПРАВИЛО: Контур\n\n${body}\n`);

    const list = (await call('list_rules', {})).json<PanelActionResult>().result as {
      rules: Array<{ id: string; body: string; bodyTruncated?: boolean }>;
    };
    const head = list.rules.find((rule) => rule.id === 'kontur')!;
    expect(head.bodyTruncated).toBe(true);
    expect(head.body).not.toContain(tail);
    expect(JSON.stringify(list)).not.toContain(key);

    const full = (await call('list_rules', { id: 'kontur' })).json<PanelActionResult>().result as {
      body: { text: string; length: number };
    };
    expect(full.body.text).toContain(tail);
    expect(full.body.text).not.toContain(key);

    const { card, result } = await decided(
      'save_rule',
      { id: 'kontur', title: 'Контур', body: full.body.text.replace(tail, 'Новый хвост.') },
      'approve',
    );
    expect(result.outcome).toBe('done');
    expect(card.preview.diff).not.toContain(key);
    const after = readFileSync(paths().claudeMd, 'utf8');
    expect(after).toContain(`key=${key}`);
    expect(after).toContain('Новый хвост.');
    expect(after).not.toContain(SECRET_MASK);

    // Лишняя маска — отказ до карточки, файл цел.
    const before = snapshot();
    const extra = (
      await call('save_rule', {
        id: 'kontur',
        title: 'Контур',
        body: `${full.body.text}\nЕщё ключ: key=${SECRET_MASK}`,
      })
    ).json<PanelActionResult>();
    expect(extra.outcome).toBe('failed');
    expect(await pending.list()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('bodyTruncated меряет показанный (маскированный) текст, а не сырой', async () => {
    // Сырой текст длиннее предела только за счёт секрета: маска его короче,
    // и показанное тело целиком влезает — флаг «обрезано» тут был бы ложью.
    const key = j('Zx9kLmN0pQrS7tUvWxYz', '12345abcdeFGHIJklmnoPQRST67890');
    const tail = 'Конец.';
    const filler = 'Пояснение. '
      .repeat(200)
      .slice(0, 1500 - `key=${key}\n`.length - tail.length + 5);
    const body = `key=${key}\n${filler}${tail}`;
    writeFileSync(paths().claudeMd, `${CLAUDE_MD}\n## ПРАВИЛО: Контур\n\n${body}\n`);

    const list = (await call('list_rules', {})).json<PanelActionResult>().result as {
      rules: Array<{ id: string; body: string; bodyTruncated?: boolean }>;
    };
    const head = list.rules.find((rule) => rule.id === 'kontur')!;
    expect(head.body).not.toContain(key);
    expect(head.body.endsWith(tail)).toBe(true);
    expect(head.bodyTruncated).toBeUndefined();
  });

  it('[P1] скилл с секретом: тело читается по id маской, правка шага не стирает ключ ни в описании, ни в теле', async () => {
    const key = j('glp', 'at-', 'Qw8eRt6yUi4oPa2sDf0g');
    const skillFile = join(root, 'skills', 'deploy', 'SKILL.md');
    mkdirSync(join(root, 'skills', 'deploy'), { recursive: true });
    writeFileSync(
      skillFile,
      `---\nname: deploy\ndescription: Деплой с токеном ${key}\n---\n\n# Деплой\n\n1. Сборка.\n2. Заливка, токен ${key}.\n`,
    );

    const listed = (await call('list_skills', {})).json<PanelActionResult>();
    expect(JSON.stringify(listed)).not.toContain(key);

    // Без чтения тела модель не может дописать шаг: save_skill заменяет тело целиком.
    const full = (await call('list_skills', { id: 'deploy' })).json<PanelActionResult>();
    expect(full.outcome).toBe('done');
    const skill = full.result as { description: string; body: { text: string } };
    expect(skill.body.text).toContain('2. Заливка, токен');
    expect(JSON.stringify(full)).not.toContain(key);

    const { card, result } = await decided(
      'save_skill',
      {
        id: 'deploy',
        name: 'deploy',
        description: skill.description,
        body: `${skill.body.text}3. Проверь логи.\n`,
      },
      'approve',
    );
    expect(result.outcome).toBe('done');
    expect(card.preview.diff).not.toContain(key);
    const after = readFileSync(skillFile, 'utf8');
    expect(after).toContain(`description: Деплой с токеном ${key}`);
    expect(after).toContain(`2. Заливка, токен ${key}.`);
    expect(after).toContain('3. Проверь логи.');
    expect(after).not.toContain(SECRET_MASK);
  });

  it('[P1] описания правок текста говорят модели, что маска •••••• возвращается с диска', async () => {
    const actions = (await app.inject({ method: 'GET', url: '/api/agent/actions' })).json<{
      actions: Array<{ name: string; description: string }>;
    }>().actions;
    for (const name of ['save_rule', 'save_skill']) {
      const description = actions.find((action) => action.name === name)?.description ?? '';
      expect(description, name).toContain(SECRET_MASK);
    }
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

  it('созданное и переименованное правило, новый скилл: экран и итог несут НОВЫЙ id', async () => {
    const ruleIds = async (): Promise<Array<{ id: string; title: string }>> =>
      (await app.inject({ method: 'GET', url: '/api/rules' })).json();

    // Создание: id правила — слаг заголовка, известный только после записи.
    const created = await decided(
      'save_rule',
      { title: 'Зелёный прогон', body: 'Прогон зелёный.' },
      'approve',
    );
    expect(created.result.outcome).toBe('done');
    const fresh = (await ruleIds()).find((rule) => rule.title === 'Зелёный прогон');
    expect(fresh).toBeDefined();
    expect(created.result.page).toEqual({ route: '/rules', focus: fresh!.id });
    expect(created.result.result).toMatchObject({ id: fresh!.id });

    // Переименование меняет слаг: фокус на старом id указывал бы в пустоту.
    const renamed = await decided(
      'save_rule',
      { id: 'testy', title: 'Тесты сначала', body: 'Сначала тест.' },
      'approve',
    );
    expect(renamed.result.outcome).toBe('done');
    const moved = (await ruleIds()).find((rule) => rule.title === 'Тесты сначала');
    expect(moved).toBeDefined();
    expect(moved!.id).not.toBe('testy');
    expect(renamed.result.page).toEqual({ route: '/rules', focus: moved!.id });

    // Скилл: папка выводится из имени — её и фокусируем.
    const skill = await decided(
      'save_skill',
      { name: 'Новый скилл', description: 'Что-то делает', body: '# Тело' },
      'approve',
    );
    expect(skill.result.outcome).toBe('done');
    const skills: Array<{ id: string; name: string }> = (
      await app.inject({ method: 'GET', url: '/api/skills' })
    ).json();
    const made = skills.find((item) => item.name === 'Новый скилл');
    expect(made).toBeDefined();
    expect(skill.result.page).toEqual({ route: '/skills', focus: made!.id });
  });

  // Фильтр сравнивал запрос с СЫРЫМ шаблоном: модель видела `Bearer ••••••`, но по
  // счётчику total подбирала токен посимвольно — `ghp_Abc1` → 1, `ghp_Xyz9` → 0.
  it('list_permissions: фильтр не выдаёт подстроки замаскированного токена', async () => {
    const token = `ghp_Abc123SecretTokenValue${'0'.repeat(14)}`;
    writeFileSync(
      paths().settings,
      `${JSON.stringify({ permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${token}" https://api.github.com/*)`] } }, null, 2)}\n`,
    );
    const total = async (query: string): Promise<number> =>
      (
        (await call('list_permissions', { query })).json<PanelActionResult>().result as {
          total: number;
        }
      ).total;
    expect(await total('api.github.com')).toBe(1);
    expect(await total('ghp_Abc1')).toBe(0);
    expect(await total('SecretToken')).toBe(0);
  });

  it('[P3] list_permissions: длинный список — страница, итоги и фильтр влезают в ответ моста', async () => {
    const many = Array.from(
      { length: 220 },
      (_, index) => `mcp__agentdeck-probe-server-${index}__some_fairly_long_tool_name_${index}`,
    );
    writeFileSync(
      paths().settings,
      `${JSON.stringify({ permissions: { allow: many, deny: ['Bash(rm:*)'], ask: ['Write'] } }, null, 2)}\n`,
    );
    type Page = {
      total: number;
      counts: { allow: number; ask: number; deny: number; disabled: number };
      offset: number;
      nextOffset?: number;
      permissions: Array<{ id: string; decision: string }>;
    };
    const page = async (input: unknown): Promise<Page> => {
      const answer = (await call('list_permissions', input)).json<PanelActionResult>();
      expect(answer.outcome).toBe('done');
      // Мост режет ответ на 20 000 символах JSON — страница обязана влезать целиком.
      expect(JSON.stringify(answer.result).length).toBeLessThan(20_000);
      return answer.result as Page;
    };
    const first = await page({});
    expect(first.total).toBe(222);
    expect(first.counts).toEqual({ allow: 220, ask: 1, deny: 1, disabled: 0 });
    expect(first.nextOffset).toBe(first.permissions.length);
    const seen = new Set(first.permissions.map((rule) => rule.id));
    for (let next = first.nextOffset; next !== undefined;) {
      const more = await page({ offset: next });
      for (const rule of more.permissions) seen.add(rule.id);
      next = more.nextOffset;
    }
    expect(seen.size).toBe(222);
    const denies = await page({ decision: 'deny' });
    expect(denies.total).toBe(1);
    expect(denies.permissions.map((rule) => rule.id)).toEqual(['deny:Bash(rm:*)']);
    const found = await page({ query: 'SERVER-17__' });
    expect(found.permissions.map((rule) => rule.id)).toEqual([
      'allow:mcp__agentdeck-probe-server-17__some_fairly_long_tool_name_17',
    ]);
  });

  it('[P3] add_permission_rule: экран докручивает список до нового права', async () => {
    const added = await decided(
      'add_permission_rule',
      { decision: 'deny', pattern: ' Bash(curl:*) ' },
      'approve',
    );
    expect(added.result.outcome).toBe('done');
    const ids = (await app.inject({ method: 'GET', url: '/api/permissions' }))
      .json<Array<{ id: string }>>()
      .map((rule) => rule.id);
    expect(ids).toContain('deny:Bash(curl:*)');
    expect(added.result.page).toEqual({ route: '/permissions', focus: 'deny:Bash(curl:*)' });
  });

  it('[P3] add_permission_rule: заголовок карточки называет решение словами, а не ключом allow/deny/ask', async () => {
    // Живой прогон: «Добавить право deny: Bash(…)» — английский ключ посреди русской карточки.
    const expected = {
      allow: 'Разрешить: Bash(probe-a:*)',
      deny: 'Запретить: Bash(probe-d:*)',
      ask: 'Спрашивать перед: Bash(probe-q:*)',
    } as const;
    for (const decision of ['allow', 'deny', 'ask'] as const) {
      const pattern = expected[decision].slice(expected[decision].indexOf(': ') + 2);
      const { card } = await decided('add_permission_rule', { decision, pattern }, 'reject');
      expect(card.preview.summary).toBe(expected[decision]);
      expect(card.preview.summaryCode).toBe(`summary-permission-add-${decision}`);
    }
  });
});
