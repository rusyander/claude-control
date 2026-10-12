import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerExec } from '../compose/compose.ts';
import { LOG_BUFFER_LINES, LogBuffer, type RunLog } from '../project-runner/log-buffer.ts';
import { afterCursor, listLogSources, parseComposeLogs, readLogs, timeKey } from './logs.ts';

/**
 * Логи без процессов и docker: буфер строк цели, разбор вывода
 * `docker compose logs` и курсоры. Настоящий процесс через реестр — в тесте
 * маршрутов, настоящий docker — в `tools/qa/check-logs.mjs`.
 */

const clock = () => {
  let ms = Date.parse('2026-10-12T10:00:00.000Z');
  return () => new Date((ms += 1000));
};

describe('LogBuffer', () => {
  it('куски склеиваются в строки по потоку отдельно, цвет снят, \\r — последняя версия', () => {
    const log = new LogBuffer(clock());
    log.push('stdout', 'GET /orders 2');
    log.push('stderr', 'boom\n');
    log.push('stdout', '00 OK\n\x1b[31mERROR\x1b[0m failed\nprogress 10%\rprogress 100%\n');
    expect(log.since(0).lines.map((line) => [line.stream, line.text])).toEqual([
      ['stderr', 'boom'],
      ['stdout', 'GET /orders 200 OK'],
      ['stdout', 'ERROR failed'],
      ['stdout', 'progress 100%'],
    ]);
  });

  it('«после N» отдаёт только новое; вытесненное — truncated', () => {
    const log = new LogBuffer(clock());
    log.push('stdout', 'a\nb\n');
    const first = log.since(0);
    expect(first.last).toBe(2);
    log.push('stdout', 'c\n');
    expect(log.since(first.last).lines.map((line) => line.text)).toEqual(['c']);
    expect(log.since(first.last).truncated).toBe(false);

    const big = new LogBuffer(clock());
    big.push('stdout', `${Array.from({ length: LOG_BUFFER_LINES + 5 }, (_, i) => i).join('\n')}\n`);
    const all = big.since(0);
    expect(all.lines).toHaveLength(LOG_BUFFER_LINES);
    expect(all.lines[0]?.text).toBe('5');
    expect(all.truncated).toBe(true);
  });
});

describe('docker compose logs', () => {
  const services = ['db', 'api'];

  it('префикс контейнера → сервис, время → ISO, порядок по времени между контейнерами', () => {
    const output = [
      'db-1   | 2026-10-12T10:00:02.5Z ready to accept connections',
      'db-1   | 2026-10-12T10:00:04.000000001Z checkpoint',
      'api-1  | 2026-10-12T10:00:03.123456789Z {"level":"error","msg":"no db"}',
      'shop-custom | 2026-10-12T10:00:05Z custom name',
    ].join('\n');
    const lines = parseComposeLogs(output, { withPrefix: true, services });
    expect(lines.map((line) => [line.service, line.text])).toEqual([
      ['db', 'ready to accept connections'],
      ['api', '{"level":"error","msg":"no db"}'],
      ['db', 'checkpoint'],
      ['shop-custom', 'custom name'],
    ]);
    expect(lines[1]?.at).toBe('2026-10-12T10:00:03.123Z');
  });

  it('без префикса (один сервис) текст с «|» внутри не режется', () => {
    const lines = parseComposeLogs('2026-10-12T10:00:02Z a | b\n', {
      withPrefix: false,
      services,
    });
    expect(lines.map((line) => line.text)).toEqual(['a | b']);
  });

  it('курсор: время разной точности сравнивается верно, граница не повторяется', () => {
    expect(timeKey('2026-10-12T10:00:02.5Z') > timeKey('2026-10-12T10:00:02.123456789Z')).toBe(
      true,
    );
    const lines = parseComposeLogs(
      [
        '2026-10-12T10:00:02.5Z seen',
        '2026-10-12T10:00:02.500000001Z new',
        '2026-10-12T10:00:03Z newer',
      ].join('\n'),
      { withPrefix: false, services },
    );
    expect(afterCursor(lines, '2026-10-12T10:00:02.500000000Z').map((line) => line.text)).toEqual([
      'new',
      'newer',
    ]);
  });
});

