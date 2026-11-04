import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapPlanFor, WorktreeBootstraps } from './bootstrap.ts';
import { PREP_TREE_HOOKS, settlePrepTree, snapshotPrepTree } from './lockfiles.ts';
import { parseDirtyPaths } from './read.ts';

/** Грязные пути копии так, как их видит git: отслеживаемые правки и новые файлы. */
function dirtyPaths(dir: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return parseDirtyPaths(out).sort();
}

/**
 * Разбор остановок 23.10, D5: подготовка копии (`go mod download`) переписала
 * go.mod двух каталогов вне задачи группы, и доставка требовала закоммитить
 * чужую правку. На настоящем git: откат манифестов, дерево после подготовки чистое.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

describe('подготовка копии не оставляет правок в отслеживаемых файлах', () => {
  let dir: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-prep-left-'));
    run('init', '-q', '-b', 'feature/users');
    mkdirSync(join(dir, 'cp-ca'), { recursive: true });
    mkdirSync(join(dir, 'gen'), { recursive: true });
    writeFileSync(join(dir, 'go.mod'), 'module root\n\ngo 1.22\n');
    writeFileSync(join(dir, 'cp-ca', 'go.mod'), 'module ca\n\ngo 1.22\n');
    writeFileSync(join(dir, 'cp-ca', 'go.sum'), 'a v1 h1:x\n');
    writeFileSync(join(dir, 'gen', 'schema.ts'), 'export {};\n');
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => dropTemp(dir));

  it('go.mod и go.sum, переписанные `go mod download`, откатываются; новый go.sum — убирается', async () => {
    writeFileSync(join(dir, 'go.mod'), 'module root\n\ngo 1.22\n\ntoolchain go1.23.4\n');
    writeFileSync(join(dir, 'cp-ca', 'go.mod'), 'module ca\n\ngo 1.23\n');
    writeFileSync(join(dir, 'cp-ca', 'go.sum'), 'a v1 h1:x\nb v2 h1:y\n');
    writeFileSync(join(dir, 'go.sum'), 'c v3 h1:z\n');

    const reverted = await settlePrepTree(dir);

    expect([...reverted].sort()).toEqual(['cp-ca/go.mod', 'cp-ca/go.sum', 'go.mod', 'go.sum']);
    expect(readFileSync(join(dir, 'cp-ca', 'go.mod'), 'utf8')).toBe('module ca\n\ngo 1.22\n');
    expect(existsSync(join(dir, 'go.sum'))).toBe(false);
    expect(dirtyPaths(dir)).toEqual([]);
  });
});

/**
 * F-64: повторная установка в копии посреди работы откатывала go.mod/lock-файл
 * агента. Снимок до установки (`snapshotPrepTree`) отделяет правку агента.
 */
describe('повторная установка посреди работы не трогает правки агента', () => {
  let dir: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-prep-again-'));
    run('init', '-q', '-b', 'feature/users');
    writeFileSync(join(dir, 'go.mod'), 'module root\n\ngo 1.22\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"v":1}\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(dir, 'app.ts'), 'export {};\n');
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => dropTemp(dir));

  it('грязное до установки остаётся; переписанное установкой — откатывается', async () => {
    // Работа агента: новая зависимость в go.mod и package-lock, правка кода.
    writeFileSync(join(dir, 'go.mod'), 'module root\n\ngo 1.22\n\nrequire x v1\n');
    writeFileSync(join(dir, 'package-lock.json'), '{"v":1,"dep":"x"}\n');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
    expect(await snapshotPrepTree(dir)).toBe(true);

    // Установка переписала чистый lock-файл и ещё раз тронула go.mod агента.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
    writeFileSync(
      join(dir, 'go.mod'),
      'module root\n\ngo 1.22\n\nrequire x v1\n\ntoolchain go1.23\n',
    );
    const reverted = await settlePrepTree(dir);

    expect(reverted).toEqual(['pnpm-lock.yaml']);
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n');
    expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('{"v":1,"dep":"x"}\n');
    expect(readFileSync(join(dir, 'go.mod'), 'utf8')).toContain('require x v1');
    expect(dirtyPaths(dir)).toEqual(['app.ts', 'go.mod', 'package-lock.json']);
  });

  it('снимок до установки не вышел — конец установки ничего не откатывает', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
    // Каталог не git: снимок не читается.
    const outside = mkdtempSync(join(tmpdir(), 'cc-prep-nogit-'));
    try {
      expect(await snapshotPrepTree(outside)).toBe(false);
      expect(await settlePrepTree(outside)).toEqual([]);
    } finally {
      dropTemp(outside);
    }
    // Снимок своей копии не взят — свежая копия, откат как прежде.
    expect(await settlePrepTree(dir)).toEqual(['pnpm-lock.yaml']);
  });

  /**
   * L4 (ревью 23.10): подготовка группы разделения (`split-launch`) звала
   * `run` без снимка — снимок делал только маршрут кнопки. Повторная подготовка
   * в копии с работой агента считала дерево чистым и откатывала его lock-файл.
   * Здесь — настоящий реестр с обвязкой панели и настоящая команда.
   */
  it('реестр с обвязкой панели сам снимает дерево до команды: lock-файл агента цел', async () => {
    writeFileSync(join(dir, 'package-lock.json'), '{"v":1,"dep":"x"}\n');
    const scripts = mkdtempSync(join(tmpdir(), 'cc-prep-cmd-'));
    const logs = mkdtempSync(join(tmpdir(), 'cc-prep-logs-'));
    try {
      const script = join(scripts, 'install.cjs').replace(/\\/g, '/');
      writeFileSync(
        script,
        "require('fs').writeFileSync('pnpm-lock.yaml', 'lockfileVersion: 10\\n');\n",
      );
      const registry = new WorktreeBootstraps(logs, PREP_TREE_HOOKS);
      const state = await registry.run(dir, `node "${script}"`);

      expect(state.status).toBe('ok');
      expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('{"v":1,"dep":"x"}\n');
      expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9\n');
      expect(dirtyPaths(dir)).toEqual(['package-lock.json']);
    } finally {
      dropTemp(scripts);
      dropTemp(logs);
    }
  });
});

