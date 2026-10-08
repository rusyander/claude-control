import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import { openProjectStand, type ProjectStand } from '../project-actions.harness.ts';
import {
  freeTcpPort,
  isAlive,
  killQuietly,
  spawnChildListener,
  spawnOrphanListener,
  waitListening,
} from '../port-holders.harness.ts';

/**
 * Dev-серверы и код проекта руками агента (U4a): настоящий реестр запускает
 * настоящий node-сервер из ВРЕМЕННОГО проекта, `free_port` гасит настоящий
 * чужой процесс, а порт самого процесса панели (здесь — процесса теста) агент
 * не трогает никогда. Код агент только читает — секреты и блоки PEM маской.
 */

const LIVE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';
// Короткая последняя строка блока: детектор строк её не узнаёт, прячет только маска PEM целиком.
const PEM_TAIL = 'u4aTAIL9xQ==';

const SERVER_JS = `const http = require('node:http');
const port = Number(process.env.PORT || 0);
const server = http.createServer((_req, res) => res.end('ok'));
server.listen(port, '127.0.0.1', () => {
  console.log('ready on http://localhost:' + server.address().port);
});
`;

const until = async <T>(read: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('panel-agent actions: project runner and code', () => {
  let stand: ProjectStand;
  let child: ChildProcess | undefined;
  let own: Server | undefined;
  const orphans: number[] = [];

  beforeEach(async () => {
    stand = await openProjectStand();
    writeFileSync(
      join(stand.projectDir, 'package.json'),
      JSON.stringify({ name: 'u4a-app', scripts: { dev: 'node server.js' } }),
    );
    writeFileSync(join(stand.projectDir, 'server.js'), SERVER_JS);
  });
  afterEach(async () => {
    child?.kill();
    child = undefined;
    for (const pid of orphans.splice(0)) killQuietly(pid);
    if (own) await new Promise((done) => own!.close(done));
    own = undefined;
    await stand.close();
  });

  const running = async () =>
    (await stand.app.inject({ method: 'GET', url: '/api/project-runner' })).json<
      ProjectRunnerView[]
    >();

  it('порт, автозапуск, запуск и остановка dev-сервера — карточки и живой процесс', async () => {
    const described = await stand.call('describe_project_runner', { project: stand.projectId });
    expect(described.outcome).toBe('done');
    expect(described.result).toMatchObject({
      targets: [expect.objectContaining({ runnable: true, autostart: false })],
    });

    const port = await freeTcpPort();
    const pinned = await stand.decided('save_project_runner_settings', {
      project: stand.projectId,
      port,
    });
    expect(pinned.card.risk).toBe('danger');
    expect(pinned.result.outcome).toBe('done');

    const auto = await stand.decided('set_project_runner_autostart', {
      project: stand.projectId,
      enabled: true,
    });
    expect(auto.card.risk).toBe('danger');
    expect(auto.result.outcome).toBe('done');
    const after = await stand.call('describe_project_runner', { project: stand.projectId });
    expect(after.result).toMatchObject({
      targets: [expect.objectContaining({ pinnedPort: port, autostart: true })],
    });

    const started = await stand.decided('start_project_runner', { project: stand.projectId });
    expect(started.card.risk).toBe('danger');
    expect(started.card.preview.summary).toBeTruthy();
    expect(started.result.outcome).toBe('done');
    await until(async () => {
      const view = (await running()).find((item) => item.status === 'running');
      return view?.port === port ? view : undefined;
    }, 'dev server running on the pinned port');
    const answer = await fetch(`http://127.0.0.1:${port}/`);
    expect(await answer.text()).toBe('ok');

    const stopped = await stand.decided('stop_project_runner', { project: stand.projectId });
    expect(stopped.card.risk).toBe('change');
    expect(stopped.result.outcome).toBe('done');
    await until(async () => {
      const view = await running();
      return view.every((item) => item.status === 'stopped' || item.status === 'error')
        ? true
        : undefined;
    }, 'dev server stopped');

    const again = await stand.call('stop_project_runner', { project: stand.projectId });
    expect(again.outcome).toBe('failed');
  });

  it('free_port гасит чужой процесс на порту; порт процесса панели — отказ без карточки', async () => {
    const port = await freeTcpPort();
    // Сирота: её родитель вышел, в дерево процесса «панели» она не входит.
    const orphan = await spawnOrphanListener(port);
    orphans.push(orphan);

    const freed = await stand.decided('free_port', { port });
    expect(freed.card.risk).toBe('danger');
    expect(JSON.stringify(freed.card.preview.fields)).toContain(String(orphan));
    expect(freed.result.outcome).toBe('done');
    await waitListening(port, false);
    expect(isAlive(orphan)).toBe(false);

    const nobody = await stand.call('free_port', { port });
    expect(nobody.outcome).toBe('failed');

    // Порт самого процесса панели маршрут не показывает вовсе — предлагать нечего.
    own = createServer();
    await new Promise<void>((done) => own!.listen(0, '127.0.0.1', done));
    const ownPort = (own.address() as { port: number }).port;
    const self = await stand.call('free_port', { port: ownPort });
    expect(self.outcome).toBe('failed');
    expect(own.listening).toBe(true);
    // netstat на Windows отвечает секунды, а карточка спрашивает его не раз.
  }, 90_000);

  it('free_port: держатель — потомок панели (её CLI, MCP, dev-сервер) — отказ без карточки, жив', async () => {
    const port = await freeTcpPort();
    child = await spawnChildListener(port);
    const refused = await stand.call('free_port', { port });
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toContain('belongs to the panel');
    expect(isAlive(child.pid!)).toBe(true);
    const pending = await stand.app.inject({ method: 'GET', url: '/api/agent/pending' });
    expect(pending.json()).toEqual([]);
  }, 90_000);

  it('free_port: порт стенда панели (фронт WEB_PORT) — отказ без карточки, держатель жив', async () => {
    const port = await freeTcpPort();
    const orphan = await spawnOrphanListener(port);
    orphans.push(orphan);
    const saved = process.env.WEB_PORT;
    process.env.WEB_PORT = String(port);
    try {
      const refused = await stand.call('free_port', { port });
      expect(refused.outcome).toBe('failed');
      expect(refused.message).toContain('panel stand');
    } finally {
      if (saved === undefined) delete process.env.WEB_PORT;
      else process.env.WEB_PORT = saved;
    }
    expect(isAlive(orphan)).toBe(true);
  }, 90_000);

  it('free_port: порт родителя и предка панели (сторожа) — отказ без карточки, держатель жив', async () => {
    // Панель — дочерний процесс, этот процесс теста — её родитель и держит порт.
    own = createServer();
    await new Promise<void>((done) => own!.listen(0, '127.0.0.1', done));
    const parentPort = (own.address() as { port: number }).port;
    const script = join(stand.appData, 'panel-child.mjs');
    const harness = pathToFileURL(
      join(import.meta.dirname, '..', 'project-actions.harness.ts'),
    ).href;
    writeFileSync(
      script,
      `const { openProjectStand } = await import(${JSON.stringify(harness)});
const stand = await openProjectStand();
try {
  const result = await stand.call('free_port', { port: ${parentPort} });
  process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n');
} finally {
  await stand.close();
}
`,
    );
    const panelArgs = ['--experimental-strip-types', '--no-warnings', script];
    // Родитель — прямой (сторож) и через посредника (сторож → pnpm → панель):
    // второй виден только обходом предков по снимку процессов (ревью U4a m6).
    const launches: Array<[string[], string]> = [
      [panelArgs, 'held by the panel itself'],
      [
        [
          '-e',
          `require('node:child_process').spawnSync(process.execPath, ${JSON.stringify(panelArgs)}, { stdio: 'inherit', windowsHide: true })`,
        ],
        'belongs to the panel',
      ],
    ];
    for (const [args, expected] of launches) {
      const output = await new Promise<string>((done, fail) => {
        execFile(
          process.execPath,
          args,
          { windowsHide: true, timeout: 60_000 },
          (error, stdout, stderr) =>
            error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
        );
      });
      const line = output.split('\n').find((item) => item.startsWith('RESULT '));
      expect(line, output).toBeDefined();
      const result = JSON.parse(line!.slice('RESULT '.length)) as {
        outcome: string;
        message: string;
      };
      expect(result.outcome, expected).toBe('failed');
      expect(result.message).toContain(expected);
      expect(own.listening).toBe(true);
    }
  }, 150_000);

  it('код проекта: список и чтение с маской секретов и PEM; выход за корень — отказ', async () => {
    writeFileSync(
      join(stand.projectDir, 'config.ts'),
      `export const token = '${LIVE_TOKEN}';\nconst key = \`-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n${PEM_TAIL}\n-----END PRIVATE KEY-----\`;\n`,
    );
    const listed = await stand.call('list_project_files', { project: stand.projectId });
    expect(listed.outcome).toBe('done');
    expect(JSON.stringify(listed.result)).toContain('config.ts');

    const read = await stand.call('read_project_file', {
      project: stand.projectId,
      file: 'config.ts',
    });
    expect(read.outcome).toBe('done');
    const text = JSON.stringify(read.result);
    expect(text).toContain('export const token');
    expect(text).not.toContain(LIVE_TOKEN);
    expect(text).not.toContain(PEM_BODY);
    expect(text).not.toContain(PEM_TAIL);

    const outside = await stand.call('read_project_file', {
      project: stand.projectId,
      file: '../outside.txt',
    });
    expect(outside.outcome).toBe('failed');

    const write = await stand.call('write_project_file', {
      project: stand.projectId,
      file: 'config.ts',
      content: 'x',
    });
    expect(write.outcome).toBe('unknown');
  });
});
