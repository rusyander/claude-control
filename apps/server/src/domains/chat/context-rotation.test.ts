import { describe, it, expect } from 'vitest';
import { planContextRotation } from './context-rotation.ts';

const base = {
  contextTokens: 250_000,
  limit: 200_000,
  hasProposal: false,
  ok: true,
  hasProject: true,
};

describe('planContextRotation', () => {
  it('предлагает продолжение, когда окно переросло порог', () => {
    const plan = planContextRotation(base);
    expect(plan.kind).toBe('propose');
    if (plan.kind !== 'propose') return;
    expect(plan.contextTokens).toBe(250_000);
    expect(plan.proposal.checkpoint).toBe('.agent/PROGRESS.md');
    // Текст задания отправляет новую сессию читать файл-опору, а не пересказывает
    // задачу: панель её не знает.
    expect(plan.proposal.next).toContain('.agent/PROGRESS.md');
    expect(plan.proposal.done).toContain('250k');
  });

  it('молчит до порога', () => {
    expect(planContextRotation({ ...base, contextTokens: 199_999 }).kind).toBe('none');
  });

  it('молчит, когда слежение выключено нулём', () => {
    expect(planContextRotation({ ...base, limit: 0 }).kind).toBe('none');
  });

  it('уступает предложению агента: оно знает, что именно закрыто', () => {
    expect(planContextRotation({ ...base, hasProposal: true }).kind).toBe('none');
  });

  it('не предлагает после неудачного прогона — там осталась работа', () => {
    expect(planContextRotation({ ...base, ok: false }).kind).toBe('none');
  });

  it('не предлагает вне проекта: новой сессии негде стартовать', () => {
    expect(planContextRotation({ ...base, hasProject: false }).kind).toBe('none');
  });

  it('не срывается на нулевом расходе чужого CLI', () => {
    expect(planContextRotation({ ...base, contextTokens: 0 }).kind).toBe('none');
  });
});
