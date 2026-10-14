import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  installedNodes,
  prepareNode,
  readGoNeed,
  readNodeNeed,
  readPythonNeed,
  venvPython,
  withPathPrepend,
  type RuntimeDeps,
} from './runtimes.ts';

/**
 * Версия рантайма из файлов проекта и каталоги менеджеров версий — на
 * настоящих временных каталогах; запуск `node -v` подменён: на машине CI
 * нужных версий нет, а проверяется выбор, а не сам Node.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста не влияет.
  }
}

function fakeNode(root: string, relative: string, platform: NodeJS.Platform): string {
  const dir = join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, platform === 'win32' ? 'node.exe' : 'node'), '');
  return dir;
}

describe('версия Node из файлов проекта', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-rt-need-'));
  });
  afterEach(() => dropTemp(root));

  it('.nvmrc, .node-version, .tool-versions, volta, engines — по очереди', () => {
    writeFileSync(join(root, '.nvmrc'), 'v22.22.2\n');
    expect(readNodeNeed(root, '')).toEqual({ tool: 'node', wanted: 'v22.22.2', source: '.nvmrc' });
    rmSync(join(root, '.nvmrc'));
    writeFileSync(join(root, '.tool-versions'), 'nodejs 20.17.0\npython 3.12.1\n');
    expect(readNodeNeed(root, '')?.wanted).toBe('20.17.0');
    rmSync(join(root, '.tool-versions'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ engines: { node: '>=22.22.2 <23' } }),
    );
    expect(readNodeNeed(root, '')).toEqual({
      tool: 'node',
      wanted: '>=22.22.2 <23',
      source: 'package.json engines',
    });
  });

  it('алиас (lts/*) — не требование, идём к следующему источнику', () => {
    writeFileSync(join(root, '.nvmrc'), 'lts/*\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '^22.0.0' } }));
    expect(readNodeNeed(root, '')?.source).toBe('package.json engines');
  });

  it('ближайший к каталогу шага файл важнее корневого', () => {
    mkdirSync(join(root, 'web'));
    writeFileSync(join(root, '.nvmrc'), '20\n');
    writeFileSync(join(root, 'web', '.nvmrc'), '22\n');
    expect(readNodeNeed(root, 'web')).toMatchObject({ wanted: '22', source: 'web/.nvmrc' });
    mkdirSync(join(root, 'admin'));
    expect(readNodeNeed(root, 'admin')).toMatchObject({ wanted: '20', source: '.nvmrc' });
  });

  it('требования нет — undefined', () => {
    expect(readNodeNeed(root, '')).toBeUndefined();
  });
});

describe('версия Python и Go из файлов проекта', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-rt-py-'));
  });
  afterEach(() => dropTemp(root));

  it('.python-version, requires-python, poetry, Pipfile, runtime.txt', () => {
    writeFileSync(join(root, '.python-version'), '3.12\n');
    expect(readPythonNeed(root, '')).toMatchObject({ wanted: '3.12', source: '.python-version' });
    rmSync(join(root, '.python-version'));
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11,<3.13"\n');
    expect(readPythonNeed(root, '')).toMatchObject({ wanted: '>=3.11,<3.13' });
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "*"\n',
    );
    expect(readPythonNeed(root, '')).toMatchObject({ wanted: '^3.10' });
    rmSync(join(root, 'pyproject.toml'));
    writeFileSync(join(root, 'Pipfile'), '[requires]\npython_version = "3.9"\n');
    expect(readPythonNeed(root, '')).toMatchObject({ wanted: '3.9', source: 'Pipfile' });
    rmSync(join(root, 'Pipfile'));
    writeFileSync(join(root, 'runtime.txt'), 'python-3.11.4\n');
    expect(readPythonNeed(root, '')).toMatchObject({ wanted: '3.11.4' });
  });

  it('go.mod: директива go — нижняя граница', () => {
    mkdirSync(join(root, 'svc'));
    writeFileSync(join(root, 'svc', 'go.mod'), 'module x\n\ngo 1.25.0\n\ntoolchain go1.25.3\n');
    expect(readGoNeed(root, 'svc')).toMatchObject({ tool: 'go', wanted: '>=1.25.0' });
    expect(readGoNeed(root, '')).toBeUndefined();
  });
});

describe('где стоит Node: менеджеры версий', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-rt-home-'));
  });
  afterEach(() => dropTemp(home));

  const deps = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): RuntimeDeps => ({
    exec: async () => undefined,
    env,
    platform,
    home,
  });

  it('nvm-windows (NVM_HOME), fnm и volta на Windows', () => {
    fakeNode(home, 'nvm/v22.21.1', 'win32');
    fakeNode(home, 'nvm/v20.17.0', 'win32');
    fakeNode(home, 'local/fnm/node-versions/v22.22.2/installation', 'win32');
    fakeNode(home, 'local/Volta/tools/image/node/18.20.4', 'win32');
    const found = installedNodes(
      deps('win32', { NVM_HOME: join(home, 'nvm'), LOCALAPPDATA: join(home, 'local') }),
    );
    expect(found.map((item) => `${item.manager} ${item.text}`).sort()).toEqual([
      'fnm 22.22.2',
      'nvm-windows 20.17.0',
      'nvm-windows 22.21.1',
      'volta 18.20.4',
    ]);
  });

  it('nvm, asdf и nodenv на POSIX — исполняемый файл в bin', () => {
    fakeNode(home, '.nvm/versions/node/v22.22.2/bin', 'linux');
    fakeNode(home, '.asdf/installs/nodejs/20.17.0/bin', 'linux');
    fakeNode(home, '.nodenv/versions/18.20.4/bin', 'linux');
    const found = installedNodes(deps('linux'));
    expect(found.map((item) => `${item.manager} ${item.text}`).sort()).toEqual([
      'asdf 20.17.0',
      'nodenv 18.20.4',
      'nvm 22.22.2',
    ]);
    expect(found.find((item) => item.manager === 'nvm')?.dir).toBe(
      join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin'),
    );
  });

  it('каталог без исполняемого файла версией не считается', () => {
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin'), { recursive: true });
    expect(installedNodes(deps('linux'))).toEqual([]);
  });
});

describe('prepareNode: подготовка на версии проекта', () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-rt-prep-'));
    home = mkdtempSync(join(tmpdir(), 'cc-rt-prep-home-'));
  });
  afterEach(() => {
    dropTemp(root);
    dropTemp(home);
  });

  function withDefault(version: string | undefined, env: NodeJS.ProcessEnv = {}): RuntimeDeps {
    return {
      exec: async (file) => (file === 'node' && version ? `v${version}` : undefined),
      env: { PATH: '/usr/bin', ...env },
      platform: 'linux',
      home,
    };
  }

  it('на Node 24 при .nvmrc 22 берёт установленный 22 и ставит его впереди PATH', async () => {
    writeFileSync(join(root, '.nvmrc'), '22\n');
    const dir = fakeNode(home, '.nvm/versions/node/v22.22.2/bin', 'linux');
    fakeNode(home, '.nvm/versions/node/v22.9.0/bin', 'linux');
    const prepared = await prepareNode(root, '', withDefault('24.13.0'));
    expect(prepared?.note).toMatchObject({
      tool: 'node',
      status: 'switched',
      used: '22.22.2',
      found: '24.13.0',
      wanted: '22',
      source: '.nvmrc',
    });
    expect(prepared?.env.PATH?.startsWith(`${dir}${delimiter}`)).toBe(true);
  });

  it('версия по умолчанию подходит — окружение не трогаем', async () => {
    writeFileSync(join(root, '.nvmrc'), '22\n');
    const deps = withDefault('22.21.1');
    const prepared = await prepareNode(root, '', deps);
    expect(prepared?.note).toMatchObject({ status: 'ok', used: '22.21.1' });
    expect(prepared?.env).toBe(deps.env);
  });

  it('подходящей на машине нет — missing, а не молчаливый запуск', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ engines: { node: '>=22.22.2 <23' } }),
    );
    fakeNode(home, '.nvm/versions/node/v22.21.1/bin', 'linux');
    const prepared = await prepareNode(root, '', withDefault('24.13.0'));
    expect(prepared?.note).toMatchObject({
      status: 'missing',
      wanted: '>=22.22.2 <23',
      found: '24.13.0',
      source: 'package.json engines',
    });
  });

  it('требования нет или запись не понята — undefined', async () => {
    expect(await prepareNode(root, '', withDefault('24.13.0'))).toBeUndefined();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: 'weird?' } }));
    expect(await prepareNode(root, '', withDefault('24.13.0'))).toBeUndefined();
  });
});

describe('мелочи окружения', () => {
  it('PATH дописывается под тем регистром ключа, что у системы (Path на Windows)', () => {
    const env = withPathPrepend({ Path: 'C:/a', OTHER: '1' }, 'C:/node22');
    expect(env.Path).toBe(`C:/node22${delimiter}C:/a`);
    expect('PATH' in env).toBe(false);
  });

  it('интерпретатор venv — один путь на систему', () => {
    expect(venvPython('/x/.venv', 'win32')).toBe(join('/x/.venv', 'Scripts', 'python.exe'));
    expect(venvPython('/x/.venv', 'linux')).toBe(join('/x/.venv', 'bin', 'python'));
  });
});
