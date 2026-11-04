import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { SDK_PERMIT_CODEC } from '../../adapters/sdk-stream/permit-codec.ts';
import { answerHookCall } from '../../api/session-hook.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createPendingPermits } from '../../policy/permit/pending.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { seedSession } from '../model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../model-tools/binding.ts';
import type { PermitCallDeps } from '../model-tools/model-tools.types.ts';
import { answerPermitCall } from '../model-tools/permit-call.ts';

/**
 * P130 (06 §Session permissions, G15): отказ права с пунктом человека (3 — источник адреса
 * сервиса, 5 — правка под `grantRequired`) поднимает этот пункт — `human.asked`, шаг ждёт — один
 * раз на ждущий запрос; повтор того же вызова и повтор ответа права нового вопроса не дают. Грант
 * человека открывает правку посреди шага, обеими дорогами.
 */

function context(copyRoot: string): PermitContext {
  return {
    copyRoot,
    ownedPaths: ['**'],
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platformPaths: [tempDir('home-')],
    endpointSources: [`${copyRoot}/.env.prod`],
    grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
    grants: [],
  };
}

async function setup() {
  const { task } = await openFresh();
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const gate = createPendingPermits({ selfToolNames: ['mcp__agentdeck-permit__approve'] });
  const deps: PermitCallDeps = {
    gate,
    codec: SDK_PERMIT_CODEC,
    mapPermission: mapClaudePermission,
    context: context(tempDir('copy-')),
    settleMs: 80,
  };
  const pending = (toolUseId: string, name: string) =>
    gate.observe(seeded.sessionId, { type: 'tool.requested', toolUseId, name, input: {} } as never);
  return { task, b: bound.binding, deps, pending, ...seeded };
}

function asks(task: LiveTask) {
  return readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'human.asked')
    .map((l) => l.data as { point: number; source: string; dedupe: string | null });
}

const edit = (file: string) => ({ tool: 'Edit', input: { file_path: file } });

describe('P130 permit deny with a human point', () => {
  it('P130 hook road: a grant-required edit raises item 5 once and the step waits; the same call again raises none', async () => {
    const s = await setup();
    const first = answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps);
    expect(first.allow).toBe(false);
    expect(asks(s.task)).toMatchObject([{ point: 5, source: 'permit' }]);
    expect(s.task.state.steps[s.stepId]?.state).toBe('waiting-human');
    answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps);
    answerHookCall(s.task, s.b, edit('./migrations/1.sql'), s.deps);
    expect(asks(s.task)).toHaveLength(1);
    // Другая цель под тем же замком — другой ждущий запрос, свой вопрос.
    answerHookCall(s.task, s.b, edit('migrations/2.sql'), s.deps);
    expect(asks(s.task)).toHaveLength(2);
    s.task.close();
  });

  it('P130 permit road: the deny raises item 5; a replayed permit answer is forged and raises none', async () => {
    const s = await setup();
    s.pending('toolu_g', 'Edit');
    const raw = {
      tool_name: 'Edit',
      input: { file_path: 'migrations/1.sql' },
      tool_use_id: 'toolu_g',
    };
    const first = await answerPermitCall(s.task, s.b, raw, s.deps);
    expect(first).toMatchObject({ kind: 'decided', allow: false });
    const replay = await answerPermitCall(s.task, s.b, raw, s.deps);
    expect(replay.kind).toBe('forged');
    expect(asks(s.task)).toMatchObject([{ point: 5, source: 'permit' }]);
    s.task.close();
  });

  it('P130 an endpoint-source read raises item 3; a deny without a point raises nothing', async () => {
    const s = await setup();
    const read = answerHookCall(
      s.task,
      s.b,
      { tool: 'Read', input: { file_path: '.env.prod' } },
      s.deps,
    );
    expect(read.allow).toBe(false);
    expect(asks(s.task)).toMatchObject([{ point: 3, source: 'permit' }]);
    const outside = answerHookCall(s.task, s.b, edit('../outside.ts'), s.deps);
    expect(outside.allow).toBe(false);
    expect(asks(s.task)).toHaveLength(1);
    s.task.close();
  });

  it('a grant given mid-step opens the edit on both roads, only for the project of the unit', async () => {
    const s = await setup();
    const give = (project: string) =>
      s.task.append({
        kind: 'grant.given',
        actor: 'core',
        data: { cmdId: newId(), project, globs: ['migrations/**'], ops: ['edit'] },
      });
    give('other-repo');
    expect(answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps).allow).toBe(false);
    give('r1');
    expect(answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps).allow).toBe(true);
    s.pending('toolu_ok', 'Edit');
    const viaPermit = await answerPermitCall(
      s.task,
      s.b,
      { tool_name: 'Edit', input: { file_path: 'migrations/3.sql' }, tool_use_id: 'toolu_ok' },
      s.deps,
    );
    expect(viaPermit).toMatchObject({ kind: 'decided', allow: true });
    s.task.close();
  });
});

