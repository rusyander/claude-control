import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { loginRoute, roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Версия CLI в `session.started` на настоящей загрузке ядра (W2b, follow-up): дорога пишет то,
 * что CLI сеанса отвечает на `--version` тем же пином (подставной `claude` на PATH пина), а не
 * заглушку `not-probed`. Читатель один на ядро и запоминает ответ на «команда × PATH» — тот же
 * читатель кладёт версию в ключ замера базы (`boot-core.ts`), CLI не спрашивается дважды.
 */

let core: BootedCore;
let live: LiveRoot;
let bin: string;

beforeAll(async () => {
  core = await bootCore({
    home: join(tempDir('road-cli-version-'), 'core'),
    build: 'road-cli-version-test',
    panelAppData: null,
    loop: false,
  });
  live = liveRoot('road-cli-version-');
  bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
}, 60_000);

afterAll(async () => {
  await core?.stop();
});

/** Один сеанс дорогой ядра; версия, которую отвечает подставной CLI, — `REPLAY_VERSION` пина. */
async function startedVersion(version: string): Promise<unknown> {
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
  const dump = join(live.root, `dump-${newId()}.json`);
  const base = roadStart({
    live,
    bin,
    task,
    adapterId: claudeRunFacts.id,
    fixture: fixturePath(claudeRunFacts.id, 'permit'),
    dump,
  });
  const prepared = await core.road.prepare({
    ...base,
    pin: { ...base.pin, REPLAY_VERSION: version },
  });
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  core.road.started(p, launched.handle, launched.layer);
  const session = core.road.attach({
    task,
    sessionId: p.start.sessionId,
    adapter: p.adapter,
    handle: launched.handle,
    context: p.context,
    cwd: p.start.cwd,
  });
  for (let i = 0; i < 1200 && !readDump(dump); i += 1) await new Promise((r) => setTimeout(r, 25));
  await session.end('tree');
  const line = readJournalLines(task.dir, task.taskId).lines.find(
    (l) => l.kind === 'session.started' && l.sessionId === p.start.sessionId,
  );
  return (line?.data as { cliVersion?: unknown } | undefined)?.cliVersion;
}

describe('session.started carries the CLI version the road read (W2b follow-up)', () => {
  it('the version the session CLI prints for --version, read once per command × PATH', async () => {
    expect(await startedVersion('9.8.7')).toBe('9.8.7');
    // Та же установка (тот же PATH пина) — запомненный ответ: второго `--version` нет.
    expect(await startedVersion('1.1.1')).toBe('9.8.7');
  }, 120_000);
});
