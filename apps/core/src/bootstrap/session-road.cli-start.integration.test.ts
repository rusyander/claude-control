import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../adapters/conformance/__fixtures__/replay.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { LayerRun } from '../adapters/adapter.types.ts';
import { loginRoute, roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * CLI, вышедший раньше, чем хост сеанса прочитал его личность (C3d п.4): хост кладёт в запись
 * старт '' (`session-host/host.ts`, `identity`), а сорванный у ОС запуск — ещё и pid -1. Дорога
 * писала их в `session.started` как есть, схема журнала отвергала строку («cliStart: Too small»),
 * петля видела «session not journaled» и запускала тот же CLI ещё дважды. Подменена только
 * личность из таблицы процессов ОС (граница ОС); дорога, журнал и его схема — настоящие.
 */

let core: BootedCore;
let live: LiveRoot;
let bin: string;

beforeAll(async () => {
  core = await bootCore({
    home: join(tempDir('road-cli-start-'), 'core'),
    build: 'road-cli-start-test',
    panelAppData: null,
    loop: false,
  });
  live = liveRoot('road-cli-start-');
  bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
}, 60_000);

afterAll(async () => {
  await core?.stop();
});

/** Один сеанс дорогой ядра, личность CLI в записи хоста заменена на `child`, слой — на `layerOf`. */
async function startedWith(
  child: (real: { pid: number; start: string }) => { pid: number; start: string },
  layerOf: (real: LayerRun) => LayerRun = (real) => real,
) {
  const task: LiveTask = await core.registry.create({
    ...CREATED,
    allowedRoutes: [
      {
        adapter: claudeRunFacts.id,
        route: { kind: 'cli-login', id: loginRoute(claudeRunFacts.id) },
        modelPattern: '*',
      },
    ],
  });
  const prepared = await core.road.prepare(
    roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump: join(live.root, `dump-${newId()}.json`),
    }),
  );
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  try {
    core.road.started(
      p,
      { ...launched.handle, child: child(launched.handle.child) },
      layerOf(launched.layer),
    );
  } finally {
    await p.adapter.stop(launched.handle, 'tree');
  }
  const lines = readJournalLines(task.dir, task.taskId).lines;
  const line = lines.find((l) => l.kind === 'session.started' && l.sessionId === p.start.sessionId);
  const losses = lines
    .filter((l) => l.kind === 'signal' && l.sessionId === p.start.sessionId)
    .map((l) => l.data as { signal?: string; detail?: string })
    .filter((d) => d.signal === 'layer-loss')
    .map((d) => d.detail);
  return line
    ? { ...(line.data as { cliPid?: unknown; cliStart?: unknown; layer?: object }), losses }
    : undefined;
}

describe('session.started for a CLI whose identity the host could not read (C3d item 4)', () => {
  it('start unread → cliStart null, the pid kept; launch refused by the OS (pid -1) → cliPid null too', async () => {
    const unread = await startedWith((real) => ({ pid: real.pid, start: '' }));
    expect(unread).toMatchObject({ cliStart: null });
    expect(typeof unread?.cliPid).toBe('number');
    expect(unread?.cliPid).toBeGreaterThanOrEqual(0);

    const refused = await startedWith(() => ({ pid: -1, start: '' }));
    expect(refused).toMatchObject({ cliPid: null, cliStart: null });
  }, 120_000);
});

/**
 * Потери слоя человека (G-b) идут сигналами `layer-loss`; в `session.started` схема журнала поля
 * `losses` не знает, и запись целиком отвергалась («layer: Unrecognized key») — сеанс «не записан»,
 * шаг перезапускал CLI трижды (cli-x7-001 на goose и opencode).
 */
describe('session.started for a layer with losses (cli-x7-001)', () => {
  it('the session is journaled without `losses` in its layer; each loss is a layer-loss signal', async () => {
    const got = await startedWith(
      (real) => real,
      (real) => ({ ...real, losses: ['hooks: PreToolUse', 'skills: deep-review'] }),
    );
    expect(got).toBeDefined();
    expect(got?.layer).not.toHaveProperty('losses');
    expect(got?.losses).toEqual(['hooks: PreToolUse', 'skills: deep-review']);
  }, 120_000);
});
