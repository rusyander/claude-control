import { afterEach, describe, expect, it } from 'vitest';
import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { CheckDecisionInput } from '@agentdeck/contracts/core/records';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { fixtureEntry } from '../../verifier/__fixtures__/registry.ts';
import { decideCheck } from '../../verifier/decide/index.ts';
import { checkWindow } from '../checks/request/helpers.ts';
import { processCommand } from '../commands.ts';
import { envelope, homeTask, HUMAN_PROOF } from '../scenario/__fixtures__/scenario-harness.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import { freshPending } from './fresh-rerun.ts';

/**
 * G12 фаза 5: `fresh-rerun` ставит разовую отметку; вход суда проверки несёт её, настоящий суд
 * (`decideCheck`) гонит мимо зелёной записи, его строка `check`/`run` тратит отметку — второй
 * запрос снова повтор. Окно маршрута шага — настоящая таблица окна L (`checkWindow`).
 */

const KEY = 'a'.repeat(64);
const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const green = {
  v: 3,
  id: `${KEY}.1`,
  key: KEY,
  parts: {},
  checkId: 'tests',
  unit: 'app',
  grade: 'unit',
  origin: 'core',
  verdict: { kind: 'pass' },
  exit: 0,
  ms: 1000,
  startedAt: 1000,
  argv: ['vitest', 'run'],
  failing: [],
  retries: [],
  artifacts: [],
  envPrepared: true,
  standEpoch: null,
  taskId: null,
  checkRunId: newId(),
  log: { bytes: 0, truncated: false, sha: 'b'.repeat(64) },
  sig: 'c'.repeat(64),
} as never;

function input(fresh: CheckDecisionInput['fresh']): CheckDecisionInput {
  return {
    road: 'model-tool',
    entry: fixtureEntry(),
    unit: 'app',
    selection: [],
    blockers: [],
    key: { value: KEY },
    records: { value: [green] },
    inflight: null,
    phase: 'final',
    changedUnits: ['app'],
    window: checkWindow([], 'final'),
    fresh,
    quarantined: [],
  };
}

/** Строка решения `check`, как её пишет служба проверки (`journalDecision`). */
function journalCheck(task: LiveTask, fresh: CheckDecisionInput['fresh']) {
  const decision = decideCheck(input(fresh));
  task.append({
    kind: 'decision',
    actor: 'core',
    data: {
      decisionId: newId(),
      class: 'check',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [],
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  });
  return decision;
}

const pending = (t: LiveTask) => freshPending(readJournalLines(t.dir, t.taskId).lines);

describe('fresh-rerun (G12, phase 5)', () => {
  it('one command = one run past the green record; the decision line spends it; the next ask replays', async () => {
    const { task: t } = await homeTask();
    open.push(t);
    expect(pending(t)).toBeNull();
    const got = await processCommand(
      t,
      envelope(t, 'fresh-rerun', { scope: 'check', ref: 'tests' }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({ status: 'applied', outcome: { fresh: 'check', ref: 'tests' } });
    expect(pending(t)).toEqual({ scope: 'check', ref: 'tests' });
    expect(journalCheck(t, pending(t)).kind).toBe('run');
    expect(pending(t)).toBeNull();
    expect(journalCheck(t, pending(t)).kind).toBe('replay');
  });

  it('a mark for another check is not spent by this run; two commands give two runs', async () => {
    const { task: t } = await homeTask();
    open.push(t);
    for (const ref of ['lint', 'tests'])
      await processCommand(
        t,
        envelope(t, 'fresh-rerun', { scope: 'check', ref }),
        HUMAN_PROOF,
        commandEnv(),
      );
    // Первая отметка (`lint`) к этой проверке не подходит: суд даёт повтор, отметка цела.
    expect(journalCheck(t, pending(t)).kind).toBe('replay');
    expect(pending(t)).toEqual({ scope: 'check', ref: 'lint' });
  });

  it('a rejected command leaves no mark', async () => {
    const { task: t } = await homeTask();
    open.push(t);
    t.append({
      kind: 'task.ended',
      actor: 'core',
      data: { outcome: 'cancelled' },
    });
    const got = await processCommand(
      t,
      envelope(t, 'fresh-rerun', { scope: 'unit', ref: 'app' }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got.status).toBe('rejected');
    expect(pending(t)).toBeNull();
  });
});

describe('check window from the economy (G12, phase 5)', () => {
  const refused: WindowDecision = {
    routeId: 'claude-login',
    limitKind: 'window',
    verdict: 'refused',
    defer: ['work', 'review', 'background'],
    resumeAt: 5000,
    reasons: ['cli-event 100%'],
  };

  it('a refused route window defers a mid-task check; the final gate never waits; warn holds nothing', () => {
    const mid = { ...input(null), phase: 'mid-task' as const, records: { value: [] } };
    expect(decideCheck({ ...mid, window: checkWindow([refused], 'mid-task') })).toMatchObject({
      kind: 'defer',
      until: 'window',
      reason: 'window refused (economy-window)',
    });
    expect(checkWindow([refused], 'final')).toEqual({ verdict: 'open', basis: 'economy-window' });
    expect(checkWindow([{ ...refused, verdict: 'warn', defer: [] }], 'mid-task')).toEqual({
      verdict: 'warn',
      basis: 'economy-window',
    });
    expect(checkWindow([], 'mid-task')).toEqual({ verdict: 'open', basis: 'economy-window' });
  });
});
