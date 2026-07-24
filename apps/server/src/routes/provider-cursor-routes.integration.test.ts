import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderRulesRoutes } from './provider-rules-routes.ts';
import { registerProviderInstructionsRoutes } from './provider-instructions-routes.ts';
import { registerProviderProjectRoutes } from './provider-project-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * CURSOR-1 на маршрутах: правила Cursor КАТАЛОГОМ `.mdc` — глобальные и проектные.
 *
 * HOME/USERPROFILE подменяются на временный каталог — настоящий `~` не читается
 * и не пишется. Покрыто: список с вложенными правилами и игнорируемыми файлами,
 * цикл создание→правка→удаление, безопасность путей на всех операциях, отказ по
 * нераспознанному frontmatter, проектный уровень и то, что при активном Claude
 * (и у провайдера с другой моделью инструкций) маршруты отвечают 400, а файлы
 * Cursor остаются нетронутыми.
 */
function makeCtx(root: string, provider: string): ServerContext {
  mkdirSync(join(root, 'claude-control'), { recursive: true });
  const store = new AppStore(join(root, 'claude-control'));
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData: join(root, 'claude-control') } },
    store,
    backupDir: join(root, 'claude-control', 'backups'),
  } as unknown as ServerContext;
}

const RULE = `---
# правило фронтенда
description: Правила React
globs: src/**/*.tsx
alwaysApply: false
owner: team-fe
---
# Компоненты

Только функциональные.
`;

interface RulesInfo {
  providerId: string;
  rulesDir: string;
  dirExists: boolean;
  readOnly: boolean;
  rules: {
    path: string;
    description?: string;
    globs?: string;
    alwaysApply?: boolean;
    frontmatterOk: boolean;
    problem?: string;
  }[];
  ignored: { path: string }[];
}

