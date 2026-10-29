import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeExecutable } from '../../platform/exec-bit.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { DEFAULT_NODE_ARGV } from './road.ts';
import { installContainerWrappers, WRAPPER_DIR } from './hook-file.ts';

/**
 * Обёртки движков контейнеров живьём (01 §Resources, P58): поддельный `docker` печатает свой
 * argv, обёртка сессии исполняется так, как её зовёт CLI — sh (Bash-инструмент Claude, Git Bash)
 * и на Windows `cmd` (оболочка Qwen, PATHEXT находит `docker.cmd`). Подменён только движок —
 * внешняя граница; разбор, node ядра и файлы обёрток настоящие.
 */

const os = currentOs();
const TASK = '0199c82c-c000-7000-9494-c5517b88874a';
const LABEL = ['--label', `agentdeck.task=${TASK}`];
const root = mkdtempSync(join(tmpdir(), 'container wrap '));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENGINE_JS = [
  '#!/usr/bin/env node',
  'const args = process.argv.slice(2);',
  'process.stdout.write(JSON.stringify(args));',
  "process.exit(args.includes('fail') ? 3 : 0);",
  '',
].join('\n');

/** Поддельный движок: POSIX — шебанг-скрипт 0755; Windows — npm-обёртка `.cmd` над `.mjs`. */
function fakeEngine(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (os !== 'win32') {
    const written = writeExecutable(join(dir, 'docker'), ENGINE_JS, os);
    if (!written.ok) throw new Error(written.reason);
    return;
  }
  writeFileSync(join(dir, 'docker.mjs'), ENGINE_JS);
  writeFileSync(
    join(dir, 'docker.cmd'),
    [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\docker.mjs" %*',
      ') ELSE (',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\docker.mjs" %*',
      ')',
    ].join('\r\n'),
  );
}

/** sh, которым CLI исполняет команду: Git Bash на Windows (не bash WSL из System32). */
function posixShell(): string | undefined {
  if (os !== 'win32') return '/bin/sh';
  const candidates = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  return candidates.find((file): file is string => Boolean(file) && existsSync(file as string));
}

const parse = (stdout: string): unknown => JSON.parse(stdout.trim() || 'null');

describe('container wrappers of the session road, executed (P58)', () => {
  const fake = join(root, 'engine dir');
  fakeEngine(fake);
  const home = join(root, 'session');
  mkdirSync(join(home, WRAPPER_DIR), { recursive: true });
  const installed = installContainerWrappers({
    dir: home,
    taskId: TASK,
    env: { PATH: fake },
    os,
    nodeArgv: DEFAULT_NODE_ARGV,
  });
  const bin = join(home, WRAPPER_DIR);
  const sessionPath = [bin, fake, dirname(process.execPath), process.env['PATH'] ?? ''].join(
    delimiter,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: sessionPath, Path: sessionPath };
  delete env['COMPOSE_PROJECT_NAME'];

  it('only the engine found on the session PATH gets a wrapper; podman absent → none', () => {
    expect(installed).toEqual({ engines: ['docker'], failed: [] });
  });

  const shell = posixShell();
  it.runIf(shell)(
    'sh wrapper: label after global options, compose gets the task project, exit code passes through',
    () => {
      const sh = (args: string[]) =>
        spawnSync(shell!, [join(bin, 'docker').replace(/\\/g, '/'), ...args], {
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60_000,
        });
      const viaContext = sh(['--context', 'c', 'run', '--rm', 'img']);
      expect(viaContext.status, viaContext.stderr).toBe(0);
      expect(parse(viaContext.stdout)).toEqual(['--context', 'c', 'run', ...LABEL, '--rm', 'img']);
      const compose = sh(['compose', 'up', '-d']);
      expect(parse(compose.stdout)).toEqual([
        'compose',
        '--project-name',
        `agentdeck-${TASK}`,
        'up',
        '-d',
      ]);
      const plain = sh(['ps', '-a']);
      expect(parse(plain.stdout)).toEqual(['ps', '-a']);
      const failed = sh(['run', 'fail']);
      expect(failed.status).toBe(3);
      expect(parse(failed.stdout)).toEqual(['run', ...LABEL, 'fail']);
    },
  );

  it.runIf(os === 'win32')(
    'cmd finds docker.cmd in the wrapper dir first: label, compose project, exit code',
    () => {
      const cmd = (line: string) =>
        spawnSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', line], {
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60_000,
        });
      const created = cmd('docker -H tcp://x container create img');
      expect(created.status, created.stderr).toBe(0);
      expect(parse(created.stdout)).toEqual([
        '-H',
        'tcp://x',
        'container',
        'create',
        ...LABEL,
        'img',
      ]);
      const compose = cmd('docker compose -f x.yml up');
      expect(parse(compose.stdout)).toEqual([
        'compose',
        '--project-name',
        `agentdeck-${TASK}`,
        '-f',
        'x.yml',
        'up',
      ]);
      const failed = cmd('docker run fail');
      expect(failed.status).toBe(3);
    },
  );
});
