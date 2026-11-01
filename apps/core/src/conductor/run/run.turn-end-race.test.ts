import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetStep } from '../scenario/presets.ts';
import { stand, type Stand } from './__fixtures__/run-harness.ts';
import type { ConductorHooks, RunEconomy } from './run.types.ts';

/**
 * Конец хода, пришедший ПОСЛЕ прохода крючков `onTurnEnd` и ДО суда `next` того же круга цикла
 * (этап 8, закрытие): события сессии CLI идут цепочкой обещаний и вклиниваются между ожиданиями
 * цикла. Суд не должен видеть конец хода, который крючки ещё не видели, — иначе вместо подсказки
 * наблюдателя уходит напоминание (живой прогон `observer.live` на настоящем claude: `remind` через
 * 0,7 мс после `turn.usage`, подсказки нет). Окно воспроизведено точно: конец хода зовётся из
 * `routingEnv` экономики — синхронного вызова между проходом крючков и `decideNext`.
 */

function single(): Scenario {
  return {
    id: 'turn-end-race',
    version: 1,
    title: 't',
    steps: [presetStep('work', 'work', 'Работа', [])],
  };
}

const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;

async function race(hookSends: boolean) {
  let fire: (() => void) | null = null;
  const economy: RunEconomy = {
    windows: () => [],
    routingEnv: () => {
      const f = fire;
      fire = null;
      f?.();
      return {};
    },
  };
  const seen: number[] = [];
  const hint: ConductorHooks = {
    onTurnEnd(_s, turn) {
      seen.push(turn.seq);
      const send = hookSends
        ? [{ text: 'observer note', ref: { kind: 'hint' as const, id: newId() } }]
        : [];
      return Promise.resolve({ send });
    },
  };
  const s = await stand(single(), { model: { 'work:0': 'hold' }, economy }, [hint]);
  await s.until(() => s.port.sessions.size === 1);
  const stepId = Object.keys(s.task.state.steps)[0]!;
  const session = [...s.port.sessions.values()][0]!;
  // Следующий круг цикла: проход крючков уже позади, суд — впереди.
  fire = () => s.port.turnEnd(stepId);
  s.run.wake();
  return { s, stepId, session, seen };
}

describe('conductor loop: a turn end landing between the turn-end hooks and the next judge', () => {
  it('the hooks see it first: their message goes out, no reminder is judged for that turn end', async () => {
    const { s, session, seen } = await race(true);
    await s.until(() => session.sends.some((m) => m.text === 'observer note'));
    expect(seen).toHaveLength(1);
    expect(lines(s).some((l) => l.kind === 'step.reminded')).toBe(false);
    expect(session.sends.filter((m) => m.cmdId.startsWith('remind:'))).toEqual([]);
    await s.stop();
  });

  it('near-miss: hooks with nothing to say leave that turn end to the judge — one reminder, after the hooks ran', async () => {
    const { s, stepId, session, seen } = await race(false);
    await s.until(() => s.task.state.steps[stepId]!.reminders === 1);
    expect(seen).toHaveLength(1);
    expect(session.sends.filter((m) => m.cmdId.startsWith('remind:'))).toHaveLength(1);
    await s.stop();
  });
});
