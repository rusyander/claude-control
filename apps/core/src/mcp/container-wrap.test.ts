import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_CALLS_FILE,
  decodeWrapSpec,
  labelledArgv,
  ownProject,
  runContainerWrapper,
  unlabelledCall,
} from './container-wrap.ts';

/**
 * Разбор обёртки движка контейнеров (01 §Resources, P58): метка задачи на `run`/`create` после
 * глобальных опций движка, проект задачи у `compose` без своего проекта, остальное — как есть.
 */

const ID = '0199c82c-c000-7000-9494-c5517b88874a';
const LABEL = ['--label', `agentdeck.task=${ID}`];
const PROJECT = ['--project-name', `agentdeck-${ID}`];

describe('container wrapper argv (P58)', () => {
  it('run/create get the task label, also after global options with a value, a flag or name=value', () => {
    expect(labelledArgv('docker', ['run', '--rm', 'img'], ID)).toEqual([
      'run',
      ...LABEL,
      '--rm',
      'img',
    ]);
    expect(labelledArgv('docker', ['--context', 'run', '-D', 'create', 'img'], ID)).toEqual([
      '--context',
      'run',
      '-D',
      'create',
      ...LABEL,
      'img',
    ]);
    expect(labelledArgv('docker', ['-H', 'tcp://h:2375', '--tls', 'run', 'img'], ID)).toEqual([
      '-H',
      'tcp://h:2375',
      '--tls',
      'run',
      ...LABEL,
      'img',
    ]);
    expect(labelledArgv('docker', ['--log-level=debug', 'run', 'img'], ID)).toEqual([
      '--log-level=debug',
      'run',
      ...LABEL,
      'img',
    ]);
    expect(labelledArgv('podman', ['--root', '/r', '--remote', 'create', 'img'], ID)).toEqual([
      '--root',
      '/r',
      '--remote',
      'create',
      ...LABEL,
      'img',
    ]);
  });

  it('container run|create get the label; other subcommands and no subcommand stay as they are', () => {
    expect(labelledArgv('docker', ['-c', 'x', 'container', 'run', 'img'], ID)).toEqual([
      '-c',
      'x',
      'container',
      'run',
      ...LABEL,
      'img',
    ]);
    expect(labelledArgv('docker', ['container', 'ls', '-a'], ID)).toEqual([
      'container',
      'ls',
      '-a',
    ]);
    expect(labelledArgv('docker', ['ps', 'run'], ID)).toEqual(['ps', 'run']);
    expect(labelledArgv('docker', ['--version'], ID)).toEqual(['--version']);
    expect(labelledArgv('docker', [], ID)).toEqual([]);
  });

  it('compose gets the task project unless it names its own (flag before the subcommand or COMPOSE_PROJECT_NAME)', () => {
    expect(labelledArgv('docker', ['compose', 'up', '-d'], ID)).toEqual([
      'compose',
      ...PROJECT,
      'up',
      '-d',
    ]);
    expect(
      labelledArgv('docker', ['--context', 'c', 'compose', '-f', 'x.yml', 'run', 'web'], ID),
    ).toEqual(['--context', 'c', 'compose', ...PROJECT, '-f', 'x.yml', 'run', 'web']);
    for (const own of [
      ['-p', 'mine'],
      ['--project-name', 'mine'],
      ['--project-name=mine'],
      ['-pmine'],
    ]) {
      expect(labelledArgv('docker', ['compose', ...own, 'up'], ID)).toEqual([
        'compose',
        ...own,
        'up',
      ]);
    }
    // `-p` после подкоманды — опция подкоманды (`run -p 80:80`), не имя проекта.
    expect(labelledArgv('docker', ['compose', 'run', '-p', '80:80', 'web'], ID)).toEqual([
      'compose',
      ...PROJECT,
      'run',
      '-p',
      '80:80',
      'web',
    ]);
    expect(labelledArgv('docker', ['compose', 'up'], ID, { COMPOSE_PROJECT_NAME: 'mine' })).toEqual(
      ['compose', 'up'],
    );
  });
});

