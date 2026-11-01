import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgePort } from '../adapters/forge/index.ts';
import {
  ANSWER_REVIEWERS_PRESET,
  BASE_PIN_SIGNAL,
  basePinDetail,
  HALF_MADE_ANSWER_REASON,
} from '../conductor/estimate/index.ts';
import { CREATED, SOLO_UNIT } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { LoginPath } from '../platform/shell-path.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { guardStand, type GuardStand } from './guard-wiring/__fixtures__/guard-stand.ts';

/**
 * Опрос форжа на НАСТОЯЩЕЙ загрузке (05:77): `bootCore` сам заводит опрос, его таймер и его
 * остановку. Шов теста — только порт форжа и шаг таймера (`BootOptions.forgePoll`); включение —
 * `forgePoll` конфига ядра, как у человека. Временный репозиторий с голым «сервером», заглушка
 * форжа на loopback; задача-источник — законченная задача с MR в журнале. Круг таймера открывает
 * задачу answer-reviewers; после `stop()` таймер не ходит к форжу.
 */

const INTERVAL_MS = 40;
const BRANCH = 'agentdeck/boot-poll';

interface Stand {
  st: GuardStand;
  stub: StubForge;
  core?: BootedCore;
}
const open: Stand[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.core?.stop();
    await s.stub.stop();
    s.st.remove();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(INTERVAL_MS);
  }
}

/**
 * PATH сессии с исполняемым `claude`, как его ставит npm (`.cmd` над node-скриптом на Windows): без
 * CLI предпроверка задачи ответов отказывает до создания (F3), и тест зеленел только на машине с
 * настоящим claude. Подставлена внешняя граница — что лежит на PATH; запуска нет (`confirm`).
 */
function cliOnPath(root: string): () => Promise<LoginPath> {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.js'), '');
    writeFileSync(
      join(bin, 'claude.cmd'),
      ['@SETLOCAL', '@SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\claude.js" %*'].join('\r\n'),
    );
  } else {
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
  }
  return async () => ({
    path: [bin, process.env.PATH ?? ''].join(delimiter),
    source: 'not-applicable',
    reason: 'test: fake claude on the session PATH',
  });
}

/** Ветка единицы на «сервере» и MR по ней на заглушке. */
async function publishedBranch(st: GuardStand, port: ForgePort) {
  const sha = st.commitIn(st.copy, 'feature.txt');
  st.g(st.copy, 'push', '-q', 'origin', BRANCH);
  const base = st.g(st.main, 'rev-parse', 'origin/main');
  const mr = await port.createMr({
    sourceBranch: BRANCH,
    targetBranch: 'main',
    title: 'Add the feature file',
    body: '',
    draft: false,
  });
  if (!('value' in mr)) throw new Error(`createMr: ${JSON.stringify(mr)}`);
  return { sha, base, mr: mr.value };
}

