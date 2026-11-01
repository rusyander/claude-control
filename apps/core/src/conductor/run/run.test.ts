import { describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { presetOf, presetStep } from '../scenario/presets.ts';
import { ROUND_CAP_ANSWERS } from '../next/next.types.ts';
import { attempts, openAsk, stand } from './__fixtures__/run-harness.ts';

/**
 * Модельная проверка цикла дирижёра (зона B): сценарий × исход шага × круги через настоящий
 * исполнитель, журнал на диске, настоящие `decideNext` и подъём вопроса. Каждая строка ожидания —
 * попытка шага `<шаг>:<круг>:<состояние>:<основание>` в порядке журнала.
 */

const FEATURE = { id: 'feature', version: 1 };

describe('conductor loop: scenario × outcome × rounds', () => {
  it('feature, clean review: fix skipped, publish runs as a core step, no threads → unit done, task done', async () => {
    const s = await stand(FEATURE);
    await s.run.idle();
    expect(attempts(s.task)).toEqual([
      'intake:0:done:claimed',
      'plan:0:done:claimed',
      'work:0:done:claimed',
      'review:0:done:claimed',
      'fix:0:skipped:core',
      'final-gate:0:done:core',
      'publish:0:done:core',
      'answer-reviewers:0:skipped:core',
    ]);
    expect(s.calls.filter((c) => c.startsWith('publish:'))).toEqual(['publish:publish:0:none']);
    expect(Object.values(s.task.state.units).map((u) => u.state)).toEqual(['done']);
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
    expect(s.calls.filter((c) => c.startsWith('unit-end'))).toHaveLength(1);
    expect(s.task.state.task).toBe('done');
    expect(s.task.state.anomalies).toEqual([]);
    await s.stop();
  });

  it('feature, no publisher wired: publish fails publisher-unwired, the task fails — never «done»', async () => {
    const s = await stand(FEATURE, { publish: { 'publish:0': null } });
    await s.run.idle();
    expect(attempts(s.task).slice(5)).toEqual(['final-gate:0:done:core', 'publish:0:failed:core']);
    const publish = Object.values(s.task.state.steps).find((r) => r.stepDefId === 'publish');
    expect(publish?.reason).toMatch(/^publisher-unwired: /);
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });

  it('review-only: no publish step, the task finishes done', async () => {
    const s = await stand({ id: 'review-only', version: 1 });
    await s.run.idle();
    expect(attempts(s.task)).toEqual([
      'intake:0:done:claimed',
      'review:0:done:claimed',
      'report:0:done:claimed',
    ]);
    expect(s.task.state.task).toBe('done');
    expect(s.task.state.ended).toBe('done');
    expect(s.calls).toContain('task-end:ended');
    await s.stop();
  });

  it('G14 review ⇄ fix bounded by roundCap: cap → point 6; «one more round» runs one more', async () => {
    const blocking = { model: {} as Record<string, 'claim-blocking'> };
    for (const r of [0, 1, 2, 3]) blocking.model[`review:${r}`] = 'claim-blocking';
    const s = await stand(FEATURE, blocking);
    await s.run.idle();
    const ask = openAsk(s.task, 'round-cap:');
    expect(ask).toBeDefined();
    expect(s.task.state.asks[ask!]).toMatchObject({ point: 6, source: 'round-cap' });
    expect(s.task.state.asks[ask!]?.dedupe).toMatch(/^round-cap:.+:review:3$/);
    expect(attempts(s.task).slice(3)).toEqual([
      'review:0:done:claimed',
      'fix:0:done:claimed',
      'review:1:done:claimed',
      'fix:1:done:claimed',
      'review:2:done:claimed',
      'fix:2:done:claimed',
    ]);
    await s.answer(ask!, ROUND_CAP_ANSWERS.more);
    await s.run.idle();
    // Круг 3 дан человеком, он тоже с блокирующей — правка, затем круг 4 — снова вопрос.
    expect(attempts(s.task).slice(9)).toEqual(['review:3:done:claimed', 'fix:3:done:claimed']);
    expect(openAsk(s.task, 'round-cap:')).toMatch(/.+/);
    expect(Object.values(s.task.state.asks).filter((a) => a.source === 'round-cap')).toHaveLength(
      2,
    );
    await s.stop();
  });

  it('G14 red check re-enters the step with a new stepId and round +1', async () => {
    const s = await stand(FEATURE, { post: { 'work:0': 'red' } });
    await s.run.idle();
    const work = attempts(s.task).filter((a) => a.startsWith('work:'));
    expect(work).toEqual(['work:0:failed:core', 'work:1:done:claimed']);
    const old = Object.values(s.task.state.steps).find((x) => x.stepDefId === 'work');
    expect(old?.reason).toMatch(/^superseded: red, round 1/);
    await s.stop();
  });

  it('stop «unit» verdict fails the step, closes the unit and fails the task', async () => {
    const s = await stand(FEATURE, { post: { 'work:0': 'unit' } });
    await s.run.idle();
    expect(attempts(s.task).at(-1)).toBe('work:0:failed:core');
    expect(Object.values(s.task.state.units)[0]?.state).toBe('closed');
    expect(s.task.state.ended).toBe('failed');
    await s.stop();
  });

  it('ask-human scenario step raises point 8 once; the answer closes it with basis human', async () => {
    const ask = presetStep('confirm', 'ask-human', 'Подтверждение', []);
    const sc: Scenario = {
      id: 'ask-flow',
      version: 1,
      title: 't',
      steps: [
        { ...ask, ask: { question: 'Go?', options: ['да', 'нет'], recommendation: 'да' } },
        presetStep('work', 'work', 'Работа', ['confirm']),
      ],
    };
    const s = await stand(sc);
    await s.run.idle();
    const askId = openAsk(s.task, 'scenario-step:');
    expect(s.task.state.asks[askId!]).toMatchObject({ point: 8, source: 'scenario-step' });
    expect(attempts(s.task)).toEqual(['confirm:0:waiting-human:-']);
    await s.answer(askId!, 'да');
    await s.run.idle();
    expect(attempts(s.task)).toEqual(['confirm:0:done:human', 'work:0:done:claimed']);
    expect(Object.keys(s.task.state.asks)).toHaveLength(1);
    expect(s.task.state.ended).toBe('done');
    await s.stop();
  });

  it('an action that throws is not retried hot: one session open, the runner idles «stuck run-step» until a new event', async () => {
    const s = await stand(FEATURE, { openThrows: true });
    const idle = await s.run.idle();
    // Без этого правила упавший запуск сессии повторялся бы при каждой своей же строке журнала.
    expect(idle).toBe('stuck run-step');
    expect(s.port.opened).toHaveLength(1);
    await s.stop();
  });

  it('a preset exists for every reference the stand uses', () => {
    expect(presetOf(FEATURE)?.steps.map((x) => x.id)).toContain('fix');
  });
});
