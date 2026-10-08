import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderRulesRoutes } from './provider-rules-routes.ts';
import { describeProviders } from '../providers/registry.ts';
import { registerProjectRoutes } from './project-routes/project-routes.ts';
import { registerProviderProjectRoutes } from './provider-project-routes/provider-project-routes.ts';

/**
 * MAP 24 на маршрутах: правила Qwen Code каталогом `<QWEN_HOME>/rules/*.md`.
 *
 * `QWEN_HOME` указывает во временный каталог — настоящий `~/.qwen` не читается и
 * не пишется. Покрыто: файл без frontmatter — постоянное правило и правится;
 * `paths` списком и строкой; создание пишет `paths:` без `alwaysApply`;
 * `alwaysApply` в черновике — 400; не-`.md` — игнорируемый; при активном Claude
 * маршруты отвечают 400; модель раздела в `/api/providers` — `files`.
 */
function makeCtx(root: string, provider: string): ServerContext {
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  const store = new AppStore(join(root, 'agentdeck'));
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData: join(root, 'agentdeck') } },
    store,
    backupDir: join(root, 'agentdeck', 'backups'),
  } as unknown as ServerContext;
}

interface RulesInfo {
  providerId: string;
  format: string;
  rulesDir: string;
  rules: { path: string; description?: string; globs?: string; frontmatterOk: boolean }[];
  ignored: { path: string }[];
}

describe('qwen: каталог правил ~/.qwen/rules', () => {
  let root: string;
  let qwenHome: string;
  let rulesDir: string;
  let app: FastifyInstance;
  let prevQwenHome: string | undefined;
  let ctx: ServerContext;

  const boot = async (provider = 'qwen'): Promise<void> => {
    ctx = makeCtx(root, provider);
    app = Fastify();
    registerProviderRulesRoutes(app, ctx);
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-rules-'));
    qwenHome = join(root, 'qwen-home');
    rulesDir = join(qwenHome, 'rules');
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    writeFileSync(join(rulesDir, 'always.md'), 'Всегда отвечай по-русски.\n');
    writeFileSync(
      join(rulesDir, 'frontend', 'react.md'),
      '---\ndescription: React\npaths:\n  - src/**/*.tsx\n---\nТолько функции.\n',
    );
    writeFileSync(join(rulesDir, 'notes.txt'), 'не правило');
    prevQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = qwenHome;
  });

  afterEach(async () => {
    await app?.close();
    if (prevQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = prevQwenHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('список: файл без frontmatter — правило, .txt — игнорируемый; модель раздела files', async () => {
    await boot();
    const response = await app.inject({ method: 'GET', url: '/api/provider-rules' });
    expect(response.statusCode).toBe(200);
    const info = response.json<RulesInfo>();
    expect(info.providerId).toBe('qwen');
    expect(info.format).toBe('qwen-md');
    expect(info.rulesDir).toBe(rulesDir);
    expect(info.rules).toEqual([
      expect.objectContaining({ path: 'always.md', frontmatterOk: true }),
      expect.objectContaining({
        path: 'frontend/react.md',
        description: 'React',
        globs: 'src/**/*.tsx',
        frontmatterOk: true,
      }),
    ]);
    expect(info.ignored.map((file) => file.path)).toEqual(['notes.txt']);

    const qwen = describeProviders(ctx.store).providers.find((p) => p.id === 'qwen');
    expect(qwen?.rulesModel).toBe('files');
    expect(qwen?.capabilities.rules).toBe('ready');
    const claude = describeProviders(ctx.store).providers.find((p) => p.id === 'claude');
    expect(claude?.rulesModel).toBe('claude');
  });

  it('правило без frontmatter открывается на правку, а не только на чтение', async () => {
    await boot();
    const response = await app.inject({
      method: 'GET',
      url: '/api/provider-rules/rule?path=always.md',
    });
    expect(response.json()).toMatchObject({ readOnly: false, body: 'Всегда отвечай по-русски.\n' });
  });

  it('создание пишет paths списком, без alwaysApply; правка без полей не добавляет frontmatter', async () => {
    await boot();
    const created = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: {
        path: 'tests/e2e.md',
        description: 'E2E',
        globs: 'e2e/**/*.{ts,tsx}',
        body: 'Тело\n',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(readFileSync(join(rulesDir, 'tests', 'e2e.md'), 'utf8')).toBe(
      '---\ndescription: E2E\npaths:\n  - e2e/**/*.{ts,tsx}\n---\nТело\n',
    );

    const edited = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'always.md', body: 'Всегда кратко.\n' },
    });
    expect(edited.statusCode).toBe(200);
    expect(readFileSync(join(rulesDir, 'always.md'), 'utf8')).toBe('Всегда кратко.\n');
  });

  it('alwaysApply формату Qwen чужой — 400, файл не создан', async () => {
    await boot();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/provider-rules/rule',
      payload: { path: 'x.md', alwaysApply: true, body: 'b' },
    });
    expect(response.statusCode).toBe(400);
    expect(existsSync(join(rulesDir, 'x.md'))).toBe(false);
  });

  it('путь не .md и выход за каталог — отказ', async () => {
    await boot();
    for (const path of ['x.mdc', '../escape.md']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/provider-rules/rule',
        payload: { path, body: 'b' },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(existsSync(join(qwenHome, 'escape.md'))).toBe(false);
  });

  it('при активном Claude маршруты отвечают 400 и каталог Qwen не трогают', async () => {
    await boot('claude');
    const response = await app.inject({ method: 'GET', url: '/api/provider-rules' });
    expect(response.statusCode).toBe(400);
  });
});

