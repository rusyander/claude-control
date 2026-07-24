import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Project, ProviderProjectInfo, UniversalMcpServer } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderProjectRoutes } from './provider-project-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';

/**
 * Проектный уровень НЕ-Claude провайдеров (COMMON-2).
 *
 * Проверяем на ВРЕМЕННЫХ каталогах: реальные каталоги пользователя не трогаются
 * вовсе — проектные пути строятся от корня проекта, а он здесь в tmp.
 * Смотрим главное: правильные пути у каждого провайдера, round-trip чтения и
 * записи (чужие ключи и комментарии целы), безопасность путей, fail-closed у
 * провайдеров без проектного уровня и неизменность ветки Claude.
 */
describe('provider-project-routes: проектный уровень провайдера', () => {
  let appDataRoot: string;
  let projectDir: string;
  let app: FastifyInstance;
  let store: AppStore;

  const boot = async (provider: string): Promise<string> => {
    store = new AppStore(appDataRoot);
    if (provider !== 'claude') store.updateSettings({ provider });

    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProjectRoutes(app, ctx);
    registerProviderProjectRoutes(app, ctx);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { path: projectDir },
    });
    // Реестр проектов — раздел самой панели: он работает при любом провайдере.
    expect(res.statusCode).toBe(200);
    return res.json<Project>().id;
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-project-'));
  });

  afterEach(async () => {
    await app?.close();
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('пути проектных файлов резолвятся по провайдеру', async () => {
    const expected: Record<string, { instructions?: string; mcp: string[]; sections: string[] }> = {
      codex: {
        instructions: 'AGENTS.md',
        mcp: ['.codex', 'config.toml'],
        sections: ['instructions', 'mcp'],
      },
      // GEMINI-2/3: у Gemini к инструкциям и MCP добавились проектные .env и права.
      gemini: {
        instructions: 'GEMINI.md',
        mcp: ['.gemini', 'settings.json'],
        sections: ['instructions', 'mcp', 'env', 'permissions'],
      },
      // OPENCODE-1/3/4: права и хуки проекта — ключи того же opencode.json,
      // плагины — ещё и каталог `.opencode/plugins`.
      opencode: {
        instructions: 'AGENTS.md',
        mcp: ['opencode.json'],
        sections: ['instructions', 'mcp', 'permissions', 'hooks', 'plugins', 'skills'],
      },
      // CURSOR-1: у Cursor вместо файла инструкций — КАТАЛОГ правил `.mdc`.
      cursor: { mcp: ['.cursor', 'mcp.json'], sections: ['instructionsRules', 'mcp'] },
    };

    for (const [provider, paths] of Object.entries(expected)) {
      const id = await boot(provider);
      const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider` });
      expect(res.statusCode, provider).toBe(200);

      const info = res.json<ProviderProjectInfo>();
      expect(info.providerId, provider).toBe(provider);
      expect(info.projectPath, provider).toBe(projectDir);
      expect(info.mcpPath, provider).toBe(join(projectDir, ...paths.mcp));
      expect(info.sections, provider).toEqual(paths.sections);
      if (paths.instructions) {
        expect(info.instructionsPath, provider).toBe(join(projectDir, paths.instructions));
      } else {
        // Cursor: проектные правила — КАТАЛОГ .mdc (CURSOR-1), файла инструкций
        // у него не бывает, зато есть путь каталога правил.
        expect(info.instructionsPath, provider).toBeUndefined();
        expect(info.instructionsRulesDir, provider).toBe(join(projectDir, '.cursor', 'rules'));
        expect(info.instructionsRulesFormat, provider).toBe('cursor-mdc');
      }

      await app.close();
      rmSync(join(appDataRoot, 'state.json'), { force: true });
    }
  });

  it('gemini: инструкции проекта — round-trip GEMINI.md, файла раньше не было', async () => {
    const id = await boot('gemini');

    const before = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/instructions`,
    });
    expect(before.json<{ exists: boolean; fileName: string }>()).toMatchObject({
      exists: false,
      fileName: 'GEMINI.md',
      content: '',
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/instructions`,
      payload: { content: '# Проектные правила\n' },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toBe('# Проектные правила\n');

    const after = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/instructions`,
    });
    expect(after.json<{ exists: boolean; content: string }>()).toMatchObject({
      exists: true,
      content: '# Проектные правила\n',
    });
  });

  it('gemini: MCP проекта правит только mcpServers в .gemini/settings.json', async () => {
    const id = await boot('gemini');
    const file = join(projectDir, '.gemini', 'settings.json');
    mkdirSync(join(projectDir, '.gemini'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', mcpServers: { old: { command: 'node' } } }, null, 2),
      'utf8',
    );

    const post = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/provider/mcp`,
      payload: { name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'] },
    });
    expect(post.statusCode).toBe(200);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    // Чужой ключ файла цел, прежний сервер на месте, новый добавлен.
    expect(raw.theme).toBe('dark');
    expect(Object.keys(raw.mcpServers).sort()).toEqual(['ctx7', 'old']);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/mcp` });
    expect(list.json<{ servers: UniversalMcpServer[] }>().servers.map((s) => s.name)).toEqual([
      'ctx7',
      'old',
    ]);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/provider/mcp/ctx7`,
    });
    expect(del.statusCode).toBe(200);
    const afterDelete = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(afterDelete.mcpServers)).toEqual(['old']);
  });

  // GEMINI-3: проектный `.gemini/.env` — тот же построчный адаптер, что и у
  // глобального раздела; копия отделена префиксом `-project-`.
  it('gemini: env проекта правит .gemini/.env построчно, комментарии целы', async () => {
    const id = await boot('gemini');
    const file = join(projectDir, '.gemini', '.env');
    mkdirSync(join(projectDir, '.gemini'), { recursive: true });
    writeFileSync(file, '# проектные ключи\nA=1\n', 'utf8');

    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/env` });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ format: string }>().format).toBe('dotenv');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/env`,
      payload: {
        vars: [
          { key: 'A', value: '2' },
          { key: 'B', value: 'x y' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('# проектные ключи\nA=2\nB="x y"\n');
  });

  // GEMINI-2: проектный `.gemini/settings.json` — те же три ключа, `yolo`
  // отклоняется и здесь, а MCP-серверы проекта остаются нетронутыми.
  it('gemini: права проекта пишут три ключа; yolo → 400, mcpServers цел', async () => {
    const id = await boot('gemini');
    const file = join(projectDir, '.gemini', 'settings.json');
    mkdirSync(join(projectDir, '.gemini'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ theme: 'dark', mcpServers: { old: { command: 'node' } } }, null, 2),
      'utf8',
    );

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/permissions`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ kind: string; usingDefaults: boolean }>()).toMatchObject({
      kind: 'gemini',
      usingDefaults: true,
    });

    const yolo = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/permissions`,
      payload: { approvalMode: 'yolo', coreTools: [], excludeTools: [] },
    });
    expect(yolo.statusCode).toBe(400);
    expect(yolo.json<{ error: string }>().error).toBe('mode_cli_only');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/permissions`,
      payload: { approvalMode: 'plan', coreTools: ['ReadFile'], excludeTools: [] },
    });
    expect(put.statusCode).toBe(200);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.theme).toBe('dark');
    expect(raw.mcpServers).toEqual({ old: { command: 'node' } });
    expect(raw.general).toEqual({ defaultApprovalMode: 'plan' });
    expect(raw.coreTools).toEqual(['ReadFile']);
  });

  // OPENCODE-1: проектные права OpenCode — ключ `permission` в `<проект>/opencode.json`.
  it('opencode: проектные права правят только permission, MCP и модель целы', async () => {
    const id = await boot('opencode');
    const file = join(projectDir, 'opencode.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-sonnet-4',
          mcp: { probe: { type: 'local', command: ['node', 'x.js'] } },
          permission: { edit: 'deny', deploy: 'ask' },
        },
        null,
        2,
      ),
      'utf8',
    );

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/permissions`,
    });
    expect(get.statusCode).toBe(200);
    const info = get.json<{
      kind: string;
      filePath: string;
      entries: { tool: string; level?: string }[];
      preserved: { key: string }[];
    }>();
    expect(info.kind).toBe('opencode');
    expect(info.filePath).toBe(file);
    expect(info.entries).toEqual([{ tool: 'edit', mode: 'level', level: 'deny' }]);
    expect(info.preserved).toEqual([{ key: 'deploy', value: '"ask"' }]);

    // Чужая модель черновика (gemini) в файл OpenCode не проходит.
    const wrong = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/permissions`,
      payload: { approvalMode: 'plan', coreTools: [], excludeTools: [] },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>().error).toBe('invalid_draft');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/permissions`,
      payload: {
        entries: [
          {
            tool: 'bash',
            mode: 'patterns',
            patterns: [
              { pattern: '*', level: 'ask' },
              { pattern: 'git push *', level: 'deny' },
            ],
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.model).toBe('anthropic/claude-sonnet-4');
    expect(raw.mcp).toEqual({ probe: { type: 'local', command: ['node', 'x.js'] } });
    expect(raw.permission).toEqual({
      // `edit` в черновике не было → ключ снят; незнакомый `deploy` сохранён.
      deploy: 'ask',
      bash: { '*': 'ask', 'git push *': 'deny' },
    });

    // Копия проекта отделена от глобальной ротации префиксом `-project-`.
    expect(
      readdirSync(join(appDataRoot, 'backups')).some((name) =>
        name.startsWith('opencode-project-opencode.json'),
      ),
    ).toBe(true);
  });

  it('opencode: битый проектный opencode.json → readOnly на чтении и 422 на записи', async () => {
    const id = await boot('opencode');
    const file = join(projectDir, 'opencode.json');
    const broken = '{ "permission": { "edit": ';
    writeFileSync(file, broken, 'utf8');

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/permissions`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ readOnly: boolean }>().readOnly).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/permissions`,
      payload: { entries: [{ tool: 'edit', mode: 'level', level: 'ask' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('opencode: проектные env → 400 (OPENCODE-2: хранить переменные негде)', async () => {
    const id = await boot('opencode');
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/env` });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('section_unsupported');
  });

  // У прочих провайдеров проектных env/прав НЕТ — раздел fail-closed.
  it('codex: проектные env и права → 400 section_unsupported', async () => {
    const id = await boot('codex');
    for (const section of ['env', 'permissions']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${id}/provider/${section}`,
      });
      expect(res.statusCode, section).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  it('codex: проектный config.toml правится хирургически — комментарии и чужие ключи целы', async () => {
    const id = await boot('codex');
    const file = join(projectDir, '.codex', 'config.toml');
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(file, '# комментарий пользователя\r\nmodel = "o3"\r\n', 'utf8');

    const post = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/provider/mcp`,
      payload: { name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'] },
    });
    expect(post.statusCode).toBe(200);

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# комментарий пользователя');
    expect(text).toContain('model = "o3"');
    expect(text).toContain('[mcp_servers.ctx7]');
    // Стиль переводов строк исходника сохранён (хирургическая правка).
    expect(text).toContain('\r\n');

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/mcp` });
    const servers = list.json<{ servers: UniversalMcpServer[] }>().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'ctx7', command: 'npx', args: ['-y', 'ctx7'] });
  });

  it('opencode: проектный opencode.json — ключ mcp, чужие поля сервера сохраняются', async () => {
    const id = await boot('opencode');
    const file = join(projectDir, 'opencode.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: { ctx7: { type: 'local', enabled: false } },
        },
        null,
        2,
      ),
      'utf8',
    );

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/mcp/ctx7`,
      payload: { name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'] },
    });
    expect(put.statusCode).toBe(200);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      $schema: string;
      mcp: { ctx7: { type: string; command: string[]; enabled: boolean } };
    };
    expect(raw.$schema).toBe('https://opencode.ai/config.json');
    expect(raw.mcp.ctx7.command).toEqual(['npx', '-y', 'ctx7']);
    // Немоделируемое поле не потеряно при round-trip.
    expect(raw.mcp.ctx7.enabled).toBe(false);
  });

  it('cursor: проектный MCP есть, проектных инструкций нет → 400', async () => {
    const id = await boot('cursor');

    const post = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/provider/mcp`,
      payload: { name: 'remote', transport: 'http', url: 'https://example.com/mcp' },
    });
    expect(post.statusCode).toBe(200);
    const raw = JSON.parse(readFileSync(join(projectDir, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { remote: { url: string } };
    };
    // У Cursor адрес удалённого сервера пишется в `url` (не httpUrl).
    expect(raw.mcpServers.remote.url).toBe('https://example.com/mcp');

    const instructions = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/instructions`,
    });
    expect(instructions.statusCode).toBe(400);
    expect(instructions.json<{ error: string }>().error).toBe('section_unsupported');
  });

  it('claude в этот раздел не ходит вовсе → 400 section_unsupported', async () => {
    const id = await boot('claude');
    for (const url of [
      `/api/projects/${id}/provider`,
      `/api/projects/${id}/provider/instructions`,
      `/api/projects/${id}/provider/instructions-list`,
      `/api/projects/${id}/provider/mcp`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `claude ${url}`).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  // AIDER-4: у Aider проектный уровень есть, но состав другой — список ссылок
  // `read` + `set-env`; однофайловых инструкций и MCP у него нет вовсе.
  it('aider: проектные разделы — instructionsList + env, а instructions/mcp → 400', async () => {
    const id = await boot('aider');
    const info = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider` });
    expect(info.statusCode).toBe(200);
    expect(info.json<{ sections: string[] }>().sections).toEqual(['instructionsList', 'env']);

    for (const url of [
      `/api/projects/${id}/provider/instructions`,
      `/api/projects/${id}/provider/mcp`,
      `/api/projects/${id}/provider/permissions`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `aider ${url}`).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
  });

  it('неизвестный проект → 404; исчезнувший каталог → 400 invalid_project', async () => {
    const id = await boot('codex');

    const missing = await app.inject({ method: 'GET', url: '/api/projects/нет-такого/provider' });
    expect(missing.statusCode).toBe(404);

    rmSync(projectDir, { recursive: true, force: true });
    const gone = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider` });
    expect(gone.statusCode).toBe(400);
    expect(gone.json<{ error: string }>().error).toBe('invalid_project');
    // Ничего не создано взамен удалённого каталога.
    expect(existsSync(projectDir)).toBe(false);
  });

  it('нестроковый content не затирает файл инструкций', async () => {
    const id = await boot('codex');
    writeFileSync(join(projectDir, 'AGENTS.md'), 'исходный текст\n', 'utf8');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/instructions`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toBe('исходный текст\n');
  });

  // --- OPENCODE-3/4: хуки и плагины проекта -----------------------------------

  it('opencode: хуки проекта round-trip в <проект>/opencode.json, чужие ключи целы', async () => {
    const id = await boot('opencode');
    const file = join(projectDir, 'opencode.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: { edit: 'deny' },
          experimental: { policies: [{ effect: 'deny' }], hook: { tool_called: [{ x: 1 }] } },
        },
        null,
        2,
      ),
    );

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/hooks`,
      payload: {
        fileEdited: [{ pattern: '*.ts', actions: [{ command: ['prettier', '--write'] }] }],
        sessionCompleted: [],
      },
    });
    expect(put.statusCode).toBe(200);

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(written.$schema).toBe('https://opencode.ai/config.json');
    expect(written.permission).toEqual({ edit: 'deny' });
    const experimental = written.experimental as Record<string, unknown>;
    // Чужой ключ `experimental` и незнакомое событие целы.
    expect(experimental.policies).toEqual([{ effect: 'deny' }]);
    expect(experimental.hook).toEqual({
      tool_called: [{ x: 1 }],
      file_edited: { '*.ts': [{ command: ['prettier', '--write'] }] },
    });

    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/hooks` });
    expect(get.statusCode).toBe(200);
    const info = get.json<{
      scope: string;
      fileEdited: unknown[];
      preservedEvents: { key: string }[];
    }>();
    expect(info.scope).toBe('project');
    expect(info.fileEdited).toEqual([
      { pattern: '*.ts', actions: [{ command: ['prettier', '--write'] }] },
    ]);
    expect(info.preservedEvents.map((entry) => entry.key)).toEqual(['tool_called']);

    // Резервная копия проекта отделена от глобальной префиксом `-project-`.
    const backups = readdirSync(join(appDataRoot, 'backups'));
    expect(backups.some((name) => name.startsWith('opencode-project-opencode.json'))).toBe(true);
  });

  it('opencode: плагины проекта — каталог .opencode/plugins и ключ plugin', async () => {
    const id = await boot('opencode');

    const info = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/plugins` });
    expect(info.statusCode).toBe(200);
    const body = info.json<{ pluginsDir: string; configPath: string; dirExists: boolean }>();
    expect(body.pluginsDir).toBe(join(projectDir, '.opencode', 'plugins'));
    expect(body.configPath).toBe(join(projectDir, 'opencode.json'));
    // Каталог создаётся только при явном сохранении файла.
    expect(body.dirExists).toBe(false);

    const created = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/plugins/file`,
      payload: { path: 'notify.ts', content: 'export const plugin = () => {};\n' },
    });
    expect(created.statusCode).toBe(200);
    expect(readFileSync(join(projectDir, '.opencode', 'plugins', 'notify.ts'), 'utf8')).toBe(
      'export const plugin = () => {};\n',
    );

    const packages = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/plugins/packages`,
      payload: { packages: ['@org/p'] },
    });
    expect(packages.statusCode).toBe(200);
    expect(
      (JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8')) as { plugin: unknown })
        .plugin,
    ).toEqual(['@org/p']);
  });

  it('проектный уровень: защита путей плагинов та же — 400 unsafe_path, не 404', async () => {
    const id = await boot('opencode');
    // Файл за пределами проекта: существует, но панель о нём не сообщает.
    const outside = join(appDataRoot, 'outside.ts');
    writeFileSync(outside, 'secret');

    for (const path of ['../outside.ts', '../../outside.ts', '/etc/evil.ts', 'note.md']) {
      const encoded = encodeURIComponent(path);
      for (const request of [
        {
          method: 'GET' as const,
          url: `/api/projects/${id}/provider/plugins/file?path=${encoded}`,
        },
        {
          method: 'DELETE' as const,
          url: `/api/projects/${id}/provider/plugins/file?path=${encoded}`,
        },
      ]) {
        const res = await app.inject(request);
        expect(res.statusCode, `${request.method} ${path}`).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('unsafe_path');
      }

      const write = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/provider/plugins/file`,
        payload: { path, content: 'x' },
      });
      expect(write.statusCode, `PUT ${path}`).toBe(400);
      expect(write.json<{ error: string }>().error).toBe('unsafe_path');
    }

    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(existsSync(join(projectDir, '.opencode'))).toBe(false);
  });

  it('opencode: скиллы проекта — каталог .opencode/skills, round-trip + удаление', async () => {
    const id = await boot('opencode');

    const info = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/skills` });
    expect(info.statusCode).toBe(200);
    const body = info.json<{ skillsDir: string; dirExists: boolean; externalDirs: unknown[] }>();
    expect(body.skillsDir).toBe(join(projectDir, '.opencode', 'skills'));
    // Каталог создаётся только при явном сохранении; в проекте прочих каталогов нет.
    expect(body.dirExists).toBe(false);
    expect(body.externalDirs).toEqual([]);

    const created = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/skills/skill`,
      payload: { path: 'demo/SKILL.md', name: 'demo', description: 'делает X', body: '# H\n' },
    });
    expect(created.statusCode).toBe(200);
    expect(readFileSync(join(projectDir, '.opencode', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: demo\ndescription: делает X\n---\n# H\n',
    );

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/provider/skills/skill?path=demo/SKILL.md`,
    });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(projectDir, '.opencode', 'skills', 'demo'))).toBe(false);
  });

  it('проектный уровень: защита путей скиллов та же — 400 unsafe_path, не 404', async () => {
    const id = await boot('opencode');
    const outside = join(appDataRoot, 'outside', 'SKILL.md');
    mkdirSync(join(appDataRoot, 'outside'), { recursive: true });
    writeFileSync(outside, 'secret');

    for (const path of ['../outside/SKILL.md', '/etc/SKILL.md', 'a/b/SKILL.md', 'x/README.md']) {
      const encoded = encodeURIComponent(path);
      const get = await app.inject({
        method: 'GET',
        url: `/api/projects/${id}/provider/skills/skill?path=${encoded}`,
      });
      expect(get.statusCode, `GET ${path}`).toBe(400);
      expect(get.json<{ error: string }>().error).toBe('unsafe_path');

      const write = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/provider/skills/skill`,
        payload: { path, name: 'x', description: 'd', body: '' },
      });
      expect(write.statusCode, `PUT ${path}`).toBe(400);
      expect(write.json<{ error: string }>().error).toBe('unsafe_path');
    }
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(existsSync(join(projectDir, '.opencode'))).toBe(false);
  });

  it('хуки, плагины и скиллы проекта закрыты у провайдеров без них (включая claude)', async () => {
    for (const provider of ['claude', 'codex', 'gemini', 'cursor', 'aider']) {
      const id = await boot(provider);
      for (const url of [
        `/api/projects/${id}/provider/hooks`,
        `/api/projects/${id}/provider/plugins`,
        `/api/projects/${id}/provider/skills`,
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${provider} ${url}`).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('section_unsupported');
      }
      await app.close();
      rmSync(join(appDataRoot, 'state.json'), { force: true });
    }
  });

  it('регресс-ноль Claude: его проектные роуты работают при claude и закрыты при codex', async () => {
    const id = await boot('claude');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/rules`,
      payload: { content: '# правила проекта\n' },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe('# правила проекта\n');

    const rules = await app.inject({ method: 'GET', url: `/api/projects/${id}/rules` });
    expect(rules.json<{ content: string }>().content).toBe('# правила проекта\n');

    // Провайдер сменился → проектные файлы Claude панель больше не трогает.
    store.updateSettings({ provider: 'codex' });
    const blocked = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/rules`,
      payload: { content: 'перезапись' },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toBe('section_unsupported');
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe('# правила проекта\n');
  });
});