const HAS_GO = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

/**
 * g9 26.10 (F8): копия, подготовленная до отката манифестов, несла `cp-ca/go.mod` и
 * `inst-telemetry/go.mod`, переписанные `go mod download` (MVS поднял версии косвенных
 * зависимостей), — две смены ветки отказали, доставка краснела «не закоммичено». Здесь
 * настоящий `go` и настоящий план подготовки: без обвязки панели go.mod грязный (значит,
 * фикстура и правда воспроизводит правку go), с обвязкой — дерево чистое.
 */
describe.runIf(HAS_GO)('настоящий go mod download при подготовке копии', () => {
  let dir: string;
  let logs: string;
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const CA_MOD =
    'module example.com/ca\n\ngo 1.21\n\nrequire (\n\texample.com/shared v0.0.0\n' +
    '\texample.com/dep v1.0.0 // indirect\n)\n\nreplace (\n\texample.com/shared => ../shared\n' +
    '\texample.com/dep => ../dep\n)\n';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-prep-go-'));
    logs = mkdtempSync(join(tmpdir(), 'cc-prep-go-logs-'));
    run('init', '-q', '-b', 'feature/users');
    const files: Record<string, string> = {
      'dep/go.mod': 'module example.com/dep\n\ngo 1.21\n',
      'dep/dep.go': 'package dep\n',
      'shared/go.mod':
        'module example.com/shared\n\ngo 1.21\n\nrequire example.com/dep v1.2.0\n\n' +
        'replace example.com/dep => ../dep\n',
      'shared/shared.go': 'package shared\n\nimport _ "example.com/dep"\n',
      'cp-ca/go.mod': CA_MOD,
      'cp-ca/ca.go': 'package ca\n\nimport _ "example.com/shared"\n',
    };
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    dropTemp(dir);
    dropTemp(logs);
  });

  it('go mod download правит go.mod модуля; обвязка панели откатывает его до работы группы', async () => {
    const plan = bootstrapPlanFor(dir);
    expect(plan?.summary).toContain('[cp-ca] go mod download');

    // Без обвязки (подготовка до 24.10): go.mod переписан, доставка видит его работой группы.
    const bare = await new WorktreeBootstraps(logs).run(dir, plan!);
    expect(bare.status).toBe('ok');
    expect(run('status', '--porcelain', '--', 'cp-ca/go.mod')).toContain('cp-ca/go.mod');
    expect(readFileSync(join(dir, 'cp-ca', 'go.mod'), 'utf8')).toContain('example.com/dep v1.2.0');
    run('checkout', '--', '.');

    const state = await new WorktreeBootstraps(logs, PREP_TREE_HOOKS).run(dir, plan!);
    expect(state.status).toBe('ok');
    expect(state.reverted).toContain('cp-ca/go.mod');
    expect(readFileSync(join(dir, 'cp-ca', 'go.mod'), 'utf8')).toBe(CA_MOD);
    expect(run('status', '--porcelain')).toBe('');
  }, 120_000);
});
