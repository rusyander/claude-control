import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderSkill, ProviderSkillsInfo } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderSkillsRoutes } from './provider-skills-routes.ts';

/**
 * OPENCODE-5, маршруты: `/api/provider-skills` (+ `/skill`).
 *
 * Проверяем на ВРЕМЕННОМ каталоге конфигурации (`XDG_CONFIG_HOME`) — реальный
 * `~` не трогается. Главное: раздел доступен ТОЛЬКО у opencode; round-trip
 * скилла с сохранением незнакомых полей шапки; правила имени → 400; защита путей
 * отвечает 400 `unsafe_path` (а не 404) на чтении/записи/удалении; неразобранная
 * шапка → GET readOnly + PUT 422 и файл байт-в-байт.
 */
describe('provider-skills-routes: скиллы CLI провайдера', () => {
  let appDataRoot: string;
  let xdgRoot: string;
  let skillsDir: string;
  let app: FastifyInstance;
  let previousXdg: string | undefined;

  const boot = async (provider: string): Promise<void> => {
    const store = new AppStore(appDataRoot);
    if (provider !== 'claude') store.updateSettings({ provider });
    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderSkillsRoutes(app, ctx);
    await app.ready();
  };

  const putSkill = (dir: string, content: string): void => {
    mkdirSync(join(skillsDir, dir), { recursive: true });
    writeFileSync(join(skillsDir, dir, 'SKILL.md'), content);
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    xdgRoot = mkdtempSync(join(tmpdir(), 'cc-xdg-'));
    skillsDir = join(xdgRoot, 'opencode', 'skills');
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgRoot;
  });

  afterEach(async () => {
    await app?.close();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(xdgRoot, { recursive: true, force: true });
  });

  it('раздел доступен только у opencode: у claude и прочих — 400', async () => {
    for (const provider of ['claude', 'codex', 'gemini', 'cursor', 'aider']) {
      await boot(provider);
      const get = await app.inject({ method: 'GET', url: '/api/provider-skills' });
      expect(get.statusCode, provider).toBe(400);
      expect(get.json<{ error: string }>().error).toBe('section_unsupported');

      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-skills/skill',
        payload: { path: 'a/SKILL.md', name: 'a', description: 'd', body: '' },
      });
      expect(put.statusCode, provider).toBe(400);
      await app.close();
    }
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('opencode: путь каталога из XDG, каталог не создаётся, внешние каталоги показаны', async () => {
    await boot('opencode');
    const res = await app.inject({ method: 'GET', url: '/api/provider-skills' });
    expect(res.statusCode).toBe(200);
    const info = res.json<ProviderSkillsInfo>();
    expect(info.providerId).toBe('opencode');
    expect(info.skillsDir).toBe(skillsDir);
    expect(info.dirExists).toBe(false);
    // ~/.claude/skills и ~/.agents/skills показаны как «сюда мы не пишем».
    expect(info.externalDirs.map((d) => d.path).some((p) => p.includes('.claude'))).toBe(true);
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('полный цикл: создать → прочитать → обновить (незнакомые поля целы) → удалить', async () => {
    await boot('opencode');

    const create = await app.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: {
        path: 'my-skill/SKILL.md',
        name: 'my-skill',
        description: 'делает X',
        body: '# H\n',
      },
    });
    expect(create.statusCode).toBe(200);
    expect(existsSync(join(skillsDir, 'my-skill', 'SKILL.md'))).toBe(true);

    // Допишем руками чужое поле, чтобы проверить его сохранение при обновлении.
    const path = join(skillsDir, 'my-skill', 'SKILL.md');
    writeFileSync(path, '---\nname: my-skill\ndescription: делает X\nlicense: MIT\n---\n# H\n');

    const read = await app.inject({
      method: 'GET',
      url: '/api/provider-skills/skill?path=my-skill/SKILL.md',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<ProviderSkill>()).toMatchObject({ name: 'my-skill', otherKeys: ['license'] });

    const update = await app.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: {
        path: 'my-skill/SKILL.md',
        name: 'my-skill',
        description: 'делает Y',
        body: '# H\n',
      },
    });
    expect(update.statusCode).toBe(200);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('description: делает Y');
    expect(raw).toContain('license: MIT');

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/provider-skills/skill?path=my-skill/SKILL.md',
    });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(skillsDir, 'my-skill'))).toBe(false);
  });

  it('невалидное имя → 400 invalid_draft, файл не создан', async () => {
    await boot('opencode');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: { path: 'Bad_Name/SKILL.md', name: 'Bad_Name', description: 'd', body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_draft');
    expect(existsSync(join(skillsDir, 'Bad_Name'))).toBe(false);
  });

  it('name ≠ имя папки → 400 (по документации CLI такой скилл не подхватит)', async () => {
    await boot('opencode');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: { path: 'folder/SKILL.md', name: 'other', description: 'd', body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(skillsDir, 'folder'))).toBe(false);
  });

  it('небезопасные пути → 400 unsafe_path на GET/PUT/DELETE, ничего снаружи не создано', async () => {
    await boot('opencode');
    const unsafe = ['../evil/SKILL.md', '/abs/SKILL.md', 'a/b/SKILL.md', 'x/README.md'];
    for (const path of unsafe) {
      const get = await app.inject({
        method: 'GET',
        url: `/api/provider-skills/skill?path=${encodeURIComponent(path)}`,
      });
      expect(get.statusCode, `GET ${path}`).toBe(400);
      expect(get.json<{ error: string }>().error).toBe('unsafe_path');

      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-skills/skill',
        payload: { path, name: 'x', description: 'd', body: '' },
      });
      expect(put.statusCode, `PUT ${path}`).toBe(400);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/provider-skills/skill?path=${encodeURIComponent(path)}`,
      });
      expect(del.statusCode, `DELETE ${path}`).toBe(400);
    }
    expect(existsSync(join(xdgRoot, 'evil'))).toBe(false);
  });

  it('missing скилл → 404 (в отличие от unsafe → 400)', async () => {
    await boot('opencode');
    mkdirSync(skillsDir, { recursive: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/provider-skills/skill?path=ghost/SKILL.md',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });

  it('неразобранная шапка → GET readOnly, PUT 422, файл байт-в-байт', async () => {
    await boot('opencode');
    const before = 'мусор без шапки\n';
    putSkill('broken', before);

    const read = await app.inject({
      method: 'GET',
      url: '/api/provider-skills/skill?path=broken/SKILL.md',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<ProviderSkill>()).toMatchObject({ readOnly: true, problem: 'no_frontmatter' });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-skills/skill',
      payload: { path: 'broken/SKILL.md', name: 'broken', description: 'd', body: 'y' },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json<{ error: string }>().error).toBe('skill_read_only');
    expect(readFileSync(join(skillsDir, 'broken', 'SKILL.md'), 'utf8')).toBe(before);
  });
});
