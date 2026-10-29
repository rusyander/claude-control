import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolStamp } from './tool-version.ts';

/**
 * Отпечаток установленного инструмента в ключе (D§3.3): без запуска, по файлу, который исполнится.
 * Сменился файл — сменился отпечаток (node 20 → 22 без `.nvmrc` больше не делит ключ).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tool-stamp-'));
  dirs.push(d);
  return d;
};

describe('platform/tool-version toolStamp', () => {
  const nodeDir = dirname(process.execPath);
  const nodeName = basename(process.execPath).replace(/\.exe$/i, '');

  it('stamps the resolved binary by size and mtime; a replaced binary is a new stamp', () => {
    const bin = temp();
    // Пустой исполняемый файл: искать его будут, запускать — нет.
    const tool = join(bin, `fake-tool${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(tool, '');
    chmodSync(tool, 0o755);
    const env = { PATH: bin };
    const before = toolStamp('fake-tool', temp(), env);
    expect(before).toEqual({ value: expect.stringMatching(/^0:\d+$/) });
    utimesSync(tool, new Date(), new Date(Date.now() + 60_000));
    expect(toolStamp('fake-tool', temp(), env)).not.toEqual(before);
    writeFileSync(tool, 'x');
    expect(toolStamp('fake-tool', temp(), env)).toEqual({
      value: expect.stringMatching(/^1:\d+$/),
    });
  });

  it('a tool not on PATH is the fact `absent`; one inside the copy is `repo` (its content is in the tree key)', () => {
    expect(toolStamp('agentdeck-no-such-tool', temp(), { PATH: temp() })).toEqual({
      value: 'absent',
    });
    expect(toolStamp(nodeName, nodeDir, { PATH: nodeDir })).toEqual({ value: 'repo' });
  });

  const exe = process.platform === 'win32' ? '.exe' : '';
  const fakeTool = (dir: string, name: string): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}${exe}`);
    writeFileSync(file, '');
    chmodSync(file, 0o755);
    return file;
  };

  it('B1r3-F02 a relative command (`./mytool`) is looked up in the copy whatever the core cwd is', () => {
    const copy = temp();
    // Скрипт с расширением node — исполняемый файл на любой ОС без обёртки.
    writeFileSync(join(copy, 'mytool.mjs'), '#!/usr/bin/env node\n');
    chmodSync(join(copy, 'mytool.mjs'), 0o755);
    // Ядро стоит в чужом каталоге (cwd процесса vitest — apps/core): ответ тот же — `repo`.
    expect(toolStamp('./mytool.mjs', copy, { PATH: temp() })).toEqual({ value: 'repo' });
  });

  it('the profile name `maven` is stamped by the `mvn` binary, never a constant absent', () => {
    const bin = temp();
    fakeTool(bin, 'mvn');
    expect(toolStamp('maven', temp(), { PATH: bin })).toEqual({
      value: expect.stringMatching(/^0:\d+$/),
    });
  });

  it.runIf(process.platform === 'win32')(
    'a .bat wrapper the core will not run is still stamped by stat, not unknown forever',
    () => {
      const bin = temp();
      writeFileSync(join(bin, 'gradle.bat'), '@echo off\r\n');
      const env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      expect(toolStamp('gradle', temp(), env)).toEqual({
        value: expect.stringMatching(/^\d+:\d+$/),
      });
    },
  );

  it('a version-manager shim is stamped together with the manager selection: global file and *_VERSION', () => {
    const home = temp();
    const root = join(home, '.pyenv');
    fakeTool(join(root, 'shims'), 'python');
    const env = { PATH: join(root, 'shims'), HOME: home, USERPROFILE: home, PYENV_ROOT: root };
    writeFileSync(join(root, 'version'), '3.11\n');
    const v311 = toolStamp('python', temp(), env);
    writeFileSync(join(root, 'version'), '3.12.1\n');
    const v312 = toolStamp('python', temp(), env);
    expect(v312).not.toEqual(v311);
    expect(toolStamp('python', temp(), { ...env, PYENV_VERSION: '3.13' })).not.toEqual(v312);
    // Не шим — выбор менеджера в отпечаток не входит.
    const plain = temp();
    fakeTool(plain, 'python');
    expect(toolStamp('python', temp(), { ...env, PATH: plain })).toEqual({
      value: expect.stringMatching(/^0:\d+$/),
    });
  });
});
