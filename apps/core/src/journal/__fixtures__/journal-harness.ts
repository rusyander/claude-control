import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { newId } from '../../lib/ids/uuidv7.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import { resume, type LiveTask, type ResumeDeps } from '../resume.ts';
import { NO_MASK, type CoreIdentity, type JournalClock, type MaskFn } from '../journal.types.ts';

/** Общие помощники тестов журнала: каталог в песочнице прогона, поддельные часы и личность. */

/** Каталог внутри песочницы прогона (`vitest.temp-sandbox.ts` подменяет TEMP). */
export function tempDir(prefix = 'jr-'): string {
  const dir = join(tmpdir(), `${prefix}${newId().slice(-12)}`);
  ensureDir(dir);
  return dir;
}

export function fakeClock(start = 1_760_000_000_000): JournalClock & {
  advance(ms: number): void;
  setMono(ms: number): void;
} {
  let wall = start;
  let mono = 0;
  return {
    bootId: newId(),
    stamp: () => ({ at: wall, mono }),
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    setMono(ms) {
      mono = ms;
    },
  };
}

export function identity(overrides: Partial<CoreIdentity> = {}): CoreIdentity {
  return { build: 'test', pid: process.pid, pidStart: 'start-self', bootId: newId(), ...overrides };
}

export function deps(overrides: Partial<ResumeDeps> = {}): ResumeDeps {
  return {
    me: identity(),
    clock: fakeClock(),
    mask: NO_MASK as MaskFn,
    isAlive: async () => 'alive',
    now: Date.now,
    beats: false,
    ...overrides,
  };
}

export const CREATED: JournalDataV1['task.created'] = {
  title: 'тестовая задача',
  repos: [{ repoKey: 'r1', path: '/tmp/r1', baseRef: 'main' }],
  build: 'test',
  scenario: { id: 'default', version: 1 },
  profileHash: null,
  modelCeiling: null,
  userLayerHash: null,
  envPin: '',
  requirementsSource: 'text',
  allowedRoutes: [],
  routesSourceLevel: 2,
};

/** Свежая задача в своём каталоге: аренда наша, первая строка — `lease.acquired`. */
export async function openFresh(
  root: string = tempDir(),
  d: ResumeDeps = deps(),
): Promise<{ task: LiveTask; dir: string; taskId: string; root: string }> {
  const taskId = newId();
  const dir = join(root, taskId);
  ensureDir(dir);
  const outcome = await resume(dir, taskId, d);
  if (!outcome.ok) throw new Error(outcome.reason);
  return { task: outcome.task, dir, taskId, root };
}
