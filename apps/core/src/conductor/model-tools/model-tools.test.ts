import { describe, expect, it } from 'vitest';
import {
  MODEL_TOOL_NAMES,
  SESSION_STEP_KINDS,
  toolPlanFor,
  type StepDoneCall,
} from '@agentdeck/contracts/core/model-tools';
import { deps, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { resume, type LiveTask } from '../../journal/resume.ts';
import { R1, R2, seedRequirements, seedSession, toolDeps } from './__fixtures__/seed.ts';
import { bindingOf } from './binding.ts';
import { CHECK_ABSENT, handleModelTool, TOOL_NOT_IN_PLAN } from './model-tools.ts';
import type { RecordVerdict, SessionBinding } from './model-tools.types.ts';

/**
 * Инструменты модели (03 §Model tools): P72 (ошибки полей один раз, повтор — отказ), P08
 * (заявление без зелёной записи отказано), P73 (набор по виду шага), P20/P96 (вопрос вне
 * закрытого списка не блокирует, развилка — в отчёт), P42 для вызова модели (нет поля — не
 * подставляется). Всё — через журнал: решает то, что в строках, а не память ядра.
 */

async function stepOf(stepKind: string) {
  const fresh = await openFresh();
  seedRequirements(fresh.task);
  const seeded = seedSession(fresh.task, { stepKind });
  const bound = bindingOf(fresh.task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { ...fresh, ...seeded, b: bound.binding };
}

function lines(task: LiveTask) {
  return readJournalLines(task.dir, task.taskId).lines;
}

function claim(b: SessionBinding, over: Partial<StepDoneCall> = {}): StepDoneCall {
  return {
    stepId: b.stepId,
    outcome: 'done',
    requirements: [{ id: R1, state: 'covered', evidence: ['rec-green'] }],
    summary: 'did the work',
    ...over,
  };
}

describe('model tools', () => {
  it('P72 an invalid step_done returns its field errors once; a repeat is a counted refusal, also across a core restart', async () => {
    const { task, dir, taskId, b } = await stepOf('work');
    const bad = { stepId: b.stepId, requirements: [], summary: 'x', extra: 1 };
    const first = await handleModelTool(task, b, 'step_done', bad, toolDeps());
    expect(first).toMatchObject({ ok: false, code: 'invalid' });
    const issues = (first as { issues: { path: string; code: string }[] }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'outcome', code: 'missing-field' }),
        expect.objectContaining({ path: 'extra', code: 'unknown-field' }),
      ]),
    );
    const second = await handleModelTool(task, b, 'step_done', bad, toolDeps());
    expect(second).toMatchObject({ ok: false, code: 'invalid-repeat' });
    expect(second).not.toHaveProperty('issues');
    task.close();
    // Новое ядро читает счёт из журнала: второго списка ошибок модель не получит.
    const reopened = await resume(dir, taskId, deps());
    if (!reopened.ok) throw new Error(reopened.reason);
    const third = await handleModelTool(reopened.task, b, 'step_done', bad, toolDeps());
    expect(third).toMatchObject({ ok: false, code: 'invalid-repeat' });
    const refusals = lines(reopened.task)
      .filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { detail: string }).detail.split(':')[0]);
    expect(refusals).toEqual(['refusal 1', 'refusal 2', 'refusal 3']);
    expect(reopened.task.state.steps[b.stepId]?.state).toBe('running');
    reopened.task.close();
  });

  it('P42 a model call missing a field is never defaulted: no claim line, the step stays running', async () => {
    const { task, b } = await stepOf('work');
    const { outcome: _o, ...missing } = claim(b);
    const before = task.state.seq;
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      missing,
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    const written = lines(task).slice(before);
    expect(written.map((l) => l.kind)).toEqual(['signal']);
    expect(task.state.steps[b.stepId]?.state).toBe('running');
    // То же для вопроса человеку: без `blocking` вопрос не становится ни блокирующим, ни нет.
    const ask = handleModelTool(
      task,
      b,
      'ask_human',
      { question: 'q', options: ['a', 'b'], recommendation: 'a' },
      toolDeps(),
    );
    expect(ask).toMatchObject({ ok: false, code: 'invalid' });
    expect(lines(task).slice(before + 1)).toEqual([]);
    task.close();
  });

  it('step_done fields foreign to the step kind and an oversized claim are field errors', async () => {
    const { task, b } = await stepOf('work');
    const finding = { file: 'a.ts', line: 1, severity: 'minor', text: 'x' } as const;
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      claim(b, { findings: [finding], handoff: 'x'.repeat(4000), summary: 'y'.repeat(600) }),
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect((reply as { issues: { path: string }[] }).issues.map((i) => i.path)).toContain(
      'findings',
    );
    const review = await stepOf('review');
    const ok = await handleModelTool(
      review.task,
      review.b,
      'step_done',
      claim(review.b, { findings: [finding] }),
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(ok).toMatchObject({ ok: true });
    task.close();
    review.task.close();
  });

  it('P08 a claim citing a missing, red, no-verdict or unreadable record is rejected; green records are accepted', async () => {
    for (const verdict of [undefined, 'fail', 'no-verdict', 'unreadable'] as const) {
      const { task, b } = await stepOf('work');
      const records: Record<string, RecordVerdict | 'unreadable'> = verdict
        ? { 'rec-green': verdict }
        : {};
      const reply = await handleModelTool(task, b, 'step_done', claim(b), toolDeps(records));
      expect(reply, String(verdict)).toMatchObject({ ok: false, code: 'evidence-rejected' });
      expect(lines(task).some((l) => l.kind === 'step.claimed')).toBe(false);
      expect(task.state.steps[b.stepId]?.state).toBe('running');
      task.close();
    }
    const { task, b } = await stepOf('work');
    const call = claim(b, {
      requirements: [
        { id: R1, state: 'covered', evidence: ['rec-green', 'rec-flaky'] },
        { id: R2, state: 'n/a', evidence: 'docs only' },
      ],
    });
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      call,
      toolDeps({ 'rec-green': 'pass', 'rec-flaky': 'pass-flaky' }),
    );
    expect(reply).toMatchObject({ ok: true, result: { accepted: true } });
    // Одна типизированная строка: заявление целиком + переход в проверку, без телеметрии.
    const written = lines(task)
      .filter((l) => l.stepId === b.stepId)
      .map((l) => l.kind);
    expect(written.filter((k) => k === 'step.claimed')).toHaveLength(1);
    expect(written).not.toContain('tool.event');
    expect(written.filter((k) => k === 'step.transition')).toHaveLength(1); // только старт шага
    const claimed = lines(task).find((l) => l.kind === 'step.claimed');
    expect(claimed?.data).toEqual({ stepId: b.stepId, sessionId: b.sessionId, claim: call });
    expect(claimed?.actor).toBe(`session:${b.sessionId}`);
    expect(task.state.steps[b.stepId]).toMatchObject({
      state: 'checking',
      claim: { seq: claimed?.seq, call },
    });
    // Шаг уже на проверке: второе заявление отказано, а не принято поверх.
    const again = await handleModelTool(
      task,
      b,
      'step_done',
      call,
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(again).toMatchObject({ ok: false, code: 'step-not-running' });
    task.close();
  });

  it('step_done for another step is refused', async () => {
    const { task, b } = await stepOf('work');
    const other = seedSession(task, { stepKind: 'work', unitId: b.unitId });
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      claim(b, { stepId: other.stepId }),
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(reply).toMatchObject({ ok: false, code: 'foreign-step' });
    task.close();
  });

  it('stage 8: step_done after a stop-step signal on the step is refused with its reason — the step stays running for the stop, no claim row', async () => {
    const { task, b } = await stepOf('work');
    const signal = (action: 'stop-step' | 'show', severity: 'stop' | 'warn') =>
      task.append({
        kind: 'signal',
        actor: 'core',
        stepId: b.stepId,
        sessionId: b.sessionId,
        data: {
          signal: 'waste-fail-repeat',
          severity,
          action,
          subject: 'node fail.js',
          detail: '',
        },
      });
    // Near-miss: показанный сигнал шаг не останавливает — заявление идёт.
    signal('show', 'warn');
    expect(task.state.steps[b.stepId]?.stops).toEqual([]);
    signal('stop-step', 'stop');
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      claim(b),
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(reply).toMatchObject({
      ok: false,
      code: 'step-stopped',
      message: 'step stopped: waste-fail-repeat: node fail.js',
    });
    expect(lines(task).filter((l) => l.kind === 'step.claimed')).toEqual([]);
    expect(task.state.steps[b.stepId]?.state).toBe('running');
    task.close();
  });

  it('stage 8 near-miss: a shown (not stop) signal on the step leaves step_done accepted', async () => {
    const { task, b } = await stepOf('work');
    task.append({
      kind: 'signal',
      actor: 'core',
      stepId: b.stepId,
      sessionId: b.sessionId,
      data: { signal: 'waste-poll', severity: 'warn', action: 'show', subject: 'x', detail: '' },
    });
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      claim(b),
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(reply).toMatchObject({ ok: true, result: { accepted: true } });
    task.close();
  });

  it('P73 the tool list depends on the step kind; no publish, config or grant tool exists', async () => {
    expect(
      MODEL_TOOL_NAMES.filter((n) => /publish|config|grant|push|merge|permit/.test(n)),
    ).toEqual([]);
    for (const kind of SESSION_STEP_KINDS) expect(toolPlanFor(kind), kind).not.toBeNull();
    for (const kind of ['check', 'final-gate', 'publish', 'ask-human', 'nope']) {
      expect(toolPlanFor(kind), kind).toBeNull();
    }
    expect(toolPlanFor('review')).toEqual({
      builtins: 'read-only',
      modelTools: ['step_done', 'check', 'ask_human', 'blocker', 'core_state', 'unit_diff'],
    });
    // Дифф файла единицы — только тем, кто судит сделанную правку.
    const withDiff = SESSION_STEP_KINDS.filter((k) =>
      toolPlanFor(k)?.modelTools.includes('unit_diff'),
    );
    expect(withDiff).toEqual(['review', 'answer-reviewers']);
    expect(toolPlanFor('research')).toEqual({
      builtins: 'read-only',
      modelTools: ['step_done', 'ask_human', 'blocker', 'core_state'],
    });
    expect(toolPlanFor('work')?.builtins).toBe('all');
    // Этап 10: чат кончает человек командой `end-chat` — заявления модели «шаг сделан» у него нет.
    expect(toolPlanFor('chat')).toEqual({
      builtins: 'all',
      modelTools: ['check', 'ask_human', 'blocker', 'core_state'],
    });
    const noDone = SESSION_STEP_KINDS.filter(
      (k) => !toolPlanFor(k)?.modelTools.includes('step_done'),
    );
    expect(noDone).toEqual(['chat']);
    // Решение 28.10: разбор задачи, план и деление только читают — как ревью и отчёт.
    const readOnly = SESSION_STEP_KINDS.filter((k) => toolPlanFor(k)?.builtins === 'read-only');
    // Этап 12: проход по стенду (`walk`) тоже только читает — копию он не меняет.
    expect(readOnly).toEqual(['intake', 'plan', 'research', 'split', 'review', 'report', 'walk']);
    const { task, b } = await stepOf('research');
    const reply = handleModelTool(task, b, 'check', { checkId: 'unit' }, toolDeps());
    expect(reply).toMatchObject({ ok: false, code: TOOL_NOT_IN_PLAN });
    const unknown = handleModelTool(task, b, 'publish', {}, toolDeps());
    expect(unknown).toMatchObject({ ok: false, code: TOOL_NOT_IN_PLAN });
    task.close();
  });

  it('check returns a shaped no-verdict result while the verifier does not exist', async () => {
    const { task, b } = await stepOf('work');
    const before = task.state.seq;
    expect(handleModelTool(task, b, 'check', { checkId: 'unit' }, toolDeps())).toEqual({
      ok: true,
      result: CHECK_ABSENT,
    });
    expect(
      handleModelTool(task, b, 'check', { checkId: 'a', argv: ['x'] }, toolDeps()),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(task.state.seq).toBe(before);
    task.close();
  });

  it('check with the verifier wired goes to it once per call; its failure is a named check-failed, not a crash', async () => {
    const { task, b } = await stepOf('work');
    const calls: unknown[] = [];
    const wired = {
      ...toolDeps(),
      check: async (_t: LiveTask, bb: SessionBinding, call: unknown) => {
        calls.push([bb.stepId, call]);
        if ((call as { checkId?: string }).checkId === 'boom') throw new Error('queue unreadable');
        return { verdict: 'pass' };
      },
    };
    const reply = await handleModelTool(task, b, 'check', { checkId: 'unit' }, wired);
    expect(reply).toEqual({ ok: true, result: { verdict: 'pass' } });
    expect(calls).toEqual([[b.stepId, { checkId: 'unit' }]]);
    const failed = await handleModelTool(task, b, 'check', { checkId: 'boom' }, wired);
    expect(failed).toEqual({ ok: false, code: 'check-failed', message: 'queue unreadable' });
    // Неверный вызов отказан до обвязки: верификатор его не видит.
    const bad = await handleModelTool(task, b, 'check', { checkId: 'a', argv: ['x'] }, wired);
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
    expect(calls).toHaveLength(2);
    task.close();
  });

  it('P20 P96 an off-list blocking ask turns non-blocking and its fork goes to the report; an on-list action blocks', async () => {
    const { task, b } = await stepOf('work');
    const offList = handleModelTool(
      task,
      b,
      'ask_human',
      // Слово «merge» в прозе ничего не решает: решает только типизированное действие.
      {
        question: 'Should I merge it?',
        options: ['merge', 'wait'],
        recommendation: 'wait',
        blocking: true,
      },
      toolDeps(),
    );
    expect(offList).toMatchObject({
      ok: true,
      result: { humanPoint: false, blocking: false, proceedWith: 'wait' },
    });
    expect(lines(task).some((l) => l.kind === 'human.asked')).toBe(false);
    const decision = lines(task).find((l) => l.kind === 'decision');
    expect(decision?.data).toMatchObject({
      class: 'human-point',
      output: { point: null, blocking: false, fork: { question: 'Should I merge it?' } },
    });
    expect(task.state.steps[b.stepId]?.state).toBe('running');

    const ownPush = handleModelTool(
      task,
      b,
      'ask_human',
      {
        question: 'push?',
        options: ['push', 'no'],
        recommendation: 'push',
        blocking: true,
        action: { kind: 'forge-write', target: 'push' },
      },
      toolDeps(),
    );
    expect(ownPush).toMatchObject({ ok: true, result: { humanPoint: false } });

    const merge = handleModelTool(
      task,
      b,
      'ask_human',
      {
        question: 'merge the MR?',
        options: ['merge', 'wait'],
        recommendation: 'wait',
        blocking: true,
        action: { kind: 'merge', target: '!12' },
      },
      toolDeps(),
    );
    expect(merge).toMatchObject({
      ok: true,
      result: { humanPoint: true, point: 1, blocking: true },
    });
    const asked = lines(task).filter((l) => l.kind === 'human.asked');
    expect(asked.map((l) => (l.data as { point: number }).point)).toEqual([1]);
    expect(task.state.steps[b.stepId]?.state).toBe('waiting-human');
    task.close();
  });

  it('human-point items by typed action: user path classes, grantRequired, tracker writes, access blockers', async () => {
    const { task, b } = await stepOf('work');
    const ask = (action: { kind: string; target: string }) =>
      handleModelTool(
        task,
        b,
        'ask_human',
        { question: 'q', options: ['a', 'b'], recommendation: 'a', blocking: false, action },
        toolDeps(),
      );
    expect(ask({ kind: 'path', target: 'infra/main.tf' })).toMatchObject({ result: { point: 5 } });
    expect(ask({ kind: 'path', target: 'migrations/001.sql' })).toMatchObject({
      result: { point: 5 },
    });
    expect(ask({ kind: 'path', target: 'src/a.ts' })).toMatchObject({
      result: { humanPoint: false },
    });
    expect(ask({ kind: 'action-class', target: 'schema-change' })).toMatchObject({
      result: { point: 5 },
    });
    expect(ask({ kind: 'tracker-write', target: 'PROJ-1' })).toMatchObject({
      result: { point: 9 },
    });
    expect(ask({ kind: 'forge-write', target: 'label' })).toMatchObject({
      result: { humanPoint: false },
    });
    // Неблокирующий пункт списка: вопрос записан с действием по умолчанию, шаг идёт дальше.
    expect(task.state.steps[b.stepId]?.state).toBe('running');

    const env = handleModelTool(
      task,
      b,
      'blocker',
      { kind: 'env', detail: 'no docker' },
      toolDeps(),
    );
    expect(env).toMatchObject({ ok: true, result: { humanPoint: false } });
    const access = handleModelTool(
      task,
      b,
      'blocker',
      { kind: 'access', detail: 'repo read denied' },
      toolDeps(),
    );
    expect(access).toMatchObject({ ok: true, result: { point: 4, blocking: true } });
    expect(task.state.steps[b.stepId]?.state).toBe('waiting-human');
    const blockers = lines(task).filter(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === 'step-blocker',
    );
    expect(blockers).toHaveLength(2);
    task.close();

    // Пункты 1–4 блокируют всегда: `blocking:false` модели их не снимает (F-46).
    const other = await stepOf('work');
    expect(
      handleModelTool(
        other.task,
        other.b,
        'ask_human',
        {
          question: 'q',
          options: ['a', 'b'],
          recommendation: 'a',
          blocking: false,
          action: { kind: 'db-write', target: 'prod' },
        },
        toolDeps(),
      ),
    ).toMatchObject({ result: { point: 3, blocking: true } });
    expect(other.task.state.steps[other.b.stepId]?.state).toBe('waiting-human');
    other.task.close();
  });

  it('core_state reads the step and writes nothing; a session that ended gets no tools', async () => {
    const { task, b, sessionId } = await stepOf('plan');
    const before = task.state.seq;
    expect(handleModelTool(task, b, 'core_state', {}, toolDeps())).toMatchObject({
      ok: true,
      result: { step: { stepId: b.stepId, kind: 'plan', state: 'running' }, openAsks: [] },
    });
    expect(handleModelTool(task, b, 'core_state', { x: 1 }, toolDeps())).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(task.state.seq).toBe(before);
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: { sessionId, event: 'exited', from: 'live', to: 'ended' },
    });
    expect(bindingOf(task, sessionId)).toMatchObject({ refused: 'session-ended' });
    expect(bindingOf(task, '019a0000-0000-7000-8000-000000000000')).toMatchObject({
      refused: 'no-session',
    });
    task.close();
  });
});