describe('container wrapper label gaps (G18)', () => {
  it('docker-compose (v1) gets the task project like `docker compose`; its own -p is kept', () => {
    expect(labelledArgv('docker-compose', ['-f', 'x.yml', 'up', '-d'], ID)).toEqual([
      ...PROJECT,
      '-f',
      'x.yml',
      'up',
      '-d',
    ]);
    expect(labelledArgv('docker-compose', ['-p', 'mine', 'up'], ID)).toEqual(['-p', 'mine', 'up']);
  });

  it('podman pod create gets the label; pod ps and pod run-likes do not', () => {
    expect(labelledArgv('podman', ['pod', 'create', '--name', 'p'], ID)).toEqual([
      'pod',
      'create',
      ...LABEL,
      '--name',
      'p',
    ]);
    expect(labelledArgv('podman', ['pod', 'ps'], ID)).toEqual(['pod', 'ps']);
    expect(labelledArgv('docker', ['pod', 'create'], ID)).toEqual(['pod', 'create']);
  });

  it('unlabelled calls: a self-named compose project (flag or env), kube play / play kube; labelled ones → none', () => {
    expect(unlabelledCall('docker', ['compose', '-p', 'x', 'up'])).toEqual({
      kind: 'compose-project',
      project: 'x',
    });
    expect(unlabelledCall('docker-compose', ['up'], { COMPOSE_PROJECT_NAME: 'y' })).toEqual({
      kind: 'compose-project',
      project: 'y',
    });
    expect(unlabelledCall('docker', ['compose', 'up'])).toBeUndefined();
    expect(unlabelledCall('podman', ['--log-level', 'info', 'kube', 'play', 'a.yml'])).toEqual({
      kind: 'created-during',
    });
    expect(unlabelledCall('podman', ['play', 'kube', 'a.yml'])).toEqual({
      kind: 'created-during',
    });
    expect(unlabelledCall('docker', ['run', 'img'])).toBeUndefined();
    expect(unlabelledCall('podman', ['run', 'img'])).toBeUndefined();
  });

  it('own project is read only before the compose subcommand', () => {
    const args = ['compose', '--project-name=a', 'up'];
    expect(ownProject(args, 1, 2)).toBe('a');
    expect(ownProject(['compose', 'run', '-p', '80:80'], 1, 1)).toBeUndefined();
    expect(ownProject(['compose', 'up'], 1, 1, { COMPOSE_PROJECT_NAME: '' })).toBeUndefined();
  });

  it('an empty own project name (`-p ""`, `--project-name=`) is not a name: the task project replaces it, env still wins', () => {
    // Живой compose v5: пустой флаг → имя каталога, а с COMPOSE_PROJECT_NAME=x → x.
    expect(labelledArgv('docker', ['compose', '-p', '', 'up', '-d'], ID)).toEqual([
      'compose',
      ...PROJECT,
      'up',
      '-d',
    ]);
    expect(labelledArgv('docker', ['compose', '--project-name=', 'up'], ID)).toEqual([
      'compose',
      ...PROJECT,
      'up',
    ]);
    expect(unlabelledCall('docker', ['compose', '-p', '', 'up'])).toBeUndefined();
    const env = { COMPOSE_PROJECT_NAME: 'x' };
    expect(labelledArgv('docker', ['compose', '-p', '', 'up'], ID, env)).toEqual([
      'compose',
      '-p',
      '',
      'up',
    ]);
    expect(unlabelledCall('docker', ['compose', '-p', '', 'up'], env)).toEqual({
      kind: 'compose-project',
      project: 'x',
    });
  });

  it('kube play records only what it created: containers of its new unlabelled pods, never a foreign container or labelled pod', async () => {
    const fx = mkdtempSync(join(tmpdir(), 'agentdeck-kube-'));
    try {
      const hex = (n: string): string => n.padStart(12, '0');
      // Поддельный движок: до вызова — контейнер и под человека; за вызов — под и контейнер
      // kube play, контейнер другой задачи и её помеченный под (создались в то же окно).
      const engine = join(fx, 'engine.mjs');
      writeFileSync(
        engine,
        [
          "import { existsSync, writeFileSync } from 'node:fs';",
          "const st = new URL('./played', import.meta.url);",
          "const a = process.argv.slice(2).join(' ');",
          'const after = existsSync(st);',
          'const out = (ids) => process.stdout.write(ids.map((i) => i + "\\n").join(""));',
          `if (a === 'kube play x.yml') writeFileSync(st, '1');`,
          `else if (a === 'ps -a -q') out(after ? ['${hex('a0')}', '${hex('f1')}', '${hex('c1')}'] : ['${hex('a0')}']);`,
          `else if (a === 'pod ps -q') out(after ? ['${hex('b0')}', '${hex('b3')}', '${hex('b2')}'] : ['${hex('b0')}']);`,
          `else if (a === 'pod ps -q --filter label=agentdeck.task') out(['${hex('b3')}']);`,
          `else if (a === 'ps -a -q --filter pod=${hex('b2')}') out(['${hex('c1')}']);`,
          `else { process.stderr.write('unexpected: ' + a + '\\n'); process.exit(3); }`,
        ].join('\n'),
      );
      const spec = Buffer.from(
        JSON.stringify({ real: [process.execPath, engine], dir: fx }),
        'utf8',
      ).toString('base64url');
      const code = await runContainerWrapper(['podman', ID, spec, 'kube', 'play', 'x.yml']);
      expect(code).toBe(0);
      const rows = readFileSync(join(fx, CONTAINER_CALLS_FILE), 'utf8').trim().split('\n');
      expect(rows.map((r) => JSON.parse(r) as unknown)).toEqual([
        expect.objectContaining({
          engine: 'podman',
          kind: 'created-during',
          containers: [hex('c1')],
          pods: [hex('b2')],
        }),
      ]);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  it('wrap spec: {real, dir} or the older bare argv array; anything else is refused', () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    expect(decodeWrapSpec(enc({ real: ['/bin/docker'], dir: '/s' }))).toEqual({
      real: ['/bin/docker'],
      dir: '/s',
    });
    expect(decodeWrapSpec(enc(['/bin/docker']))).toEqual({ real: ['/bin/docker'] });
    expect(decodeWrapSpec(enc({ real: [1] }))).toBeUndefined();
    expect(decodeWrapSpec('%%%')).toBeUndefined();
  });
});
