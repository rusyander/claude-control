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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { registerConfigPreviewRoutes } from '../config-preview-routes.ts';
import { registerScriptRoutes } from '../script-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия «Хуки, переменные, инструкции, скрипты» на настоящих маршрутах окна и
 * ВРЕМЕННОМ каталоге конфигурации. Доказательство — байты файлов на диске после
 * решения человека, а не ответ действия.
 */
const ORIGIN = 'http://localhost:8888';

const SETTINGS = {
  env: { PLAIN: 'one', GITLAB_TOKEN: 'glpat-SECRET-EXISTING' },
  permissions: { allow: ['Read'], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }],
  },
};

describe('panel-agent actions: hooks, env, instructions, scripts', () => {
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
  const settings = () =>
    JSON.parse(readFileSync(paths().settings, 'utf8')) as {
      env?: Record<string, string>;
      permissions?: { allow?: string[] };
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-hooks-env-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(paths().hooks, { recursive: true });
    mkdirSync(join(root, 'skills', 'review'), { recursive: true });
    writeFileSync(paths().settings, `${JSON.stringify(SETTINGS, null, 2)}\n`);
    writeFileSync(paths().claudeMd, '# Правила\n\nКлюч sk-ant-SECRET-IN-MD не показывать.\n');
    writeFileSync(
      paths().mcpConfig,
      `${JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example.com/mcp' } } }, null, 2)}\n`,
    );
    writeFileSync(join(paths().hooks, 'guard.mjs'), 'console.log("guard");\n');
    writeFileSync(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Code review\n---\n\n# Review\n',
    );
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
    registerConfigPreviewRoutes(app, ctx);
    registerScriptRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
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
      payload: { input, conversationId: 'conv-he' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = await listPending();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (
    name: string,
    input: unknown,
    beforeDecision?: () => void,
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const running = call(name, input);
    const card = await waitPending();
    beforeDecision?.();
    const decision = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(200);
    return { card, result: (await running).json<PanelActionResult>() };
  };

  const hookCommands = (): string[] =>
    Object.values(settings().hooks ?? {}).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );

  it('save_hook: карточка с диффом settings.json, после «да» хук в файле', async () => {
    const { card, result } = await decided('save_hook', {
      event: 'PostToolUse',
      matchers: ['Edit'],
      command: 'node format.mjs',
    });
    expect(card.preview.diff).toContain('node format.mjs');
    expect(result).toMatchObject({ outcome: 'done', page: { route: '/hooks' } });
    expect(hookCommands()).toEqual(expect.arrayContaining(['node guard.mjs', 'node format.mjs']));
    expect(settings().hooks?.PostToolUse?.[0]?.matcher).toBe('Edit');
  });

  it('save_hook: id хука — от содержимого, экран фокусирует id ПОСЛЕ записи', async () => {
    const listHooks = async (): Promise<Array<{ id: string; command: string }>> =>
      (await app.inject({ method: 'GET', url: '/api/hooks' })).json();

    const added = await decided('save_hook', {
      event: 'PostToolUse',
      matchers: ['Edit'],
      command: 'node format.mjs',
    });
    const fresh = (await listHooks()).find((hook) => hook.command === 'node format.mjs');
    expect(fresh).toBeDefined();
    expect(added.result.page).toEqual({ route: '/hooks', focus: fresh!.id });
    expect(added.result.result).toMatchObject({ id: fresh!.id });

    // Правка команды меняет id: фокус на прежнем указывал бы на хук, которого нет.
    const edited = await decided('save_hook', {
      id: fresh!.id,
      event: 'PostToolUse',
      matchers: ['Edit'],
      command: 'node format.mjs --fix',
    });
    const moved = (await listHooks()).find((hook) => hook.command === 'node format.mjs --fix');
    expect(moved).toBeDefined();
    expect(moved!.id).not.toBe(fresh!.id);
    expect(edited.result.page).toEqual({ route: '/hooks', focus: moved!.id });
  });

  it('[P1] save_hook: правка одной команды не теряет timeout и matcher хука', async () => {
    const added = await decided('save_hook', {
      event: 'PreToolUse',
      matchers: ['Bash', 'Write'],
      command: 'node probe.mjs',
      timeout: 30,
    });
    const id = (added.result.result as { id: string }).id;
    // Модель узнаёт таймаут только из списка — без него сохранить его нечем.
    const listed = (await call('list_hooks', {})).json<PanelActionResult>().result as {
      hooks: Array<{ id: string; timeout?: number }>;
    };
    expect(listed.hooks.find((hook) => hook.id === id)?.timeout).toBe(30);

    const edited = await decided('save_hook', {
      id,
      event: 'PreToolUse',
      command: 'node probe.mjs --v2',
    });
    expect(edited.result.outcome).toBe('done');
    const group = settings().hooks?.PreToolUse?.find((item) =>
      item.hooks.some((hook) => hook.command === 'node probe.mjs --v2'),
    ) as { matcher?: string; hooks: Array<{ command: string; timeout?: number }> } | undefined;
    expect(group?.matcher).toBe('Bash|Write');
    expect(group?.hooks[0]?.timeout).toBe(30);
    expect(edited.card.preview.diff).not.toMatch(/^-\s*"timeout"/m);
  });

  it('save_hook с литералом секрета — отказ без карточки, файл не тронут', async () => {
    const before = readFileSync(paths().settings, 'utf8');
    const result = (
      await call('save_hook', {
        event: 'PreToolUse',
        command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 node x.mjs',
      })
    ).json<PanelActionResult>();
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('${VAR}');
    expect(await listPending()).toEqual([]);
    expect(readFileSync(paths().settings, 'utf8')).toBe(before);
  });

  it('toggle_hook выключает, delete_hook удаляет с копией', async () => {
    const hooks = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      Array<{ id: string; command: string }>
    >();
    const guard = hooks.find((hook) => hook.command === 'node guard.mjs');
    expect(guard).toBeDefined();

    const off = await decided('toggle_hook', { id: guard!.id, isEnabled: false });
    expect(off.result.outcome).toBe('done');
    expect(hookCommands()).not.toContain('node guard.mjs');
    const listed = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      Array<{ id: string; isEnabled: boolean }>
    >();
    expect(listed.find((hook) => hook.id === guard!.id)?.isEnabled).toBe(false);

    const on = await decided('toggle_hook', { id: guard!.id, isEnabled: true });
    expect(on.result.outcome).toBe('done');
    expect(hookCommands()).toContain('node guard.mjs');

    const removed = await decided('delete_hook', { id: guard!.id });
    expect(removed.result.outcome).toBe('done');
    expect(hookCommands()).not.toContain('node guard.mjs');
    expect(existsSync(join(appData, 'backups'))).toBe(true);
    expect(readdirSync(join(appData, 'backups')).length).toBeGreaterThan(0);
  });

  // [P1] Выключенный хук живёт снимком в панели, settings.json его уже не содержит:
  // дифф пуст, и карточка падала «Nothing would change» — выключенный хук агент
  // удалить не мог вовсе. Карточка обязана сказать, что стирается снимок.
  it('[P1] delete_hook удаляет и выключенный хук: карточка с заметкой, снимок стёрт', async () => {
    const hooks = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      Array<{ id: string; command: string }>
    >();
    const guard = hooks.find((hook) => hook.command === 'node guard.mjs');
    expect((await decided('toggle_hook', { id: guard!.id, isEnabled: false })).result.outcome).toBe(
      'done',
    );

    const removed = await decided('delete_hook', { id: guard!.id });
    expect(removed.result.outcome).toBe('done');
    expect(JSON.stringify(removed.card.preview.fields)).toContain('note-hook-delete-disabled');
    const after = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      Array<{ id: string }>
    >();
    expect(after.find((hook) => hook.id === guard!.id)).toBeUndefined();
  });

  it('устаревшая карточка: файл правили между показом и «да» — ничего не записано', async () => {
    const { result } = await decided(
      'save_hook',
      { event: 'Stop', command: 'node stop.mjs' },
      () => {
        const edited = settings();
        edited.env = { ...edited.env, HAND_EDIT: '1' };
        writeFileSync(paths().settings, `${JSON.stringify(edited, null, 2)}\n`);
      },
    );
    expect(result.messageCode).toBe('stale_preview');
    expect(hookCommands()).not.toContain('node stop.mjs');
    expect(settings().env?.HAND_EDIT).toBe('1');
  });

  it('list_env маскирует секрет; set_env пишет обычную переменную', async () => {
    const list = (await call('list_env', {})).json<PanelActionResult>();
    expect(list.outcome).toBe('done');
    expect(JSON.stringify(list.result)).not.toContain('SECRET');
    expect(JSON.stringify(list.result)).toContain('PLAIN');

    const { card, result } = await decided('set_env', { key: 'MY_FLAG', value: 'on' });
    expect(card.preview.diff).toContain('MY_FLAG');
    expect(result).toMatchObject({
      outcome: 'done',
      page: { route: '/env', focus: 'settings:MY_FLAG' },
    });
    expect(settings().env?.MY_FLAG).toBe('on');
  });

  // Секрет по имени решает то же правило, что и раздел «Переменные»: слово
  // целиком. Подстрочное правило отказывало в MAX_THINKING_TOKENS=31999 и
  // помечало его секретом, хотя экран показывает его открыто.
  it('set_env: MAX_THINKING_TOKENS — обычная переменная, как на экране «Переменные»', async () => {
    const { result } = await decided('set_env', { key: 'MAX_THINKING_TOKENS', value: '31999' });
    expect(result).toMatchObject({
      outcome: 'done',
      page: { route: '/env', focus: 'settings:MAX_THINKING_TOKENS' },
    });
    expect(settings().env?.MAX_THINKING_TOKENS).toBe('31999');
  });

  it('set_env секрета: значение от агента — отказ; пустое — поле человеку, существующий не затирается', async () => {
    const withValue = (
      await call('set_env', { key: 'NEW_API_TOKEN', value: 'abc' })
    ).json<PanelActionResult>();
    expect(withValue.outcome).toBe('failed');
    expect(await listPending()).toEqual([]);

    const empty = await decided('set_env', { key: 'NEW_API_TOKEN', value: '' });
    expect(empty.result).toMatchObject({
      outcome: 'needs-secret',
      page: { route: '/env', focus: 'env-secret:NEW_API_TOKEN' },
    });

    const before = readFileSync(paths().settings, 'utf8');
    const existing = (
      await call('set_env', { key: 'GITLAB_TOKEN', value: '' })
    ).json<PanelActionResult>();
    expect(existing.outcome).toBe('failed');
    expect(existing.message).toContain('GITLAB_TOKEN');
    expect(readFileSync(paths().settings, 'utf8')).toBe(before);
  });

  it('delete_env удаляет ключ из своего источника', async () => {
    const { result } = await decided('delete_env', { key: 'PLAIN', source: 'settings' });
    expect(result.outcome).toBe('done');
    expect(settings().env?.PLAIN).toBeUndefined();
    expect(settings().env?.GITLAB_TOKEN).toBe('glpat-SECRET-EXISTING');
  });

  it('read_claude_md маскирует ключ; save_claude_md пишет файл целиком после «да»', async () => {
    const read = (await call('read_claude_md', {})).json<PanelActionResult>();
    expect(read.outcome).toBe('done');
    expect(JSON.stringify(read.result)).not.toContain('SECRET-IN-MD');
    expect(JSON.stringify(read.result)).toContain('Правила');

    const content = '# Правила\n\nОтвечать кратко.\n';
    const { card, result } = await decided('save_claude_md', { content });
    expect(card.risk).toBe('danger');
    expect(card.preview.diff).toContain('Отвечать кратко.');
    expect(result.outcome).toBe('done');
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(content);
  });

  // Модель читает файлы маской и сохраняет целиком: маска не должна лечь на место
  // секрета — карточка маскирует обе стороны diff, и человек разницы не увидит.
  it('правка прочитанного маской: секреты возвращаются с диска, чужие маски — отказ', async () => {
    const read = (await call('read_claude_md', {})).json<PanelActionResult>();
    const masked = (read.result as { text: string }).text;
    expect(masked).toContain('••••••');
    const edited = `${masked}Отвечать кратко.\n`;
    const saved = await decided('save_claude_md', { content: edited });
    expect(saved.result.outcome).toBe('done');
    expect(readFileSync(paths().claudeMd, 'utf8')).toContain('sk-ant-SECRET-IN-MD');
    expect(readFileSync(paths().claudeMd, 'utf8')).toContain('Отвечать кратко.');

    const extra = (
      await call('save_claude_md', { content: `${edited}ЕЩЁ_TOKEN=••••••\n` })
    ).json<PanelActionResult>();
    expect(extra.outcome).toBe('failed');
    expect(extra.message).toContain('••••••');

    const script = join(paths().hooks, 'deploy.sh');
    writeFileSync(script, `export API_TOKEN=${'VALUE'}9f8e7d6c5b4a3f2e1d0c\necho 1\n`);
    const readScript = (await call('read_script', { id: 'deploy.sh' })).json<PanelActionResult>();
    const scriptText = (readScript.result as { text: string }).text;
    expect(scriptText).not.toContain('9f8e7d6c');
    const replaced = await decided('save_script', {
      id: 'deploy.sh',
      content: scriptText.replace('echo 1', 'echo 2'),
    });
    expect(replaced.result.outcome).toBe('done');
    expect(readFileSync(script, 'utf8')).toBe(
      `export API_TOKEN=${'VALUE'}9f8e7d6c5b4a3f2e1d0c\necho 2\n`,
    );

    const withToken = settings();
    withToken.hooks!.PreToolUse![0]!.hooks[0]!.command = `API_TOKEN=${'VALUE'}9f8e7d6c5b4a3f2e1d0c node guard.mjs`;
    writeFileSync(paths().settings, `${JSON.stringify(withToken, null, 2)}\n`);
    const hooks = (await call('list_hooks', {})).json<PanelActionResult>().result as {
      hooks: Array<{ id: string; event: string; command: string }>;
    };
    const guard = hooks.hooks.find((hook) => hook.command.includes('guard.mjs'))!;
    expect(guard.command).toContain('••••••');
    const hook = await decided('save_hook', {
      id: guard.id,
      event: 'PreToolUse',
      matchers: ['Bash', 'Edit'],
      command: guard.command,
    });
    expect(hook.result.outcome).toBe('done');
    expect(JSON.stringify(settings().hooks)).toContain('9f8e7d6c5b4a3f2e1d0c node guard.mjs');
    // F-294: команда пришла маской, matcher сменился — id хука новый, и фокус
    // обязан указать на него, а не на прежний id, которого больше нет.
    const after = (await app.inject({ method: 'GET', url: '/api/hooks' })).json<
      Array<{ id: string; command: string }>
    >();
    const rewritten = after.find((item) => item.command.includes('guard.mjs'));
    expect(rewritten?.id).not.toBe(guard.id);
    expect(hook.result.page).toEqual({ route: '/hooks', focus: rewritten!.id });
  });

  it('скрипты: создать, прочитать, заменить, удалить; команды и переключатель скилла', async () => {
    const created = await decided('save_script', {
      id: 'sub/check.mjs',
      content: 'console.log(1);\n',
    });
    expect(created.card.preview.summary).toContain('sub/check.mjs');
    expect(created.result.outcome).toBe('done');
    expect(readFileSync(join(paths().hooks, 'sub', 'check.mjs'), 'utf8')).toBe('console.log(1);\n');

    const list = (await call('list_scripts', {})).json<PanelActionResult>();
    const ids = (list.result as { scripts: Array<{ id: string }> }).scripts.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['guard.mjs', 'sub/check.mjs']));
    const read = (await call('read_script', { id: 'sub/check.mjs' })).json<PanelActionResult>();
    expect(JSON.stringify(read.result)).toContain('console.log(1);');

    const replaced = await decided('save_script', {
      id: 'sub/check.mjs',
      content: 'console.log(2);\n',
    });
    expect(replaced.result.outcome).toBe('done');
    expect(readFileSync(join(paths().hooks, 'sub', 'check.mjs'), 'utf8')).toBe('console.log(2);\n');

    const removed = await decided('delete_script', { id: 'sub/check.mjs' });
    expect(removed.result.outcome).toBe('done');
    expect(existsSync(join(paths().hooks, 'sub', 'check.mjs'))).toBe(false);

    const commands = (await call('list_commands', {})).json<PanelActionResult>();
    expect(commands.outcome).toBe('done');
    expect((commands.result as { commands: Array<{ invocation: string }> }).commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ invocation: '/review' })]),
    );

    const skill = await decided('toggle_skill', { id: 'review', isEnabled: false });
    expect(skill.result.outcome).toBe('done');
    const skills = (await app.inject({ method: 'GET', url: '/api/skills' })).json<
      Array<{ id: string; isEnabled: boolean }>
    >();
    expect(skills.find((item) => item.id === 'review')?.isEnabled).toBe(false);
  });
  // Описание резалось ДО маски: токен на границе среза детектор уже не узнавал, и
  // его префикс уходил модели открытым (18 из 20 символов `ghp_…`).
  it('list_scripts: токен на границе среза описания не уходит модели', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    for (let lead = 220; lead <= 238; lead += 3) {
      const about = `// ${'x'.repeat(lead)} ${token} tail\n`;
      writeFileSync(join(paths().hooks, `cut-${lead}.mjs`), about);
    }
    const answer = (await call('list_scripts', {})).json<PanelActionResult>();
    const scripts = (answer.result as { scripts: Array<{ id: string; description?: string }> })
      .scripts;
    const cut = scripts.filter((item) => item.id.startsWith('cut-'));
    expect(cut).toHaveLength(7);
    for (const item of cut) expect(item.description ?? '').not.toContain('ghp_');
  });

  it('[P1] list_scripts: длинный список — страницы в пределе моста, хвост достижим', async () => {
    const about = `// ${'Проверяет правку и пишет след в журнал. '.repeat(15)}\n`;
    for (let index = 0; index < 90; index += 1) {
      writeFileSync(join(paths().hooks, `probe-${String(index).padStart(2, '0')}.mjs`), about);
    }
    type Page = {
      total: number;
      nextOffset?: number;
      scripts: Array<{ id: string; description?: string }>;
    };
    const page = async (offset?: number): Promise<Page> => {
      const answer = (
        await call('list_scripts', offset === undefined ? {} : { offset })
      ).json<PanelActionResult>();
      expect(answer.outcome).toBe('done');
      // Переходник режет ответ на 20 000 символах JSON: страница обязана влезать.
      expect(JSON.stringify(answer.result).length).toBeLessThan(20_000);
      return answer.result as Page;
    };
    const first = await page();
    expect(first.total).toBe(91);
    const seen = new Set(first.scripts.map((item) => item.id));
    for (let next = first.nextOffset; next !== undefined;) {
      const more = await page(next);
      for (const item of more.scripts) seen.add(item.id);
      next = more.nextOffset;
    }
    expect(seen.size).toBe(91);
    expect(seen.has('probe-89.mjs')).toBe(true);
  });

  it('toggle_mcp_server и toggle_permission_rule: выключенное уходит из файла и возвращается', async () => {
    const mcpFile = () =>
      JSON.parse(readFileSync(paths().mcpConfig, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
        mcpServersDisabled?: Record<string, unknown>;
      };
    const off = await decided('toggle_mcp_server', { id: 'docs', isEnabled: false });
    expect(off.result.outcome).toBe('done');
    // Выключенный сервер панель держит рядом, в mcpServersDisabled — CLI его не видит.
    expect(mcpFile().mcpServers?.docs).toBeUndefined();
    expect(mcpFile().mcpServersDisabled?.docs).toBeDefined();
    const on = await decided('toggle_mcp_server', { id: 'docs', isEnabled: true });
    expect(on.result.outcome).toBe('done');
    expect(mcpFile().mcpServers?.docs).toMatchObject({ url: 'https://docs.example.com/mcp' });

    const rule = await decided('toggle_permission_rule', { id: 'allow:Read', isEnabled: false });
    expect(rule.result).toMatchObject({
      outcome: 'done',
      page: { route: '/permissions', focus: 'allow:Read' },
    });
    expect(settings().permissions?.allow ?? []).not.toContain('Read');
    const back = await decided('toggle_permission_rule', { id: 'allow:Read', isEnabled: true });
    expect(back.result.outcome).toBe('done');
    expect(settings().permissions?.allow).toContain('Read');
  });
});
