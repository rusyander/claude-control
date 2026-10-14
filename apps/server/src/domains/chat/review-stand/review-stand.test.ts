import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerExec, ExecResult } from '../../compose/docker.ts';
import {
  composePostgresImage,
  imageVersion,
  prepareReviewStand,
  removeReviewStand,
  STALE_STAND_MS,
  sweepStaleReviewStands,
} from './review-stand.ts';

/**
 * Стенд ревью (T5, T7). Граница — программа docker: подменена записывающим
 * двойником, который отвечает по первому слову команды; всё остальное (разбор
 * compose на настоящих файлах, порядок команд, текст задания) идёт как в продукте.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста не влияет.
  }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr });

/** Двойник docker: `answers[verb]` — ответ на команду; журнал вызовов — в `calls`. */
function fakeDocker(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)> = {}) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    const answer = answers[args[0] ?? ''];
    if (!answer) return ok();
    return typeof answer === 'function' ? answer(args) : answer;
  };
  return { exec, calls };
}

describe('образ базы из compose', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-stand-'));
  });
  afterEach(() => dropTemp(dir));

  it('postgres из compose.yaml; версия — из тега', () => {
    writeFileSync(
      join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: node:22\n  db:\n    image: "postgres:16.4-alpine"\n',
    );
    expect(composePostgresImage(dir)).toBe('postgres:16.4-alpine');
    expect(imageVersion('postgres:16.4-alpine')).toBe('16.4-alpine');
    expect(imageVersion('postgres')).toBe('latest');
  });

  it('переменная с умолчанием — берётся умолчание; без умолчания версии нет', () => {
    mkdirSync(join(dir, 'docker'));
    writeFileSync(
      join(dir, 'docker', 'docker-compose.yml'),
      'services:\n  db:\n    image: ${PG_IMAGE:-pgvector/pgvector:pg16}\n',
    );
    expect(composePostgresImage(dir)).toBe('pgvector/pgvector:pg16');
    writeFileSync(
      join(dir, 'docker', 'docker-compose.yml'),
      'services:\n  db:\n    image: ${PG_IMAGE}\n',
    );
    expect(composePostgresImage(dir)).toBeUndefined();
  });

  it('compose без базы и проект без compose — образа нет', () => {
    expect(composePostgresImage(dir)).toBeUndefined();
    writeFileSync(join(dir, 'compose.yaml'), 'services:\n  web:\n    image: redis:7\n');
    expect(composePostgresImage(dir)).toBeUndefined();
  });
});

