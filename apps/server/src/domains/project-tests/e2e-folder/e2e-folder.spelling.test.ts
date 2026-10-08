import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import { makeProject } from '../../projects/projects.ts';
import { createE2eFolder, e2eFolderView, removeE2eFolder } from './e2e-folder.ts';
import { projectEntry } from '../files.ts';

/**
 * Один каталог — два написания: короткое имя 8.3 (`C:\Users\RUSYAN~1\…`, путь из
 * %TEMP% или cwd оболочки агента) и то, что лежит на диске. Реестр проектов
 * хранил путь как ввели, маршруты «Тестов» приводят его к написанию на диске —
 * и запись о папке e2e, заведённой при добавлении проекта, раздел не находил:
 * своя папка показывалась чужой, убрать её было нельзя.
 */
const win = process.platform === 'win32';

/** Короткое имя каталога по 8.3; `undefined`, если на томе их не заводят. */
function shortName(dir: string): string | undefined {
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${dir}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).stdout.trim();
  return out && out.toLowerCase() !== dir.toLowerCase() ? out : undefined;
}

describe.runIf(win)('папка e2e при коротком имени каталога', () => {
  let base = '';
  let long = '';
  let short: string | undefined;
  let appData = '';

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-spelling-')));
    long = join(base, 'project with a long name');
    mkdirSync(long);
    short = shortName(long);
    appData = join(base, 'data');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('заведённая по короткому имени папка — своя и убирается по написанию на диске', (ctx) => {
    if (!short) return ctx.skip();
    expect(createE2eFolder(appData, short, '2026-09-28T10:00:00.000Z').state).toBe('created');

    expect(e2eFolderView(long, appData)).toMatchObject({ state: 'created', origin: 'panel' });
    expect(removeE2eFolder(appData, long, false).state).toBe('missing');
  });

  it('запись, сделанная раньше под коротким ключом, находится по длинному', (ctx) => {
    if (!short) return ctx.skip();
    createE2eFolder(appData, long, '2026-09-28T10:00:00.000Z');
    // Так лежали записи до правки: ключ — короткое написание как ввели.
    const file = join(appData, 'tests-e2e.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      folders: Record<string, { projectPath: string; files: { path: string }[] }>;
    };
    const record = state.folders[normalizeProjectPath(long)]!;
    record.projectPath = short;
    for (const item of record.files) item.path = item.path.replace(long, short);
    writeFileSync(
      file,
      JSON.stringify({ ...state, folders: { [normalizeProjectPath(short)]: record } }),
    );

    expect(e2eFolderView(long, appData)).toMatchObject({ state: 'created', origin: 'panel' });
    expect(removeE2eFolder(appData, long, false).state).toBe('missing');
  });

  it('реестр проектов хранит каталог в написании на диске', (ctx) => {
    if (!short) return ctx.skip();
    expect(makeProject({ path: short }).path).toBe(long);
  });

  /**
   * F-134 (сосед): замок прогонов (`runs.holds`, `e2eRuns.isRunning`) ищет запись
   * через `projectEntry`. Сворачивались только регистр и слэши — чат, чей cwd из
   * старой записи реестра в имени 8.3, считал проект свободным, пока под длинным
   * ключом шёл прогон.
   */
  it('запись реестра прогонов находится по любому написанию каталога', (ctx) => {
    if (!short) return ctx.skip();
    expect(projectEntry(new Map([[long, 'run']]), short)).toBe('run');
    expect(projectEntry(new Map([[short, 'run']]), long)).toBe('run');
    expect(projectEntry(new Map([[long, 'run']]), join(base, 'other'))).toBeUndefined();
  });
});