/**
 * Повтор модели после ответа человека (этап 10, G5): тот же ключ `dedupe` — тот же вопрос. Ждущий
 * вопрос переиспользуется (ни строки, ни нового уведомления — пересылка панели шлёт по строке
 * `human.asked`), отвеченный решает повтор записанным ответом: «отказать» — отказ без вопроса,
 * «разрешить»/«грант» — этот же вызов этого же шага проходит. Раньше каждый повтор после ответа
 * поднимал НОВЫЙ `human.asked` с тем же ключом, и человека спрашивали снова.
 */
describe('a model retry after the human answered reuses the ask by its dedupe key', () => {
  const proof = async (): Promise<CommandProof> => ({
    token: 'core',
    nonce: 'valid',
    peer: 'clear',
    signature: 'absent',
  });

  async function answer(s: Awaited<ReturnType<typeof setup>>, askId: string, text: string) {
    const out = await processCommand(
      s.task,
      {
        cmdId: newId(),
        kind: 'answer',
        target: { taskId: s.task.taskId },
        fields: { askId, answer: text },
        proof: {},
      } as CommandEnvelope,
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied' });
  }

  async function asked(file = 'migrations/1.sql') {
    const s = await setup();
    s.task.append({ kind: 'task.created', actor: 'core', data: CREATED });
    expect(answerHookCall(s.task, s.b, edit(file), s.deps).allow).toBe(false);
    const askId = readJournalLines(s.task.dir, s.task.taskId).lines.find(
      (l) => l.kind === 'human.asked',
    )?.data as { askId: string } | undefined;
    if (!askId) throw new Error('no ask raised');
    return { s, askId: askId.askId };
  }

  it('a pending ask: the retry on both roads writes no new human.asked', async () => {
    const { s } = await asked();
    expect(answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps).allow).toBe(false);
    s.pending('toolu_r1', 'Edit');
    const viaPermit = await answerPermitCall(
      s.task,
      s.b,
      { tool_name: 'Edit', input: { file_path: 'migrations/1.sql' }, tool_use_id: 'toolu_r1' },
      s.deps,
    );
    expect(viaPermit).toMatchObject({ kind: 'decided', allow: false });
    expect(asks(s.task)).toHaveLength(1);
    s.task.close();
  });

  it('answered «refuse»: the retry is refused with the stored answer, nobody is asked again', async () => {
    const { s, askId } = await asked();
    await answer(s, askId, 'refuse');
    const hook = answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps);
    expect(hook.allow).toBe(false);
    expect(asks(s.task)).toHaveLength(1);
    expect(hook.reason).toContain(askId);
    s.pending('toolu_r2', 'Edit');
    const viaPermit = await answerPermitCall(
      s.task,
      s.b,
      { tool_name: 'Edit', input: { file_path: './migrations/1.sql' }, tool_use_id: 'toolu_r2' },
      s.deps,
    );
    expect(viaPermit).toMatchObject({ kind: 'decided', allow: false });
    expect(asks(s.task)).toHaveLength(1);
    // Шаг не встаёт ждать второй раз: ответ уже есть.
    expect(s.task.state.steps[s.stepId]?.state).toBe('running');
    s.task.close();
  });

  it('answered «grant»: the same call of the same step passes; another target still asks', async () => {
    const { s, askId } = await asked();
    await answer(s, askId, 'grant');
    const hook = answerHookCall(s.task, s.b, edit('migrations/1.sql'), s.deps);
    expect(asks(s.task)).toHaveLength(1);
    expect(hook).toMatchObject({ allow: true });
    expect(hook.reason).toContain(askId);
    expect(asks(s.task)).toHaveLength(1);
    expect(answerHookCall(s.task, s.b, edit('migrations/2.sql'), s.deps).allow).toBe(false);
    expect(asks(s.task)).toHaveLength(2);
    s.task.close();
  });

  it('answered «allow» on item 3: the endpoint-source read passes on retry, no new ask', async () => {
    const s = await setup();
    s.task.append({ kind: 'task.created', actor: 'core', data: CREATED });
    const read = { tool: 'Read', input: { file_path: '.env.prod' } };
    expect(answerHookCall(s.task, s.b, read, s.deps).allow).toBe(false);
    const askId = (
      readJournalLines(s.task.dir, s.task.taskId).lines.find((l) => l.kind === 'human.asked')
        ?.data as { askId: string }
    ).askId;
    await answer(s, askId, 'allow');
    expect(answerHookCall(s.task, s.b, read, s.deps).allow).toBe(true);
    expect(asks(s.task)).toHaveLength(1);
    s.task.close();
  });
});
