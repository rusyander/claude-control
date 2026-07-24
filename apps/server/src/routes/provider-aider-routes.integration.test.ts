import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderInstructionsRoutes } from './provider-instructions-routes.ts';
import { registerProviderProjectRoutes } from './provider-project-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';

/**
 * AIDER-1 / AIDER-4 на маршрутах: инструкции-СПИСКОМ и проектный уровень Aider.
 *
 * HOME/USERPROFILE подменяются на временный каталог — настоящий `~` не читается
 * и не пишется. Покрыто: полный цикл GET→PUT→GET по списку `read`, правка
 * содержимого перечисленного файла, отказ по несуществующему и не перечисленному
 * файлу, fail-closed на битом YAML, безопасность проектных путей и то, что при
 * активном Claude оба маршрута отвечают 400, а файлы Aider остаются нетронутыми.
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

const CONFIG = `## Модель
model: gpt-4o

## Файлы-конвенции
read:
  - CONVENTIONS.md

set-env:
  - OPENAI_API_TYPE=azure
`;

describe('aider: инструкции-список и проектный уровень на tmp-HOME', () => {
  let home: string;
  let root: string;
  let projectDir: string;
  let app: FastifyInstance;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let configPath: string;

  const boot = async (provider = 'aider'): Promise<void> => {
    app = Fastify();
    const ctx = makeCtx(root, provider);
    registerProjectRoutes(app, ctx);
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
    home = mkdtempSync(join(tmpdir(), 'cc-home-aider-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    configPath = join(home, '.aider.conf.yml');
    root = mkdtempSync(join(tmpdir(), 'cc-aider-routes-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-aider-project-'));
  });
  afterEach(async () => {
    await app?.close();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    for (const dir of [home, root, projectDir]) rmSync(dir, { recursive: true, force: true });
  });

  // --- Глобальный список ссылок (AIDER-1) ---

  it('GET отдаёт список read с абсолютными путями и флагом существования', async () => {
    writeFileSync(configPath, CONFIG, 'utf8');
    writeFileSync(join(home, 'CONVENTIONS.md'), '# правила\n', 'utf8');
    await boot();

    const res = await app.inject({ method: 'GET', url: '/api/provider-instructions' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      providerId: string;
      configPath: string;
      readOnly: boolean;
      entries: { raw: string; path: string; exists: boolean; editable: boolean }[];
    }>();
    expect(body.providerId).toBe('aider');
    expect(body.configPath).toBe(configPath);
    expect(body.readOnly).toBe(false);
    expect(body.entries).toEqual([
      { raw: 'CONVENTIONS.md', path: join(home, 'CONVENTIONS.md'), exists: true, editable: true },
    ]);
  });

  it('PUT переписывает только ключ read: комментарии и set-env целы', async () => {
    writeFileSync(configPath, CONFIG, 'utf8');
    await boot();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions',
      payload: { entries: ['docs/style.md', 'CONVENTIONS.md'] },
    });
    expect(put.statusCode).toBe(200);

    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('## Файлы-конвенции');
    expect(after).toContain('model: gpt-4o');
    expect(after).toContain('OPENAI_API_TYPE=azure');

    const res = await app.inject({ method: 'GET', url: '/api/provider-instructions' });
    expect(res.json<{ entries: { raw: string }[] }>().entries.map((e) => e.raw)).toEqual([
      'docs/style.md',
      'CONVENTIONS.md',
    ]);
  });

  it('пустой/некорректный черновик → 400, файл не тронут', async () => {
    writeFileSync(configPath, CONFIG, 'utf8');
    await boot();

    for (const payload of [{ entries: [''] }, { entries: ['a\nb'] }, {}]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/provider-instructions',
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
  });

  it('битый YAML → GET readOnly, PUT 422, файл не изменён', async () => {
    writeFileSync(configPath, 'read: [a\n  - b\n', 'utf8');
    await boot();

    const get = await app.inject({ method: 'GET', url: '/api/provider-instructions' });
    expect(get.json<{ readOnly: boolean }>().readOnly).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions',
      payload: { entries: ['x.md'] },
    });
    expect(put.statusCode).toBe(422);
    expect(readFileSync(configPath, 'utf8')).toBe('read: [a\n  - b\n');
  });

  // --- Содержимое перечисленного файла ---

  it('содержимое перечисленного файла читается и пишется (round-trip)', async () => {
    writeFileSync(configPath, CONFIG, 'utf8');
    writeFileSync(join(home, 'CONVENTIONS.md'), 'Пиши тесты.\n', 'utf8');
    await boot();

    const get = await app.inject({
      method: 'GET',
      url: '/api/provider-instructions/file?path=CONVENTIONS.md',
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ content: string }>().content).toBe('Пиши тесты.\n');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions/file',
      payload: { path: 'CONVENTIONS.md', content: 'Новые правила.\n' },
    });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(join(home, 'CONVENTIONS.md'), 'utf8')).toBe('Новые правила.\n');
  });

  it('файла из списка нет → 400 missing, и панель его НЕ создаёт', async () => {
    writeFileSync(configPath, `read:\n  - docs/style.md\n`, 'utf8');
    await boot();

    const get = await app.inject({
      method: 'GET',
      url: '/api/provider-instructions/file?path=docs/style.md',
    });
    expect(get.statusCode).toBe(400);
    expect(get.json<{ error: string }>().error).toBe('missing');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions/file',
      payload: { path: 'docs/style.md', content: 'что-то' },
    });
    expect(put.statusCode).toBe(400);
    expect(existsSync(join(home, 'docs', 'style.md'))).toBe(false);
  });

  it('файл вне списка → 404 unlisted, содержимое на диске не тронуто', async () => {
    writeFileSync(configPath, CONFIG, 'utf8');
    writeFileSync(join(home, 'secret.md'), 'секрет\n', 'utf8');
    await boot();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions/file',
      payload: { path: 'secret.md', content: 'подмена' },
    });
    expect(put.statusCode).toBe(404);
    expect(put.json<{ error: string }>().error).toBe('unlisted');
    expect(readFileSync(join(home, 'secret.md'), 'utf8')).toBe('секрет\n');
  });

  // --- Проектный уровень (AIDER-4) ---

  it('проект: список read правится в <проект>/.aider.conf.yml', async () => {
    writeFileSync(join(projectDir, '.aider.conf.yml'), CONFIG, 'utf8');
    writeFileSync(join(projectDir, 'CONVENTIONS.md'), '# проектные правила\n', 'utf8');
    await boot();
    const id = await addProject();

    const info = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider` });
    expect(info.json<{ sections: string[] }>().sections).toEqual(['instructionsList', 'env']);

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/instructions-list`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ configPath: string }>().configPath).toBe(join(projectDir, '.aider.conf.yml'));
    expect(get.json<{ entries: { editable: boolean }[] }>().entries[0]!.editable).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/instructions-list`,
      payload: { entries: ['CONVENTIONS.md', 'docs/style.md'] },
    });
    expect(put.statusCode).toBe(200);
    const after = readFileSync(join(projectDir, '.aider.conf.yml'), 'utf8');
    expect(after).toContain('OPENAI_API_TYPE=azure');
    // Глобальный конфиг при этом не создан вовсе.
    expect(existsSync(configPath)).toBe(false);
  });

  it('проект: перечисленный файл ВНЕ каталога проекта не открывается и не пишется', async () => {
    const outsideFile = join(home, 'outside.md');
    writeFileSync(outsideFile, 'снаружи\n', 'utf8');
    writeFileSync(
      join(projectDir, '.aider.conf.yml'),
      `read:\n  - ${outsideFile.split('\\').join('/')}\n`,
      'utf8',
    );
    await boot();
    const id = await addProject();

    const raw = encodeURIComponent(outsideFile.split('\\').join('/'));
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}/provider/instructions-list/file?path=${raw}`,
    });
    expect(get.statusCode).toBe(400);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/instructions-list/file`,
      payload: { path: outsideFile.split('\\').join('/'), content: 'подмена' },
    });
    expect(put.statusCode).toBe(400);
    expect(readFileSync(outsideFile, 'utf8')).toBe('снаружи\n');
  });

  // --- Регресс-ноль по Claude ---

  it('активный claude → оба маршрута 400, файлы aider не созданы', async () => {
    await boot('claude');

    for (const url of ['/api/provider-instructions', '/api/provider-instructions/file?path=a.md']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('section_unsupported');
    }
    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-instructions',
      payload: { entries: ['x.md'] },
    });
    expect(put.statusCode).toBe(400);
    expect(existsSync(configPath)).toBe(false);
  });

  it('провайдер с однофайловыми инструкциями (codex) в этот раздел не ходит', async () => {
    await boot('codex');
    const res = await app.inject({ method: 'GET', url: '/api/provider-instructions' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('section_unsupported');
  });
});
