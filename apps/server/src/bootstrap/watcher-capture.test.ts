import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeCliExits,
  observeSpawnFailures,
  spawnCliProcess,
  watchCliChild,
} from '../lib/cli-spawn.ts';
import { killChildTree } from '../lib/process-tree.ts';
import { createWatchCapture, logLineSignal, stderrCause } from './watcher-capture.ts';
import type { WatchSignal } from '../domains/watcher/types.ts';

describe('сбор сигналов сервера для наблюдателя', () => {
  it('ошибка и предупреждение кода панели в журнале — сигнал; своя запись Fastify о 5xx и info — нет', () => {
    expect(logLineSignal(JSON.stringify({ level: 50, msg: 'provider failed' }))).toMatchObject({
      kind: 'log-error',
      message: 'provider failed',
    });
    expect(
      logLineSignal(JSON.stringify({ level: 50, msg: 'x', res: {}, err: {} })),
    ).toBeUndefined();
    expect(logLineSignal(JSON.stringify({ level: 40, msg: 'warn' }))).toMatchObject({
      kind: 'log-warn',
      message: 'warn',
    });
    expect(logLineSignal(JSON.stringify({ level: 30, msg: 'info' }))).toBeUndefined();
    expect(logLineSignal('не json')).toBeUndefined();
  });

  it('ответ 5xx маршрута приходит шаблоном пути, с текстом и стеком ошибки', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    const app = Fastify();
    capture.registerHooks(app);
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    app.get('/api/items/:id', () => {
      throw new Error('items broke');
    });
    app.get('/api/fine', () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/api/items/42?x=1' });
    await app.inject({ method: 'GET', url: '/api/fine' });
    await app.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'http-5xx',
      method: 'GET',
      path: '/api/items/:id',
      status: 500,
      message: 'items broke',
    });
    expect(seen[0]!.stack).toContain('items broke');
    observeSpawnFailures(undefined);
  });

  it('4xx своего интерфейса — сигнал и пометка «записано»; отказ по существу — нет', async () => {
    let clock = 0;
    const capture = createWatchCapture({ write: () => {} }, () => clock);
    const seen: WatchSignal[] = [];
    const app = Fastify();
    capture.registerHooks(app);
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    app.post('/api/items', (_request, reply) =>
      reply.code(400).send({ code: 'invalid_body', message: 'неверно задано name' }),
    );
    app.get('/api/items/:id', (_request, reply) => reply.code(404).send({ message: 'нет записи' }));
    app.get('/api/locked', (_request, reply) => reply.code(409).send({ message: 'занято' }));
    app.get('/api/private', (_request, reply) => reply.code(403).send({ message: 'нельзя' }));
    const bad = await app.inject({ method: 'POST', url: '/api/items', payload: {} });
    const missingRecord = await app.inject({ method: 'GET', url: '/api/items/7' });
    const noRoute = await app.inject({ method: 'GET', url: '/api/nowhere?x=1' });
    await app.inject({ method: 'GET', url: '/api/private' });
    // 409: два раза — отказ по существу, третий за минуту — круг; после окна счёт заново.
    const conflicts = [];
    for (const at of [0, 10_000, 20_000, 90_000]) {
      clock = at;
      conflicts.push(await app.inject({ method: 'GET', url: '/api/locked' }));
    }
    await app.close();
    expect(seen.map((signal) => [signal.kind, signal.path, signal.status])).toEqual([
      ['http-4xx', '/api/items', 400],
      ['http-4xx', '/api/nowhere', 404],
      ['http-4xx', '/api/locked', 409],
    ]);
    expect(seen[0]!.message).toBe('invalid_body: неверно задано name');
    expect(seen[1]!.message).toBe('Маршрута нет: GET /api/nowhere');
    expect(seen[2]!.message).toContain('409 по кругу');
    expect(bad.headers['x-agentdeck-watch']).toBe('seen');
    expect(noRoute.headers['x-agentdeck-watch']).toBe('seen');
    expect(missingRecord.headers['x-agentdeck-watch']).toBeUndefined();
    expect(conflicts.map((reply) => reply.headers['x-agentdeck-watch'])).toEqual([
      undefined,
      undefined,
      'seen',
      undefined,
    ]);
    observeSpawnFailures(undefined);
  });

  it('наблюдатель выключен (сигнал не принят) — пометки «записано» нет', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const app = Fastify();
    capture.registerHooks(app);
    capture.attach({ signal: () => false });
    app.get('/api/boom', () => {
      throw new Error('boom');
    });
    const reply = await app.inject({ method: 'GET', url: '/api/boom' });
    await app.close();
    expect(reply.statusCode).toBe(500);
    expect(reply.headers['x-agentdeck-watch']).toBeUndefined();
    observeSpawnFailures(undefined);
  });

  it('ответ дольше порога — сигнал с длительностью; поток событий — нет', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    const app = Fastify();
    capture.registerHooks(app);
    capture.attach({
      signal: (signal) => (seen.push(signal), true),
      thresholds: { slowRequestMs: 50 },
    });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
    app.get('/api/slow/:id', async () => {
      await pause();
      return { ok: true };
    });
    app.get('/api/fast', () => ({ ok: true }));
    app.get('/api/stream', async (_request, reply) => {
      await pause();
      return reply.type('text/event-stream').send('data: x\n\n');
    });
    await app.inject({ method: 'GET', url: '/api/slow/3' });
    await app.inject({ method: 'GET', url: '/api/fast' });
    await app.inject({ method: 'GET', url: '/api/stream' });
    await app.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'slow-request', path: '/api/slow/:id', status: 200 });
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(100);
    observeSpawnFailures(undefined);
  });

  it('CLI с ненулевым кодом — сигнал cli-exit; нулевой и снятый нарочно — нет', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    const run = (code: number) =>
      spawnCliProcess('cli-exit-qa', ['-p', 'x'], {
        spawnImpl: (() => spawn(process.execPath, ['-e', `process.exit(${code})`])) as never,
      }).child!;
    const exited = (child: ReturnType<typeof run>) =>
      new Promise((resolve) => child.on('close', resolve));
    await exited(run(3));
    await exited(run(0));
    const stopped = spawnCliProcess('cli-exit-qa', [], {
      spawnImpl: (() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])) as never,
    }).child!;
    killChildTree(stopped);
    await exited(stopped);
    observeCliExits(undefined);
    observeSpawnFailures(undefined);
    expect(seen.map((signal) => signal.kind)).toEqual(['cli-exit']);
    expect(seen[0]!.message).toBe('«cli-exit-qa» завершился с кодом 3 (-p x)');
    expect(seen[0]!.pid).toBeGreaterThan(0);
  });

  it('ошибка провайдера: хвост stderr в сигнале, причина — в тексте; вызывающий читает stderr как раньше', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    const run = (stderr: string) =>
      spawnCliProcess('cli-exit-qa', ['-p', 'x'], {
        spawnImpl: (() =>
          spawn(process.execPath, [
            '-e',
            `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`,
          ])) as never,
      }).child!;
    const readByCaller: string[] = [];
    const first = run('boot noise 17:02:11\nAPI Error: 529 {"type":"overloaded_error"}\n');
    first.stderr.on('data', (chunk: Buffer) => void readByCaller.push(String(chunk)));
    await new Promise((resolve) => first.on('close', resolve));
    // Вызывающий, который stderr не читает: сбор не переводит поток в «течёт».
    const silent = run('Error: Invalid API key · Please run /login\n');
    const flowingAfterSpawn = silent.stderr.readableFlowing;
    await new Promise((resolve) => silent.on('close', resolve));
    observeCliExits(undefined);
    observeSpawnFailures(undefined);
    expect(readByCaller.join('')).toContain('boot noise');
    expect(flowingAfterSpawn).toBeNull();
    expect(seen[0]!.message).toBe(
      '«cli-exit-qa» завершился с кодом 1 (-p x): API Error: 529 {"type":"overloaded_error"}',
    );
    expect(seen[0]!.output).toContain('boot noise 17:02:11');
    // Не читавший stderr: поток дочитывает сам Node на выходе процесса — хвост есть и тут.
    expect(seen[1]!.message).toBe(
      '«cli-exit-qa» завершился с кодом 1 (-p x): Error: Invalid API key · Please run /login',
    );
  });

  // Ревью 28.09 (F-19): хвост stderr уходил наблюдателю (модели и в отчёт)
  // дословно — с токенами, что CLI или MCP-сервер напечатали при сбое.
  it('секреты в хвосте stderr замаскированы и в выводе, и в причине', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    const token = 'ghp_Abcdefghijklmnopqrstuvwxyz0123456789';
    const child = spawnCliProcess('cli-exit-qa', ['-p', 'x'], {
      spawnImpl: (() =>
        spawn(process.execPath, [
          '-e',
          `process.stderr.write(${JSON.stringify(`proxy https://u:hunter2secret@proxy.local\nError: token ${token} rejected\n`)}); process.exitCode = 1;`,
        ])) as never,
    }).child!;
    await new Promise((resolve) => child.on('close', resolve));
    observeCliExits(undefined);
    observeSpawnFailures(undefined);
    expect(seen[0]!.output).not.toContain(token);
    expect(seen[0]!.message).not.toContain(token);
    expect(seen[0]!.output).not.toContain('hunter2secret');
  });

  it('CLI, запущенный своим spawn (чат), — под присмотром через watchCliChild', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    const child = spawn(process.execPath, [
      '-e',
      'process.stderr.write("Error: 401 authentication_error"); process.exitCode = 2;',
    ]);
    watchCliChild('claude', ['--print'], child);
    await new Promise((resolve) => child.on('close', resolve));
    observeCliExits(undefined);
    observeSpawnFailures(undefined);
    // Наблюдателя нет — присмотр не вешается вовсе.
    const unwatched = spawn(process.execPath, ['-e', 'process.exitCode = 5;']);
    watchCliChild('claude', [], unwatched);
    await new Promise((resolve) => unwatched.on('close', resolve));
    expect(seen.map((signal) => signal.message)).toEqual([
      '«claude» завершился с кодом 2 (--print): Error: 401 authentication_error',
    ]);
  });

  it('строка причины из stderr: последняя с признаком ошибки, без цветовых кодов', () => {
    expect(stderrCause('progress 10%\n\u001b[31mError: rate limit exceeded\u001b[0m\nbye\n')).toBe(
      'Error: rate limit exceeded',
    );
    expect(stderrCause('Error: retrying (1/3)\nError: final cause\ndone\n')).toBe(
      'Error: final cause',
    );
    expect(stderrCause('only this line\n\n')).toBe('only this line');
    expect(stderrCause('  \n')).toBeUndefined();
    expect(stderrCause(`fatal: ${'x'.repeat(500)}`)!.length).toBeLessThanOrEqual(201);
  });

  it('журнал Fastify уходит в stdout как раньше и одновременно в наблюдатель', () => {
    const written: string[] = [];
    const capture = createWatchCapture({ write: (line) => void written.push(line) });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    const line = `${JSON.stringify({ level: 60, msg: 'fatal thing' })}\n`;
    capture.logStream.write(line);
    expect(written).toEqual([line]);
    expect(seen.map((signal) => signal.message)).toEqual(['fatal thing']);
    observeSpawnFailures(undefined);
  });

  it('неудавшийся запуск CLI — сигнал spawn-failed, запуск отвечает как раньше', async () => {
    const capture = createWatchCapture({ write: () => {} });
    const seen: WatchSignal[] = [];
    capture.attach({ signal: (signal) => (seen.push(signal), true) });
    // Отказ до процесса (оболочка или spawn бросили): ответ — ошибка, как раньше.
    const refused = spawnCliProcess('cli-a', [], {
      spawnImpl: (() => {
        throw new Error('spawn EACCES');
      }) as never,
    });
    expect(refused.error?.message).toBe('spawn EACCES');
    // Процесс не нашёлся уже после запуска (ENOENT событием `error`): вызывающий
    // получает своё событие, наблюдатель смотрит через errorMonitor.
    const missing = join(tmpdir(), 'cc-no-such-dir', 'no-such-cli-xyz');
    const outcome = spawnCliProcess('cli-b', [], {
      spawnImpl: (() => spawn(missing, [])) as never,
    });
    const callerSaw = await new Promise<string>((resolve) => {
      outcome.child!.on('error', (error) => resolve(error.message));
    });
    observeSpawnFailures(undefined);
    expect(callerSaw).toContain('ENOENT');
    expect(seen.map((signal) => signal.kind)).toEqual(['spawn-failed', 'spawn-failed']);
    expect(seen[0]!.message).toContain('cli-a');
    expect(seen[1]!.message).toContain('ENOENT');
  });
});
