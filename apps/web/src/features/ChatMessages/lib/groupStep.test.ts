import { describe, expect, it } from 'vitest';
import type { ChatProgress } from '@agentdeck/contracts';

import { groupStep } from './groupStep';

const task = (text: string, status: 'pending' | 'in_progress' | 'completed') => ({ text, status });
const agent = (status: 'running' | 'done' | 'failed') => ({
  id: 'a',
  kind: 'agent',
  description: 'r',
  status,
});

describe('groupStep', () => {
  it('шаг — номер пункта «в работе», имя — его текст, агенты — только живые', () => {
    const progress = {
      tasks: [
        ...Array.from({ length: 7 }, (_, i) => task(`s${i}`, 'completed')),
        task('Ревью', 'in_progress'),
        ...Array.from({ length: 6 }, (_, i) => task(`p${i}`, 'pending')),
      ],
      agents: [agent('running'), agent('running'), agent('done')],
    } as ChatProgress;
    expect(groupStep(progress, true)).toEqual({ current: 8, total: 14, name: 'Ревью', agents: 2 });
  });

  it('между шагами — номер последнего сделанного, без имени', () => {
    const progress = {
      tasks: [task('a', 'completed'), task('b', 'completed'), task('c', 'pending')],
      agents: [],
    } as ChatProgress;
    expect(groupStep(progress, true)).toEqual({ current: 2, total: 3, agents: 0 });
  });

  it('ничего не начато — первый шаг, а не «0 из N»', () => {
    const progress = { tasks: [task('a', 'pending')], agents: [] } as ChatProgress;
    expect(groupStep(progress, true)?.current).toBe(1);
  });

  it('ни плана, ни навыка, ни живых агентов — шага нет', () => {
    expect(groupStep({ tasks: [], agents: [agent('done')] } as ChatProgress, true)).toBeUndefined();
    expect(groupStep(undefined, true)).toBeUndefined();
  });

  // Ревью 29.09 (B1): агенты групп TodoWrite не зовут — шаг берётся из навыка.
  it('плана нет — шаг по навыку, без номера, с живыми агентами', () => {
    const progress = {
      tasks: [],
      agents: [agent('running'), agent('running'), agent('done')],
      skill: { name: 'deep-review' },
    } as ChatProgress;
    expect(groupStep(progress, true)).toEqual({ name: 'deep-review', agents: 2 });
  });

  // Холодная проверка 29.09 (N4): стоящая группа навыком шага не зовёт.
  it('группа не идёт — навык и агенты шагом не показываются, план — да', () => {
    const progress = {
      tasks: [],
      agents: [],
      skill: { name: 'requirements-grilling' },
    } as ChatProgress;
    expect(groupStep(progress, false)).toBeUndefined();
    const planned = {
      tasks: [task('а', 'completed'), task('б', 'pending')],
      agents: [],
    } as unknown as ChatProgress;
    expect(groupStep(planned, false)?.total).toBe(2);
  });

  it('плана и навыка нет, а агенты работают — шаг с их числом и описанием', () => {
    const progress = { tasks: [], agents: [agent('running')] } as ChatProgress;
    expect(groupStep(progress, true)).toEqual({ name: 'r', agents: 1 });
  });
});
