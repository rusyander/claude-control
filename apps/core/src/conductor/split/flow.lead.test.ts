import { describe, expect, it } from 'vitest';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { isLedTask } from './index.ts';

/**
 * Задача ведущего (этап 11) на оценке, до любых строк сценария: крючки ведущего
 * (`conductor-wiring/lead.ts`) узнают её по сценарию, названному в `task.created` — свёртка
 * ставит его в `scenario.ref` сразу. Журнал — настоящим писателем во временном каталоге.
 */

async function createdWith(scenario: { id: string; version: number }) {
  const { task } = await openFresh();
  task.append({ kind: 'task.created', actor: 'core', data: { ...CREATED, scenario } });
  return task;
}

describe('stage 11 isLedTask before the scenario is bound', () => {
  it('stage 11 isLedTask: lead and tracker-ticket v2 named at creation are led before binding; tracker-ticket v1, default and no task are not', async () => {
    const lead = await createdWith({ id: 'lead', version: 1 });
    expect(lead.state.scenario?.ref).toEqual({ id: 'lead', version: 1 });
    expect(isLedTask(lead)).toBe(true);
    expect(isLedTask(await createdWith({ id: 'tracker-ticket', version: 2 }))).toBe(true);
    expect(isLedTask(await createdWith({ id: 'tracker-ticket', version: 1 }))).toBe(false);
    expect(isLedTask(await createdWith({ id: 'default', version: 1 }))).toBe(false);
    expect(isLedTask(undefined)).toBe(false);
  });
});