describe('boot: the forge poll runs on the real boot (05:77)', () => {
  it('config forgePoll on → a timer tick opens the answer-reviewers task; stop() stops the timer', async () => {
    const st = guardStand(BRANCH);
    const stub = await startStubForge({ repo: st.bare });
    const stand: Stand = { st, stub };
    open.push(stand);
    const port = createForgePort({
      project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: st.bare },
      token: stub.tokens['publisher']!,
      fetch: globalThis.fetch,
    });
    const { sha, base, mr } = await publishedBranch(st, port);

    const core = await bootCore({
      home: join(st.root, 'core-home'),
      build: 'forge-poll-boot-test',
      loop: false,
      loginPath: cliOnPath(st.root),
      forgePoll: { forgeFor: () => port, intervalMs: INTERVAL_MS },
    });
    stand.core = core;

    // Задача-источник: репозиторий r1, приколотая база, единица на ветке MR, MR в журнале, `done`.
    const source = await core.registry.create({
      ...CREATED,
      repos: [{ repoKey: 'r1', path: st.main, baseRef: 'main' }],
    });
    source.append({
      kind: 'signal',
      actor: 'core',
      data: {
        signal: BASE_PIN_SIGNAL,
        severity: 'info',
        subject: 'r1',
        detail: basePinDetail('origin/main', base, null),
      },
    });
    const unitId = newId();
    source.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { ...SOLO_UNIT, unitId, repoKey: 'r1', branch: BRANCH, ownedPaths: [] },
    });
    source.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId,
      data: {
        unitId,
        forge: 'gitlab',
        mrId: mr.id,
        mrIid: mr.iid,
        url: mr.url,
        sourceBranch: mr.sourceBranch,
        actionId: newId(),
      },
    });
    source.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });

    // Опрос выключен, пока его не включили в конфиге: таймер идёт, к форжу не ходит.
    const polledBefore = stub.requests.length;
    await sleep(INTERVAL_MS * 4);
    expect(stub.requests).toHaveLength(polledBefore);

    writeFileSync(core.layout.config, JSON.stringify({ forgePoll: [st.main] }));
    // Первый круг ставит отметку «сейчас»: заметка — после того, как опрос дошёл до форжа.
    await until(
      () => (stub.requests.length > polledBefore ? true : undefined),
      'the first poll round',
    );
    await sleep(INTERVAL_MS * 2);
    stub.act('reviewer', { type: 'note', mrIid: mr.iid, body: 'please rename the file' });

    const answerId = await until(
      () => core.registry.list().find((t) => t.taskId !== source.taskId)?.taskId,
      'the answer task',
    );
    const lines = readJournalLines(join(core.registry.tasksDir, answerId), answerId).lines;
    const created = lines.find((l) => l.kind === 'task.created')!.data as {
      scenario: { id: string };
      repos: { baseRef: string }[];
    };
    expect(created.scenario.id).toBe('answer-reviewers');
    // База — голова ветки MR на сервере (приколота fetch'ем), не база задачи-источника.
    expect(created.repos[0]!.baseRef).toBe(sha);
    const events = lines
      .filter((l) => l.kind === 'forge.event')
      .map((l) => l.data as { source: string; mrIid: number; author: string });
    expect(events).toEqual([
      expect.objectContaining({ source: 'poller', mrIid: mr.iid, author: 'reviewer' }),
    ]);

    // Пока задача ответов ждёт запуска, MR удержан и к форжу никто не ходит — тогда тишина после
    // `stop()` ничего не доказала бы. Задача отменена: MR снова опрашивается под источником.
    core.registry
      .live(answerId)!
      .append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    const resumed = stub.requests.length;
    await until(
      () => (stub.requests.length > resumed ? true : undefined),
      'polling to resume after the answer task ended',
    );

    // `stop()` снимает таймер и дожидается идущего круга: дальше ни одного запроса к форжу.
    await core.stop();
    stand.core = undefined;
    const after = stub.requests.length;
    stub.act('reviewer', { type: 'note', mrIid: mr.iid, body: 'one more thing' });
    await sleep(INTERVAL_MS * 6);
    expect(
      stub.requests.slice(after).map((r) => `${r.method} ${r.path} ${r.control ?? ''}`),
    ).toEqual([]);
  });

  it('a half-made answer task (crash before unit 0) is ended failed by the next boot; other unfinished tasks stay open', async () => {
    const st = guardStand(BRANCH);
    const stub = await startStubForge({ repo: st.bare });
    const stand: Stand = { st, stub };
    open.push(stand);
    const home = join(st.root, 'core-home');
    const first = await bootCore({ home, build: 'forge-poll-boot-test', loop: false });
    stand.core = first;
    const repos = [{ repoKey: 'r1', path: st.main, baseRef: 'main' }];
    const half = await first.registry.create({
      ...CREATED,
      repos,
      scenario: { id: ANSWER_REVIEWERS_PRESET, version: 1 },
    });
    const other = await first.registry.create({ ...CREATED, repos });
    // Задача ответов с единицей 0 — доделанная, ждёт запуска человеком: загрузка её не трогает.
    const waiting = await first.registry.create({
      ...CREATED,
      repos,
      scenario: { id: ANSWER_REVIEWERS_PRESET, version: 1 },
    });
    const unitId = newId();
    waiting.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { ...SOLO_UNIT, unitId, repoKey: 'r1', branch: BRANCH, ownedPaths: [] },
    });
    await first.stop();
    stand.core = undefined;

    const second = await bootCore({ home, build: 'forge-poll-boot-test', loop: false });
    stand.core = second;
    expect(second.registry.live(half.taskId)!.state.ended).toBe('failed');
    const signals = readJournalLines(join(second.registry.tasksDir, half.taskId), half.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { detail: string }).detail);
    expect(signals).toContain(JSON.stringify([HALF_MADE_ANSWER_REASON]));
    expect(second.registry.live(other.taskId)!.state.ended).toBeNull();
    expect(second.registry.live(waiting.taskId)!.state.ended).toBeNull();
  });
});