describe('prepareReviewStand', () => {
  let copy: string;
  beforeEach(() => {
    copy = mkdtempSync(join(tmpdir(), 'cc-stand-copy-'));
  });
  afterEach(() => dropTemp(copy));

  const withDb = (): void =>
    writeFileSync(join(copy, 'compose.yaml'), 'services:\n  db:\n    image: postgres:16.4\n');

  const run = (docker: DockerExec, extra: Partial<Parameters<typeof prepareReviewStand>[1]> = {}) =>
    prepareReviewStand(
      { originDir: copy, copyDir: copy, groupKey: 'g1' },
      {
        docker,
        sleep: async () => {},
        random: () => 'abc123',
        now: () => Date.parse('2026-10-13T12:00:00.000Z'),
        ...extra,
      },
    );

  it('образ локальный, база встала: контейнер с меткой, DSN на 127.0.0.1 и версия в задании', async () => {
    withDb();
    const { exec, calls } = fakeDocker({
      info: ok('29.7.2'),
      port: ok('127.0.0.1:49153\n'),
    });
    const stand = await run(exec);

    expect(stand.container).toEqual({
      name: 'agentdeck-review-abc123',
      image: 'postgres:16.4',
      startedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(stand.text).toContain('throwaway PostgreSQL 16.4');
    expect(stand.text).toMatch(/postgresql:\/\/postgres:[0-9a-f]+@127\.0\.0\.1:49153\/review/);
    expect(stand.text).toContain('ONLY database you may write to');
    const runCall = calls.find((args) => args[0] === 'run') as string[];
    expect(runCall).toContain('agentdeck.ephemeral=review');
    expect(runCall).toContain('127.0.0.1::5432');
    expect(calls.find((args) => args[0] === 'pull')).toBeUndefined();
  });

  it('образа на машине нет — тянется только образ без чужого реестра', async () => {
    withDb();
    const hub = fakeDocker({
      info: ok('29'),
      image: fail('no such image'),
      port: ok('0.0.0.0:5000'),
    });
    expect((await run(hub.exec)).container).toBeDefined();
    expect(hub.calls.some((args) => args[0] === 'pull')).toBe(true);

    writeFileSync(
      join(copy, 'compose.yaml'),
      'services:\n  db:\n    image: registry.example.com/team/postgres:16\n',
    );
    const priv = fakeDocker({ info: ok('29'), image: fail('no such image') });
    const stand = await run(priv.exec);
    expect(stand.container).toBeUndefined();
    expect(stand.text).toContain('private registry');
    expect(stand.text).toContain('"uncovered"');
    expect(priv.calls.some((args) => args[0] === 'pull' || args[0] === 'run')).toBe(false);
  });

  it('Docker не запущен или не установлен — причина в задании, контейнера нет', async () => {
    withDb();
    const stopped = fakeDocker({ info: fail('Cannot connect to the Docker daemon') });
    const first = await run(stopped.exec);
    expect(first.container).toBeUndefined();
    expect(first.text).toContain('daemon is not running');
    expect(first.text).toContain('"Docker daemon stopped"');
    expect(stopped.calls.some((args) => args[0] === 'run')).toBe(false);

    const missing: DockerExec = async () => ({ code: null, stdout: '', stderr: '', missing: true });
    const second = await run(missing);
    expect(second.text).toContain('Docker is not installed');
    expect(second.text).toContain('"no Docker"');
  });

  it('база не поднялась за отведённое — контейнер снят, а не брошен', async () => {
    withDb();
    const { exec, calls } = fakeDocker({ info: ok('29'), exec: fail('not ready', 2) });
    const stand = await run(exec, { readyTries: 3 });
    expect(stand.container).toBeUndefined();
    expect(stand.text).toContain('did not become ready');
    expect(calls.filter((args) => args[0] === 'rm')).toEqual([
      ['rm', '-f', 'agentdeck-review-abc123'],
    ]);
  });

  it('compose без базы — «БД нет», L3 в uncovered с причиной; docker не трогается', async () => {
    const { exec, calls } = fakeDocker({ info: ok('29') });
    const stand = await run(exec);
    expect(stand.container).toBeUndefined();
    expect(stand.text).toContain('Database: none available');
    expect(stand.text).toContain('no database of the right version');
    expect(calls).toEqual([]);
  });

  it('стенд: запущенные цели названы с оговоркой «это оригинал»; нет целей — L3 в uncovered', async () => {
    const { exec } = fakeDocker();
    const running = await run(exec, {
      runner: () => ({ running: [{ name: 'web', url: 'http://localhost:5173' }], startable: [] }),
    });
    expect(running.text).toContain('web at http://localhost:5173');
    expect(running.text).toContain('ORIGINAL checkout');

    const idle = await run(exec, { runner: () => ({ running: [], startable: ['web', 'api'] }) });
    expect(idle.text).toContain('none is running now');
    expect(idle.text).toContain('"no stand"');

    const none = await run(exec, { runner: () => ({ running: [], startable: [] }) });
    expect(none.text).toContain('Stand: none');
  });
});

describe('уборка одноразовых баз', () => {
  it('removeReviewStand снимает только свои имена', async () => {
    const { exec, calls } = fakeDocker();
    expect(await removeReviewStand(exec, 'agentdeck-review-abc123', '.')).toBe(true);
    expect(await removeReviewStand(exec, 'my-production-db', '.')).toBe(false);
    expect(calls).toEqual([['rm', '-f', 'agentdeck-review-abc123']]);
  });

  it('контейнера уже нет — это тоже «убрано»', async () => {
    const { exec } = fakeDocker({ rm: fail('Error: No such container: agentdeck-review-x1') });
    expect(await removeReviewStand(exec, 'agentdeck-review-x1', '.')).toBe(true);
  });

  it('страховка на старте: по метке и только старше порога', async () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    const created: Record<string, string> = {
      'agentdeck-review-old1': new Date(now - STALE_STAND_MS - 1000).toISOString(),
      'agentdeck-review-new1': new Date(now - 60_000).toISOString(),
    };
    const { exec, calls } = fakeDocker({
      ps: ok('agentdeck-review-old1\nagentdeck-review-new1\n'),
      inspect: (args) => ok(created[args[3] as string] ?? ''),
    });
    const removed = await sweepStaleReviewStands(exec, '.', () => now);
    expect(removed).toEqual(['agentdeck-review-old1']);
    expect(calls[0]).toContain('label=agentdeck.ephemeral=review');
    expect(calls.filter((args) => args[0] === 'rm')).toEqual([
      ['rm', '-f', 'agentdeck-review-old1'],
    ]);
  });
});