describe('источники и чтение', () => {
  const run = (over: Partial<RunLog> = {}): RunLog => {
    const log = new LogBuffer(clock());
    log.push('stdout', 'one\ntwo\n');
    return {
      projectPath: '/p',
      dir: 'cmd/api',
      name: 'api',
      command: 'go run ./cmd/api',
      startedAt: '2026-10-12T09:00:00.000Z',
      state: 'running',
      log,
      ...over,
    };
  };

  it('цель: курсор того же запуска — только новое; другого запуска — reset; остановлена — idle', async () => {
    const current = run();
    const deps = { runs: () => [current], exec: (async () => ({})) as unknown as DockerExec };
    const first = await readLogs('/p', 'run:cmd/api', undefined, deps);
    expect(first.lines.map((line) => line.text)).toEqual(['one', 'two']);
    current.log.push('stderr', 'three\n');
    const next = await readLogs('/p', 'run:cmd/api', first.cursor, deps);
    expect(next.lines.map((line) => line.text)).toEqual(['three']);
    expect(next.reset).toBeUndefined();

    const restarted = await readLogs('/p', 'run:cmd/api', '2026-10-12T08:00:00.000Z#2', deps);
    expect(restarted.reset).toBe(true);
    expect(restarted.lines).toHaveLength(3);

    current.state = 'stopped';
    expect((await readLogs('/p', 'run:cmd/api', next.cursor, deps)).idle).toBe(true);
    await expect(readLogs('/p', 'run:nope', undefined, deps)).rejects.toMatchObject({
      kind: 'unknown-source',
    });
  });

  it('Compose: список сервисов из ps, «все» при двух и больше, аргументы docker logs', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-logs-')));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
      const calls: string[][] = [];
      const exec: DockerExec = async (args) => {
        calls.push(args);
        if (args[1] === 'ps') {
          return {
            code: 0,
            stderr: '',
            stdout: [
              JSON.stringify({ Service: 'db', State: 'running', Name: 'x-db-1' }),
              JSON.stringify({ Service: 'api', State: 'exited', Name: 'x-api-1' }),
            ].join('\n'),
          };
        }
        return { code: 0, stderr: '', stdout: '2026-10-12T10:00:02Z hello\n' };
      };
      const deps = { runs: () => [run()], exec };
      const sources = await listLogSources(root, deps);
      expect(sources.docker).toBe('ok');
      expect(sources.sources.map((source) => source.id)).toEqual([
        'run:cmd/api',
        'compose:*',
        'compose:db',
        'compose:api',
      ]);

      const chunk = await readLogs(root, 'compose:api', undefined, deps);
      expect(calls.at(-1)).toEqual([
        'compose',
        'logs',
        '--timestamps',
        '--no-color',
        '--tail',
        '500',
        '--no-log-prefix',
        'api',
      ]);
      expect(chunk).toMatchObject({ cursor: '2026-10-12T10:00:02Z', idle: true });
      await readLogs(root, 'compose:*', chunk.cursor, deps);
      expect(calls.at(-1)).toEqual([
        'compose',
        'logs',
        '--timestamps',
        '--no-color',
        '--tail',
        '2000',
        '--since',
        '2026-10-12T10:00:02Z',
      ]);
      await expect(readLogs(root, 'compose:ghost', undefined, deps)).rejects.toMatchObject({
        kind: 'unknown-source',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('docker не запущен — источник Compose отвечает ошибкой docker, список говорит stopped', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-logs-')));
    try {
      writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
      const exec: DockerExec = async () => ({ code: 1, stdout: '', stderr: 'daemon down' });
      const deps = { runs: () => [], exec };
      expect((await listLogSources(root, deps)).docker).toBe('stopped');
      await expect(readLogs(root, 'compose:db', undefined, deps)).rejects.toMatchObject({
        kind: 'docker',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
