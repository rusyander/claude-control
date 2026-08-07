import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProjectFileChanges,
  ProjectFileContent,
  ProjectFileTree,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { AppStore } from '../lib/app-store.ts';
import { registerProjectFilesRoutes } from './project-files-routes.ts';

/**
 * Маршруты файлов проекта. На уровне HTTP важны три вещи, и все три о цене
 * ошибки: чужой каталог не читается (400), несвежая запись отбивается (409), а
 * дифф собирается по настоящему транскрипту, а не по подсунутому объекту.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

/** Транскрипт разговора там, где его ищет `findTranscript`. */
function writeTranscript(configRoot: string, chatId: string, calls: unknown[]): void {
  const dir = join(configRoot, 'projects', 'some-project');
  mkdirSync(dir, { recursive: true });

  const lines = calls.map((input) => JSON.stringify(input));
  writeFileSync(join(dir, `${chatId}.jsonl`), `${lines.join('\n')}\n`);
}

function toolUse(name: string, input: unknown) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  };
}

describe('project-files-routes', () => {
  let app: FastifyInstance;
  let project = '';
  let configRoot = '';
  let store: AppStore;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-pf-project-'));
    configRoot = mkdtempSync(join(tmpdir(), 'cc-pf-config-'));

    app = Fastify();
    store = new AppStore(join(configRoot, 'claude-control'));
    registerProjectFilesRoutes(app, {
      location: { paths: { root: configRoot } },
      backupDir: undefined,
      store,
    } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
    dropTemp(configRoot);
  });

  const url = (route: string, query: Record<string, string>): string => {
    const search = new URLSearchParams({ path: project, ...query });
    return `/api/project-files/${route}?${search.toString()}`;
  };

  it('без пути или с относительным путём — 400', async () => {
    expect((await app.inject({ url: '/api/project-files/tree' })).statusCode).toBe(400);
    const relative = await app.inject({ url: '/api/project-files/tree?path=./x' });
    expect(relative.statusCode).toBe(400);
  });

  it('дерево читается по уровню', async () => {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src', 'app.ts'), 'const a = 1;\n');

    const root = await app.inject({ url: url('tree', { dir: '' }) });
    expect(root.statusCode).toBe(200);
    expect((root.json() as ProjectFileTree).entries.map((entry) => entry.name)).toEqual(['src']);

    const nested = await app.inject({ url: url('tree', { dir: 'src' }) });
    expect((nested.json() as ProjectFileTree).entries[0]?.name).toBe('app.ts');
  });

  it('выход за каталог проекта — 400, а не чтение чужой папки', async () => {
    const escape = await app.inject({ url: url('tree', { dir: '../..' }) });
    expect(escape.statusCode).toBe(400);
  });

  it('дифф собирается по правкам агента из транскрипта разговора', async () => {
    writeFileSync(join(project, 'a.ts'), 'const a = 10;\n');
    writeTranscript(configRoot, 'chat-1', [
      toolUse('Edit', {
        file_path: join(project, 'a.ts'),
        old_string: 'const a = 1;',
        new_string: 'const a = 10;',
      }),
    ]);

    const changes = await app.inject({ url: url('changes', { chatId: 'chat-1' }) });
    expect((changes.json() as ProjectFileChanges).files).toEqual([
      { path: 'a.ts', added: 1, removed: 1, missing: false },
    ]);

    const content = await app.inject({ url: url('content', { file: 'a.ts', chatId: 'chat-1' }) });
    const file = content.json() as ProjectFileContent;
    expect(file.content).toBe('const a = 10;\n');
    expect(file.baseline).toBe('const a = 1;\n');
    expect(file.kind).toBe('exact');
  });

  it('без разговора файл читается без сравнения', async () => {
    writeFileSync(join(project, 'a.ts'), 'текст\n');

    const content = await app.inject({ url: url('content', { file: 'a.ts' }) });
    const file = content.json() as ProjectFileContent;

    expect(file.kind).toBe('none');
    expect(file.baseline).toBeUndefined();
  });

  it('несуществующий файл — 404', async () => {
    const missing = await app.inject({ url: url('content', { file: 'nope.ts' }) });
    expect(missing.statusCode).toBe(404);
  });

  it('запись сохраняет файл, несвежая — 409 и чужая работа цела', async () => {
    const target = join(project, 'a.ts');
    writeFileSync(target, 'было\n');
    const { mtimeMs } = statSync(target);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/project-files/content',
      payload: { path: project, file: 'a.ts', content: 'стало\n', mtimeMs },
    });
    expect(saved.statusCode).toBe(200);
    expect(readFileSync(target, 'utf8')).toBe('стало\n');

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/project-files/content',
      payload: { path: project, file: 'a.ts', content: 'поверх\n', mtimeMs },
    });
    expect(stale.statusCode).toBe(409);
    expect(readFileSync(target, 'utf8')).toBe('стало\n');
  });

  it('запись за пределы проекта — 400', async () => {
    const escape = await app.inject({
      method: 'PUT',
      url: '/api/project-files/content',
      payload: { path: project, file: '../escape.ts', content: 'x', mtimeMs: 0 },
    });
    expect(escape.statusCode).toBe(400);
  });

  /**
   * Отдача байтов. Здесь важен не столько сам показ, сколько чего маршрут НЕ
   * отдаёт: тип содержимого, который браузер согласится выполнить, и файл за
   * пределами проекта.
   */
  describe('картинки и PDF', () => {
    it('картинка приходит своим типом и без кэша', async () => {
      writeFileSync(join(project, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const response = await app.inject({ url: url('raw', { file: 'shot.png' }) });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.rawPayload.length).toBe(4);
    });

    it('исполняемый формат наружу не уходит — 400, а не «как есть»', async () => {
      writeFileSync(join(project, 'page.html'), '<script>alert(1)</script>');
      writeFileSync(join(project, 'icon.svg'), '<svg />');

      expect((await app.inject({ url: url('raw', { file: 'page.html' }) })).statusCode).toBe(400);
      expect((await app.inject({ url: url('raw', { file: 'icon.svg' }) })).statusCode).toBe(400);
    });

    it('выход за каталог проекта — 400', async () => {
      const escape = await app.inject({ url: url('raw', { file: '../secret.png' }) });
      expect(escape.statusCode).toBe(400);
    });

    it('в содержимом картинки приходит признак показа вместо текста', async () => {
      writeFileSync(join(project, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const content = await app.inject({ url: url('content', { file: 'shot.png' }) });
      const file = content.json() as ProjectFileContent;

      expect(file.preview).toBe('image');
      expect(file.isBinary).toBe(true);
      expect(file.content).toBe('');
    });
  });

  describe('снимок окна кода', () => {
    const view = { file: 'a.ts', openDirs: ['src'], showDiff: false, onlyChanged: true };

    it('до первого открытия — пусто, а не отказ', async () => {
      const empty = await app.inject({ url: url('view', {}) });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toBeNull();
    });

    it('записанный снимок возвращается как есть', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/project-files/view',
        payload: { path: project, view },
      });
      expect(put.statusCode).toBe(200);

      expect((await app.inject({ url: url('view', {}) })).json()).toEqual(view);
      expect(store.getCodeView(project)).toEqual(view);
    });

    it('снимок без списка папок — 400, а не запись мусора', async () => {
      const broken = await app.inject({
        method: 'PUT',
        url: '/api/project-files/view',
        payload: { path: project, view: { showDiff: true } },
      });
      expect(broken.statusCode).toBe(400);
      expect(store.getCodeView(project)).toBeUndefined();
    });

    it('закрытие таба стирает снимок', async () => {
      store.setCodeView(project, view);

      const gone = await app.inject({ method: 'DELETE', url: url('view', {}) });
      expect(gone.statusCode).toBe(200);
      expect((await app.inject({ url: url('view', {}) })).json()).toBeNull();
    });
  });

  /**
   * Раскладка — одна на панель, поэтому у её маршрута нет `path`: спрашивать
   * ширину списка «для этого проекта» было бы обещанием, которого сервер не
   * даёт.
   */
  describe('раскладка окна кода', () => {
    it('без записи отдаётся умолчание', async () => {
      const response = await app.inject({ url: '/api/project-files/layout' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ treeWidth: 300 });
    });

    it('ширина записывается и возвращается', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/project-files/layout',
        payload: { treeWidth: 460 },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ treeWidth: 460 });
      expect((await app.inject({ url: '/api/project-files/layout' })).json()).toEqual({
        treeWidth: 460,
      });
    });

    it('перебор обрезается по границам — это результат жеста мышью, а не форма', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/project-files/layout',
        payload: { treeWidth: 9000 },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ treeWidth: 720 });
    });

    it('запрос без ширины — 400, а не запись мусора', async () => {
      const broken = await app.inject({
        method: 'PUT',
        url: '/api/project-files/layout',
        payload: { treeWidth: 'широкая' },
      });
      expect(broken.statusCode).toBe(400);
      expect(store.getCodeLayout()).toEqual({ treeWidth: 300 });
    });

    it('ширина не привязана к проекту: закрытие таба её не трогает', async () => {
      store.setCodeLayout({ treeWidth: 500 });
      store.setCodeView(project, {
        file: 'a.ts',
        openDirs: ['src'],
        showDiff: false,
        onlyChanged: true,
      });

      await app.inject({ method: 'DELETE', url: url('view', {}) });
      expect(store.getCodeLayout()).toEqual({ treeWidth: 500 });
    });
  });
});
