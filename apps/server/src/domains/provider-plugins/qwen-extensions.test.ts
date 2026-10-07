import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { spawn as nodeSpawn } from 'node:child_process';
import {
  installQwenExtension,
  parseExtensionSource,
  parseQwenExtensionsList,
  readQwenExtensions,
  readQwenExtensionsInfo,
  setQwenExtensionEnabled,
  uninstallQwenExtension,
  withQwenEnabledState,
} from './qwen-extensions.ts';
import { createQwenCliRun, type QwenCliResult, type QwenCliRun } from './plugin-cli.ts';
import {
  InvalidExtensionSourceError,
  QwenCliFailedError,
  QwenCliUnavailableError,
  QwenExtensionNotFoundError,
  describePluginError,
} from './errors.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Расширения Qwen (MAP 25). Манифесты — на временном каталоге, CLI — подменённый
 * запуск: здесь проверяется разбор и то, КАКИЕ аргументы уходят в CLI. Что CLI
 * с ними делает, проверяет живой прогон с настоящим qwen
 * (`tools/qa/check-qwen-extensions.mjs`).
 */

let root: string;
let dir: string;

const target = (): ProviderPluginsTarget =>
  ({
    provider: { id: 'qwen', name: 'Qwen Code' },
    format: 'qwen-extensions',
    scope: 'global',
    pluginsDir: dir,
    backupPrefix: 'qwen-',
  }) as unknown as ProviderPluginsTarget;

const base = () => ({
  providerId: 'qwen',
  providerName: 'Qwen Code',
  format: 'qwen-extensions' as const,
  scope: 'global' as const,
  pluginsDir: dir,
  dirExists: true,
});

function extension(name: string, manifest: Record<string, unknown>, extra: string[] = []): void {
  const extRoot = join(dir, name);
  mkdirSync(extRoot, { recursive: true });
  writeFileSync(join(extRoot, 'qwen-extension.json'), JSON.stringify({ name, ...manifest }));
  for (const sub of extra) mkdirSync(join(extRoot, sub), { recursive: true });
}