describe('qwen: правила проекта <проект>/.qwen/rules', () => {
  let root: string;
  let qwenHome: string;
  let projectDir: string;
  let app: FastifyInstance;
  let prevQwenHome: string | undefined;

  const boot = async (): Promise<string> => {
    const ctx = makeCtx(root, 'qwen');
    app = Fastify();
    registerProjectRoutes(app, ctx);
    registerProviderRulesRoutes(app, ctx);
    registerProviderProjectRoutes(app, ctx);
    await app.ready();
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
    root = mkdtempSync(join(tmpdir(), 'qwen-project-rules-'));
    qwenHome = join(root, 'qwen-home');
    // Реестр пишет путь написанием на диске (F-134): tmpdir на Windows даёт 8.3.
    projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'qwen-project-')));
    prevQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = qwenHome;
  });

  afterEach(async () => {
    await app?.close();
    if (prevQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = prevQwenHome;
    for (const dir of [root, projectDir]) rmSync(dir, { recursive: true, force: true });
  });

  it('раздел объявлен рядом с QWEN.md: формат qwen-md, каталог проекта', async () => {
    const id = await boot();
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider` });
    expect(res.statusCode).toBe(200);
    const info = res.json<{
      sections: string[];
      instructionsRulesFormat?: string;
      instructionsRulesDir?: string;
    }>();
    expect(info.sections).toContain('instructions');
    expect(info.sections).toContain('instructionsRules');
    expect(info.instructionsRulesFormat).toBe('qwen-md');
    expect(info.instructionsRulesDir).toBe(join(projectDir, '.qwen', 'rules'));
  });

  it('цикл в проекте: paths без alwaysApply, глобальный каталог не создан, удаление', async () => {
    const id = await boot();
    const created = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/provider/rules/rule`,
      payload: {
        path: 'api/handlers.md',
        description: 'API',
        globs: 'src/api/**',
        body: 'Тело\n',
      },
    });
    expect(created.statusCode).toBe(200);
    const projectRule = join(projectDir, '.qwen', 'rules', 'api', 'handlers.md');
    expect(readFileSync(projectRule, 'utf8')).toBe(
      '---\ndescription: API\npaths:\n  - src/api/**\n---\nТело\n',
    );
    expect(existsSync(join(qwenHome, 'rules'))).toBe(false);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${id}/provider/rules` });
    expect(list.statusCode).toBe(200);
    const body = list.json<RulesInfo>();
    expect(body.format).toBe('qwen-md');
    expect(body.rulesDir).toBe(join(projectDir, '.qwen', 'rules'));
    expect(body.rules.map((rule) => rule.path)).toEqual(['api/handlers.md']);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}/provider/rules/rule?path=api/handlers.md`,
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(projectRule)).toBe(false);
  });

  it('в проекте те же отказы формата: alwaysApply, .mdc и выход наружу — 400', async () => {
    const id = await boot();
    for (const payload of [
      { path: 'x.md', alwaysApply: true, body: 'b' },
      { path: 'x.mdc', body: 'b' },
      { path: '../../escape.md', body: 'b' },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/provider/rules/rule`,
        payload,
      });
      expect(res.statusCode, payload.path).toBe(400);
    }
    expect(existsSync(join(projectDir, '.qwen', 'rules', 'x.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'escape.md'))).toBe(false);
  });
});