describe('cursor: каталог правил .mdc на tmp-HOME', () => {
  let home: string;
  let root: string;
  let projectDir: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let rulesDir: string;

  const boot = async (provider = 'cursor'): Promise<void> => {
    app = Fastify();
    const ctx = makeCtx(root, provider);
    registerProjectRoutes(app, ctx);
    registerEntityRoutes(app, ctx);
    registerProviderRulesRoutes(app, ctx);
    registerProviderInstructionsRoutes(app, ctx);
    registerProviderProjectRoutes(app, ctx);
    await app.ready();
  };

  /** Добавить каталог проекта в реестр и вернуть его id. */
  const addProject = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'проект', path: projectDir },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    return list.json<{ id: string }[]>()[0]!.id;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-home-cursor-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    rulesDir = join(home, '.cursor', 'rules');
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-routes-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-cursor-project-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    for (const dir of [home, root, projectDir]) rmSync(dir, { recursive: true, force: true });
  });

  // --- Глобальный каталог правил ---------------------------------------------

  it('GET отдаёт правила рекурсивно, поля frontmatter и игнорируемые файлы', async () => {
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    writeFileSync(join(rulesDir, 'base.mdc'), RULE, 'utf8');
    writeFileSync(
      join(rulesDir, 'frontend', 'react.mdc'),
      '---\ndescription: React\nalwaysApply: true\n---\nтело\n',
      'utf8',
    );
    writeFileSync(join(rulesDir, 'notes.md'), '# заметки\n', 'utf8');
    await boot();

    const res = await app.inject({ method: 'GET', url: '/api/provider-rules' });
    expect(res.statusCode).toBe(200);
    const body = res.json<RulesInfo>();
    expect(body.providerId).toBe('cursor');
    expect(body.rulesDir).toBe(rulesDir);
    expect(body.dirExists).toBe(true);
    expect(body.readOnly).toBe(false);
    expect(body.rules.map((rule) => rule.path)).toEqual(['base.mdc', 'frontend/react.mdc']);
    expect(body.rules[0]).toMatchObject({
      description: 'Правила React',
      globs: 'src/**/*.tsx',
      alwaysApply: false,
      frontmatterOk: true,
    });
    // `.md` Cursor не читает — панель показывает его отдельно и не правит.
    expect(body.ignored.map((file) => file.path)).toEqual(['notes.md']);
  });

  it('каталога ещё нет → пустой раздел, каталог НЕ создаётся чтением', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/provider-rules' });
    expect(res.statusCode).toBe(200);
    expect(res.json<RulesInfo>()).toMatchObject({ dirExists: false, rules: [], ignored: [] });
    expect(existsSync(rulesDir)).toBe(false);
  });

  it('полный цикл: создание → чтение → правка → удаление', async () => {
    await boot();

    const created = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: {
        path: 'frontend/react.mdc',
        description: 'React',
        globs: 'src/**/*.tsx',
        alwaysApply: true,
        body: '# React\n',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<{ ok: boolean; path: string }>()).toMatchObject({
      ok: true,
      path: 'frontend/react.mdc',
    });

    const filePath = join(rulesDir, 'frontend', 'react.mdc');
    expect(readFileSync(filePath, 'utf8')).toBe(
      '---\ndescription: React\nglobs: src/**/*.tsx\nalwaysApply: true\n---\n# React\n',
    );

    const read = await app.inject({
      method: 'GET',
      url: '/api/provider-rules/rule?path=frontend/react.mdc',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      path: 'frontend/react.mdc',
      description: 'React',
      alwaysApply: true,
      body: '# React\n',
      readOnly: false,
    });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'frontend/react.mdc', description: 'React 19', body: '# React 19\n' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ backupPath?: string }>().backupPath).toBeDefined();
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('description: React 19');
    // Незаданные поля удалены, а не оставлены с прежними значениями.
    expect(text).not.toContain('globs:');
    expect(text).not.toContain('alwaysApply:');

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/provider-rules/rule?path=frontend/react.mdc',
    });
    expect(deleted.statusCode).toBe(200);
    expect(existsSync(filePath)).toBe(false);
    expect(deleted.json<{ backupPath?: string }>().backupPath).toBeDefined();
  });

  it('правка сохраняет тело и чужие ключи frontmatter', async () => {
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'base.mdc'), RULE, 'utf8');
    await boot();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: {
        path: 'base.mdc',
        description: 'Обновлено',
        globs: 'src/**/*.tsx',
        alwaysApply: false,
        body: '# Компоненты\n\nТолько функциональные.\n',
      },
    });
    expect(res.statusCode).toBe(200);

    const text = readFileSync(join(rulesDir, 'base.mdc'), 'utf8');
    expect(text).toContain('# правило фронтенда');
    expect(text).toContain('owner: team-fe');
    expect(text).toContain('description: Обновлено');
    expect(text).toContain('# Компоненты\n\nТолько функциональные.\n');
  });

  it('нераспознанный frontmatter: GET readOnly, PUT 422, файл байт-в-байт прежний', async () => {
    mkdirSync(rulesDir, { recursive: true });
    const broken = '---\nalwaysApply: конечно\n---\nтело\n';
    writeFileSync(join(rulesDir, 'broken.mdc'), broken, 'utf8');
    await boot();

    const read = await app.inject({
      method: 'GET',
      url: '/api/provider-rules/rule?path=broken.mdc',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ readOnly: true, problem: 'malformed' });

    const write = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'broken.mdc', description: 'x', body: 'новое' },
    });
    expect(write.statusCode).toBe(422);
    expect(write.json<{ error: string }>().error).toBe('rule_read_only');
    expect(readFileSync(join(rulesDir, 'broken.mdc'), 'utf8')).toBe(broken);
  });

  it('`.md` рядом с правилами не правится и не удаляется (400 unsafe_path)', async () => {
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'notes.md'), '# заметки\n', 'utf8');
    await boot();

    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/provider-rules/rule?path=notes.md' });
      expect(res.statusCode, method).toBe(400);
      expect(res.json<{ error: string }>().error, method).toBe('unsafe_path');
    }
    const write = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'notes.md', body: 'взлом' },
    });
    expect(write.statusCode).toBe(400);
    expect(readFileSync(join(rulesDir, 'notes.md'), 'utf8')).toBe('# заметки\n');
  });

  it('`..`, абсолютный путь и пустое имя отклоняются на чтении, записи и удалении', async () => {
    mkdirSync(rulesDir, { recursive: true });
    const outside = join(home, 'escape.mdc');
    writeFileSync(outside, 'чужой файл\n', 'utf8');
    await boot();

    for (const path of [
      '../escape.mdc',
      '..%2Fescape.mdc',
      'C:\\Windows\\evil.mdc',
      '/etc/x.mdc',
    ]) {
      const read = await app.inject({
        method: 'GET',
        url: `/api/provider-rules/rule?path=${encodeURIComponent(path)}`,
      });
      expect(read.statusCode, path).toBe(400);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/provider-rules/rule?path=${encodeURIComponent(path)}`,
      });
      expect(del.statusCode, path).toBe(400);
      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-rules/rule',
        payload: { path, body: 'взлом\n' },
      });
      expect(put.statusCode, path).toBe(400);
    }

    // Пустой путь — отдельная ветка проверки тела запроса.
    const empty = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: '   ', body: 'x' },
    });
    expect(empty.statusCode).toBe(400);
    expect(readFileSync(outside, 'utf8')).toBe('чужой файл\n');
  });

  it('правила нет → 404, файл не создаётся', async () => {
    mkdirSync(rulesDir, { recursive: true });
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/provider-rules/rule?path=нет.mdc' });
    expect(res.statusCode).toBe(404);
    expect(existsSync(join(rulesDir, 'нет.mdc'))).toBe(false);
  });

  it('черновик без тела отклоняется 400, файл не создаётся', async () => {
    await boot();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'x.mdc' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
    expect(existsSync(join(rulesDir, 'x.mdc'))).toBe(false);
  });

  // --- Проектный уровень ------------------------------------------------------

  it('проект: правила лежат в <проект>/.cursor/rules, глобальные не трогаются', async () => {
    await boot();
    const id = await addProject();

    const created = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/rules/rule`,
      payload: { path: 'backend/api.mdc', description: 'API', body: '# API\n' },
    });
    expect(created.statusCode).toBe(200);

    const projectRule = join(projectDir, '.cursor', 'rules', 'backend', 'api.mdc');
    expect(readFileSync(projectRule, 'utf8')).toBe('---\ndescription: API\n---\n# API\n');
    // Глобальный каталог остался несозданным — проект в него не залез.
    expect(existsSync(rulesDir)).toBe(false);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/rules` });
    expect(list.statusCode).toBe(200);
    const body = list.json<RulesInfo>();
    expect(body.rulesDir).toBe(join(projectDir, '.cursor', 'rules'));
    expect(body.rules.map((rule) => rule.path)).toEqual(['backend/api.mdc']);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/provider/rules/rule?path=backend/api.mdc`,
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(projectRule)).toBe(false);
  });

  it('проект: путь наружу каталога правил отклоняется, чужой файл цел', async () => {
    await boot();
    const id = await addProject();
    const outside = join(projectDir, 'README.md');
    writeFileSync(outside, '# проект\n', 'utf8');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/rules/rule`,
      payload: { path: '../../README.md', body: 'взлом\n' },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json<{ error: string }>().error).toBe('unsafe_path');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/provider/rules/rule?path=${encodeURIComponent('../../README.md')}`,
    });
    expect(del.statusCode).toBe(400);
    expect(readFileSync(outside, 'utf8')).toBe('# проект\n');
  });

  it('проект: раздел инструкций-СПИСКОМ у Cursor отсутствует → 400', async () => {
    await boot();
    const id = await addProject();
    for (const url of [
      `/api/projects/${id}/provider/instructions`,
      `/api/projects/${id}/provider/instructions-list`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error, url).toBe('section_unsupported');
    }
  });

  // --- Fail-closed по провайдеру ----------------------------------------------

  it('claude активен → маршруты правил 400, каталог Cursor не создаётся', async () => {
    await boot('claude');

    const list = await app.inject({ method: 'GET', url: '/api/provider-rules' });
    expect(list.statusCode).toBe(400);
    expect(list.json<{ error: string }>().error).toBe('section_unsupported');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'x.mdc', body: 'тело' },
    });
    expect(put.statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', url: '/api/provider-rules/rule?path=x.mdc' });
    expect(del.statusCode).toBe(400);
    expect(existsSync(rulesDir)).toBe(false);
  });

  it('провайдер с другой моделью инструкций (codex, aider) → 400 на правилах', async () => {
    for (const provider of ['codex', 'aider']) {
      await boot(provider);
      const res = await app.inject({ method: 'GET', url: '/api/provider-rules' });
      expect(res.statusCode, provider).toBe(400);
      await app.close();
      rmSync(join(root, 'claude-control', 'state.json'), { force: true });
    }
  });

  it('cursor активен → раздел инструкций-СПИСКОМ (Aider) ему недоступен', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/provider-instructions' });
    expect(res.statusCode).toBe(400);
    // И единый файл инструкций тоже: у Cursor его не бывает.
    const claudeMd = await app.inject({ method: 'GET', url: '/api/claude-md' });
    expect(claudeMd.statusCode).toBe(400);
  });
});
