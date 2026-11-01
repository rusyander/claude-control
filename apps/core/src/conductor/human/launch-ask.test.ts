import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConductorWiringDeps } from '../../bootstrap/conductor-wiring/conductor-wiring.types.ts';
import { humanHooks } from '../../bootstrap/conductor-wiring/human.ts';
import { splitHooksWith } from '../../bootstrap/conductor-wiring/split.ts';
import { deps, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand, type CommandEnv } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { estimateTask } from '../estimate/index.ts';
import { SEED_HUMAN_POLICY } from '../model-tools/__fixtures__/seed.ts';
import type { ConductorHooks, StepCtx } from '../run/run.types.ts';
import { presetOf } from '../scenario/index.ts';
import { estimateBody, gitRepo, testEnv, type TestEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { readHumanLedger } from './ledger.ts';
import { raiseHumanPoint } from './raise.ts';

/**
 * Пункт 10 (подтвердить деление) закрывается запуском (P71, 06 §Human points): утверждение
 * человеком — ответ на вопрос о ЭТОМ делении; вопрос о прежнем делении — снят; после краха между
 * запуском и закрытием — снят первым же шагом. Иначе бегущая задача держала открытый блокирующий
 * вопрос: карточка, напоминания и итоговый отчёт говорили о решённом.
 */

let root: string;
let registry: TaskRegistry;
let env: TestEnv;
/** Среда команд, как её даёт API запущенного дирижёра: тот же дом, та же среда деления. */
let cmdEnv: CommandEnv;
let split: ConductorHooks;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-launch-ask-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
  cmdEnv = commandEnv({ layout, split: env });
  split = splitHooksWith(
    { registry, layout, note: () => undefined } as unknown as ConductorWiringDeps,
    env,
  );
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

const of = <K extends JournalLine['kind']>(task: LiveTask, kind: K): JournalLine<K>[] =>
  readJournalLines(task.dir, task.taskId).lines.filter((l): l is JournalLine<K> => l.kind === kind);

const launchRaise = (dedupe: string) => ({
  source: 'launch' as const,
  stepId: null,
  sessionId: null,
  action: { kind: 'launch' as const, target: dedupe },
  point: 10 as const,
  dedupe,
  question: 'Launch the task?',
  options: ['approve-split', 'edit-split', 'cancel'],
  recommendation: 'approve-split',
  blocking: true,
});

describe('point 10 closes on launch', () => {
  it('P71 approve-split answers the launch ask of that split once; an ask about an older split is withdrawn', async () => {
    const repo = gitRepo(root, 'rev');
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'review-only' } }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const task = registry.live(out.reply.taskId) as LiveTask;
    const def = presetOf({ id: 'review-only', version: 1 })?.steps.find((s) => s.kind === 'intake');
    if (!def) throw new Error('no intake step');
    const unitId = Object.keys(task.state.units)[0] as string;
    const s: StepCtx = {
      taskId: task.taskId,
      unitId,
      repoKey: task.state.units[unitId]?.repoKey ?? '',
      copyDir: null,
      stepId: newId(),
      def,
      round: 0,
      sessionId: null,
    };
    const sessionId = newId();
    const claim: StepDoneCall = {
      stepId: s.stepId,
      outcome: 'done',
      requirements: [],
      reviewTargets: [{ ref: '!11' }, { ref: '!12' }],
      summary: 'review targets',
    };
    task.append({
      kind: 'step.claimed',
      actor: `session:${sessionId}`,
      stepId: s.stepId,
      sessionId,
      data: { stepId: s.stepId, sessionId, claim },
    });
    await split.postStep?.(s, claim);
    expect(task.state.task).toBe('awaiting-launch');
    const splitId = of(task, 'split.proposed')[0]?.data.splitId as string;
    const [current] = of(task, 'human.asked').map((l) => l.data.askId);
    // Вопрос о прежнем делении, оставшийся открытым (человек правил деление).
    const stale = raiseHumanPoint(task, launchRaise(`split:${newId()}`), {
      policy: SEED_HUMAN_POLICY,
    });
    if (stale.kind !== 'asked') throw new Error(stale.kind);

    const approve: CommandEnvelope = {
      cmdId: newId(),
      kind: 'approve-split',
      target: { taskId: task.taskId },
      fields: { splitId } as CommandEnvelope['fields'],
      proof: {},
    };
    expect(await processCommand(task, approve, proof, cmdEnv)).toMatchObject({ status: 'applied' });
    expect(task.state.task).toBe('running');

    const ledger = readHumanLedger(task);
    expect(ledger.asks[current as string]?.state).toBe('answered');
    expect(ledger.asks[stale.askId]?.state).toBe('withdrawn');
    expect(of(task, 'human.answered').map((l) => [l.data.askId, l.data.answer, l.actor])).toEqual([
      [current, 'approve-split', 'human:panel'],
    ]);
    expect(of(task, 'human.answered')[0]?.cmdId).toBe(approve.cmdId);
    // Первый шаг запущенной задачи не пишет второго закрытия.
    const before = of(task, 'ask.transition').length;
    await humanHooks({ registry, note: () => {} } as never).preStep!({
      ...s,
      stepId: newId(),
    } as never);
    expect(of(task, 'ask.transition')).toHaveLength(before);
  });

  it('P71 a launch ask left open past awaiting-launch (crash after launch) is withdrawn at the next step', async () => {
    const { task, taskId } = await openFresh();
    const asked = raiseHumanPoint(task, launchRaise(`split:${newId()}`), {
      policy: SEED_HUMAN_POLICY,
    });
    if (asked.kind !== 'asked') throw new Error(asked.kind);
    expect(task.state.task).not.toBe('awaiting-launch');
    const hooks = humanHooks({ registry: { live: () => task }, note: () => {} } as never);
    await hooks.preStep!({ taskId, unitId: newId(), stepId: newId(), copyDir: null } as never);
    expect(readHumanLedger(task).asks[asked.askId]?.state).toBe('withdrawn');
    expect(of(task, 'human.answered')).toEqual([]);
    task.close();
  });
});