/** Подменённый CLI: запоминает аргументы, отвечает заданным. */
function fakeRun(answer: Partial<QwenCliResult> = {}): QwenCliRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer };
  }) as unknown as QwenCliRun & { calls: string[][] };
  run.calls = calls;
  return run;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qwen-ext-'));
  dir = join(root, 'extensions');
  mkdirSync(dir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('readQwenExtensions: манифесты каталога', () => {
  it('читает поля манифеста, состав и метаданные установки', () => {
    extension(
      'alpha',
      {
        version: '0.1.0',
        description: { en: 'Alpha ext', zh: '阿尔法' },
        contextFileName: 'ALPHA.md',
        mcpServers: { db: { command: 'x' } },
      },
      ['commands', 'skills/s1', 'agents'],
    );
    writeFileSync(
      join(dir, 'alpha', '.qwen-extension-install.json'),
      JSON.stringify({ source: 'C:/src/alpha', type: 'local', originSource: 'QwenCode' }),
    );
    extension('beta', { version: '2.0.0', description: 'Beta' });
    writeFileSync(join(dir, 'beta', 'QWEN.md'), 'ctx');
    writeFileSync(join(dir, 'extension-enablement.json'), '{}');

    const [alpha, beta] = readQwenExtensions(dir);
    expect(alpha).toMatchObject({
      id: 'alpha',
      name: 'alpha',
      version: '0.1.0',
      description: 'Alpha ext',
      mcpServers: ['db'],
      hasCommands: true,
      hasSkills: true,
      hasAgents: true,
      contextFiles: ['ALPHA.md'],
      source: 'C:/src/alpha',
      sourceType: 'local',
    });
    expect(alpha!.enabled).toBeUndefined();
    expect(beta).toMatchObject({ id: 'beta', hasCommands: false, contextFiles: ['QWEN.md'] });
  });

  it('связанное расширение читается у источника; без манифеста — строка с ошибкой', () => {
    const source = join(root, 'linked-src');
    mkdirSync(join(source, 'commands'), { recursive: true });
    writeFileSync(join(source, 'qwen-extension.json'), JSON.stringify({ name: 'linked' }));
    mkdirSync(join(dir, 'linked'));
    writeFileSync(
      join(dir, 'linked', '.qwen-extension-install.json'),
      JSON.stringify({ source, type: 'link' }),
    );
    mkdirSync(join(dir, 'broken'));

    const [broken, linked] = readQwenExtensions(dir);
    expect(broken!.error).toMatch(/не найден/);
    expect(linked).toMatchObject({ name: 'linked', hasCommands: true, sourceType: 'link' });
  });

  it('сводка: только «установленное», действия разрешены', () => {
    extension('alpha', {});
    const info = readQwenExtensionsInfo(target(), base());
    expect(info.sections).toEqual(['installed']);
    expect(info.installedActions).toBe(true);
    expect(info.installed.map((plugin) => plugin.id)).toEqual(['alpha']);
  });
});

/** Настоящий вывод `qwen extensions list` 0.25 (русская локаль), снятый пробой. */
const LIST = (base: string) =>
  [
    '✗ alpha (0.1.0)',
    ' Описание: Alpha ext',
    ` Путь: ${base}\\alpha`,
    ' Источник: C:\\src-a (Тип: local)',
    ' Включено (Пользователь): false',
    ' Контекстные файлы:',
    `  ${base}\\alpha\\ALPHA.md`,
    '✓ alphabet (1.0.0)',
    ` Path: ${base}\\alphabet`,
    '✓ renamed (1.0.0)',
    ' Путь: D:\\elsewhere\\renamed',
  ].join('\r\n');

describe('parseQwenExtensionsList: отметки ✓/✗', () => {
  it('ключ — строка пути каталога, имя заголовка — запасной', () => {
    extension('alpha', {});
    extension('alphabet', {});
    extension('renamed-dir', { name: 'renamed' });
    const installed = readQwenExtensions(dir);
    const states = parseQwenExtensionsList(LIST(dir.replace(/\//g, '\\')), dir, installed);
    expect(Object.fromEntries(states)).toEqual({
      alpha: false,
      alphabet: true,
      'renamed-dir': true,
    });
  });

  it('withQwenEnabledState: сбой CLI — причина, а не выдуманное «включено»', async () => {
    extension('alpha', {});
    const info = readQwenExtensionsInfo(target(), base());
    const failed = await withQwenEnabledState(info, fakeRun({ code: 1, stderr: 'boom' }));
    expect(failed.installedStateError).toBe('boom');
    expect(failed.installed[0]!.enabled).toBeUndefined();

    const run = fakeRun({ stdout: LIST(dir) });
    const ok = await withQwenEnabledState(info, run);
    expect(run.calls).toEqual([['list']]);
    expect(ok.installed[0]!.enabled).toBe(false);
  });

  it('пустой каталог — CLI не запускается', async () => {
    const run = fakeRun();
    await withQwenEnabledState(readQwenExtensionsInfo(target(), base()), run);
    expect(run.calls).toEqual([]);
  });
});

describe('действия: аргументы CLI и отказы', () => {
  it('источник: одна строка, без флага в начале, до 1000 символов', () => {
    expect(parseExtensionSource('  https://github.com/o/r  ')).toBe('https://github.com/o/r');
    for (const bad of ['', '   ', '--help', '-x', 'a\nb', 'a\u0000b', 'x'.repeat(1001), 42, null]) {
      expect(() => parseExtensionSource(bad), String(bad)).toThrow(InvalidExtensionSourceError);
    }
  });

  it('install идёт с --consent; enable/disable — со --scope user; uninstall по имени', async () => {
    extension('alpha', {});
    const run = fakeRun({ stdout: 'Extension "alpha" installed successfully and enabled.' });
    await expect(installQwenExtension(run, 'C:/src/alpha')).resolves.toMatch(/installed/);
    await setQwenExtensionEnabled(target(), run, 'alpha', false);
    await setQwenExtensionEnabled(target(), run, 'alpha', true);
    await uninstallQwenExtension(target(), run, 'alpha');
    expect(run.calls).toEqual([
      ['install', '--consent', 'C:/src/alpha'],
      ['disable', '--scope', 'user', 'alpha'],
      ['enable', '--scope', 'user', 'alpha'],
      ['uninstall', 'alpha'],
    ]);
  });

  it('имя не из установленного — 404 до запуска CLI', async () => {
    const run = fakeRun();
    await expect(uninstallQwenExtension(target(), run, '../evil')).rejects.toThrow(
      QwenExtensionNotFoundError,
    );
    expect(run.calls).toEqual([]);
  });

  it('отказ CLI приезжает его словами; не запустился — 503', async () => {
    await expect(
      installQwenExtension(fakeRun({ code: 1, stderr: 'Extension already installed.' }), 'x'),
    ).rejects.toThrow(/already installed/);
    await expect(
      installQwenExtension(fakeRun({ timedOut: true, code: null }), 'x'),
    ).rejects.toThrow(QwenCliFailedError);
    const unavailable = installQwenExtension(fakeRun({ spawnError: 'ENOENT' }), 'x');
    await expect(unavailable).rejects.toThrow(QwenCliUnavailableError);
    expect(describePluginError(new QwenCliUnavailableError('ENOENT'))?.status).toBe(503);
    expect(describePluginError(new QwenCliFailedError('no'))?.body).toMatchObject({
      messageCode: 'qwen-extension-cli-failed',
      params: { reason: 'no' },
    });
  });
});

describe('createQwenCliRun: процесс', () => {
  /** Подменённый spawn: пишет вывод и закрывается с кодом, либо висит. */
  function fakeSpawn(behaviour: { stdout?: string; code?: number; hang?: boolean }) {
    const seen: { args: string[]; cwd?: string }[] = [];
    const impl = ((_command: string, args: string[], options: { cwd?: string }) => {
      seen.push({ args, cwd: options.cwd });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        stdin: new PassThrough(),
        pid: undefined,
        kill: () => {
          child.emit('close', null);
          return true;
        },
      });
      if (!behaviour.hang) {
        setImmediate(() => {
          stdout.end(behaviour.stdout ?? '');
          stderr.end();
          child.emit('close', behaviour.code ?? 0);
        });
      }
      return child;
    }) as unknown as typeof nodeSpawn;
    return { impl, seen };
  }

  it('аргументы предварены «extensions», вывод собран, код передан', async () => {
    const { impl, seen } = fakeSpawn({ stdout: '✓ a (1)', code: 0 });
    const run = createQwenCliRun(process.execPath, { spawnImpl: impl, cwd: root });
    const result = await run(['list'], 5_000);
    expect(seen[0]).toEqual({ args: ['extensions', 'list'], cwd: root });
    expect(result).toMatchObject({ code: 0, stdout: '✓ a (1)', timedOut: false });
  });

  it('потолок времени останавливает процесс и помечает timedOut', async () => {
    const { impl } = fakeSpawn({ hang: true });
    const result = await createQwenCliRun(process.execPath, { spawnImpl: impl })(['list'], 20);
    expect(result.timedOut).toBe(true);
  });
});
