import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
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
  profilePins: [],
  modelCeiling: null,
  userLayerHash: null,
  envPin: '',
  requirementsSource: 'text',
  allowedRoutes: [],
  routesSourceLevel: 2,
  origin: null,
  launchPolicy: 'confirm',
  ciWait: false,
};

/** Поля `unit.created` этапа 4, безразличные тестам без деления: одна единица, без предшественников. */
export const SOLO_UNIT: Pick<
  JournalDataV1['unit.created'],
  'name' | 'after' | 'contract' | 'splitId'
> = { name: 'unit', after: [], contract: false, splitId: null };

/**
 * Строка `tool.event` этапа 8 для тестов, которым важны только сессия, цель и длительность: чтение
 * целиком без исхода, прочие факты `null` (CLI их не отдал).
 */
export function toolEventData(
  sessionId: string,
  target: string,
  ms: number,
  overrides: Partial<JournalDataV1['tool.event']> = {},
): JournalDataV1['tool.event'] {
  return {
    sessionId,
    toolUseId: `toolu_${target}_${ms}`,
    parentToolUseId: null,
    tool: 'Read',
    effectClass: 'read',
    target,
    argvDigest: null,
    cwd: null,
    range: null,
    fileFp: null,
    sizeBytes: null,
    isError: false,
    exitCode: null,
    errorDigest: null,
    ms,
    ...overrides,
  };
}

/** Поля `step.started` этапа 4 для теста одного шага: шаг `work` сценария задачи, первый круг. */
export const FIRST_ROUND: Pick<JournalDataV1['step.started'], 'stepDefId' | 'round' | 'scenario'> =
  { stepDefId: 'work', round: 0, scenario: CREATED.scenario };

/**
 * Самый короткий годный сценарий под ссылкой `CREATED.scenario`: один шаг `work` — тот, на который
 * указывает `FIRST_ROUND.stepDefId`. Каждое поле названо: схема строгая, умолчаний нет (P42).
 */
export const MINI_SCENARIO: Scenario = {
  ...CREATED.scenario,
  title: 'один шаг',
  steps: [
    {
      id: FIRST_ROUND.stepDefId,
      kind: 'work',
      title: 'работа',
      after: [],
      knowledge: { skills: [], rules: [], hooks: [], scripts: [] },
      model: { tier: 'ceiling' },
      checks: { mid: 'narrow', required: [] },
      roundCap: 2,
      budget: {},
      overBudget: 'ask',
      userLayer: { hooks: 'on', skills: 'on' },
      gate: [],
    },
  ],
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
