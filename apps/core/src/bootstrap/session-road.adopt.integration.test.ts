import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { claudeConfigDir } from '../adapters/claude/user-layer.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import type { RoadStart } from './session-road.ts';

/**
 * Продолжение разговора, начатого не ядром (этап 10, F2, решение 2b), НАСТОЯЩЕЙ дорогой сессии на
 * загруженном ядре: id от панели — только просьба. Сессия продолжает разговор (`--resume <id>` в
 * argv CLI), лишь когда переходник Claude сам нашёл транскрипт этого id в хранилище CLI и
 * транскрипт называет своей папкой корень сессии. Выдуманный id, транскрипт другого корня, просьба
 * о разговоре другого CLI — отказ с кодом `resume_*` строкой журнала, до каталога и процесса.
 * Подменён только сам CLI (запись живого Claude); хранилище — настоящий файл в доме стенда.
 */

const CONV = '5b0c3f7e-2a41-4d8e-9c55-0f1e2d3c4b5a';

const cores: BootedCore[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  for (const core of cores) await core.stop();
});

interface Stand {
  core: BootedCore;
  live: LiveRoot;
  bin: string;
  task: LiveTask;
  start: RoadStart;
  dump: string;
}

async function stand(resume?: RoadStart['resume']): Promise<Stand> {
  const core = await bootCore({ home: join(tempDir('adopt-'), 'core'), build: 'adopt-test' });
  cores.push(core);
  const live = liveRoot('adopt-');
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  const task = await roadTask(core, claudeRunFacts.id, { allowed: true });
  const dump = join(live.root, 'dump.json');
  const start = roadStart({
    live,
    bin,
    task,
    adapterId: claudeRunFacts.id,
    fixture: fixturePath(claudeRunFacts.id, 'permit'),
    dump,
  });
  return { core, live, bin, task, start: { ...start, ...(resume ? { resume } : {}) }, dump };
}

/** Транскрипт Claude Code в его хранилище стенда: папка проекта — любое имя, cwd — в строках. */
function writeTranscript(s: Stand, cwd: string, id = CONV, folder = 'C--some-project'): string {
  const dir = join(claudeConfigDir(s.start.pin), 'projects', folder);
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'mode', mode: 'default', sessionId: id },
    { type: 'user', cwd, sessionId: id, message: { role: 'user', content: 'привет' } },
  ];
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

function refusals(t: LiveTask) {
  return lines(t)
    .filter(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === 'resume-refused',
    )
    .map((l) => ({ stepId: l.stepId, sessionId: l.sessionId, ...(l.data as { detail: string }) }));
}

async function expectRefused(s: Stand, code: string): Promise<void> {
  const got = await s.core.road.prepare(s.start);
  expect(got.ok).toBe(false);
  if (got.ok) return;
  expect(got.reason).toBe(`resume refused: ${code}`);
  const signals = refusals(s.task);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({ stepId: s.start.stepId, sessionId: s.start.sessionId });
  expect(signals[0]!.detail).toContain(code);
  // Ни каталога сессии, ни процесса, ни строки сессии.
  expect(existsSync(s.start.dir)).toBe(false);
  expect(readDump(s.dump)).toBeNull();
  expect(lines(s.task).some((l) => l.kind === 'session.started')).toBe(false);
}

describe('adopting an outside CLI conversation through the real session road (stage 10 F2)', () => {
  it('an existing claude chat of this root: the adapter finds its transcript, the CLI launches with --resume <id>', async () => {
    const s = await stand({ conversationId: CONV, adopt: { adapter: claudeRunFacts.id } });
    writeTranscript(s, s.start.cwd);
    const prepared = await s.core.road.prepare(s.start);
    if (!prepared.ok) throw new Error(prepared.reason);
    const p = prepared.prepared;
    expect(p.spec.resume).toEqual({ conversationId: CONV });
    const launched = await s.core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    stops.push(() => p.adapter.stop(launched.handle, 'tree'));
    s.core.road.started(p, launched.handle, launched.layer);
    const deadline = Date.now() + 30_000;
    let dump = readDump(s.dump);
    while (!dump && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      dump = readDump(s.dump);
    }
    expect(dump?.argv).toBeDefined();
    const argv = dump!.argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe(CONV);
    expect(refusals(s.task)).toEqual([]);
  }, 60_000);

  it('a forged id the CLI store does not hold is refused resume_not_owned before any process', async () => {
    const s = await stand({ conversationId: CONV, adopt: { adapter: claudeRunFacts.id } });
    await expectRefused(s, 'resume_not_owned');
  }, 60_000);

  it('a real transcript of ANOTHER root is refused resume_not_owned: the id alone proves nothing', async () => {
    const s = await stand({ conversationId: CONV, adopt: { adapter: claudeRunFacts.id } });
    writeTranscript(s, tempDir('other-root-'));
    await expectRefused(s, 'resume_not_owned');
  }, 60_000);

  it('a copy of this root’s transcript under another id is refused: the rows name their own session', async () => {
    const other = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
    const s = await stand({ conversationId: other, adopt: { adapter: claudeRunFacts.id } });
    const file = writeTranscript(s, s.start.cwd);
    writeFileSync(
      file.replace(CONV, other),
      `${JSON.stringify({ type: 'user', cwd: s.start.cwd, sessionId: CONV })}\n`,
    );
    await expectRefused(s, 'resume_not_owned');
  }, 60_000);

  it('a conversation of another CLI is refused resume_other_cli, even with a matching transcript', async () => {
    const s = await stand({ conversationId: CONV, adopt: { adapter: 'qwen' } });
    writeTranscript(s, s.start.cwd);
    await expectRefused(s, 'resume_other_cli');
  }, 60_000);
});
