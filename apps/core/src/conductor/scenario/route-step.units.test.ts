import { describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { stand } from '../run/__fixtures__/run-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetStep } from './presets.ts';
import { decideRouting } from './route-step.ts';

/**
 * Продолжение сессии — только своей единицы (этап 11, P141): сессия другой единицы идёт в её копии,
 * и второй шаг работы задачи, «продолжив» её, снял бы чужой живой сеанс — параллельные единицы
 * одной задачи шли бы по одной. Настоящий журнал стенда, подделана только модель.
 */

const WORK: Scenario = {
  id: 'w',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

describe('continuation is scoped to the unit of the step (P141)', () => {
  it('a live work session of unit A is continued by the next work step of A, never by the work step of unit B', async () => {
    const s = await stand(WORK, { model: { 'work:0': 'hold' }, journalSessions: true });
    // Стенд держит сеанс модели (`hold`): упавшее ожидание без остановки стенда вешало бы прогон.
    try {
      await s.until(() => s.port.sessions.size === 1);
      const [stepId] = Object.keys(s.task.state.steps);
      const sessionId = [...s.port.sessions.keys()][0]!;
      const unitA = s.task.state.steps[stepId!]!.unitId;
      const unitB = newId();
      s.task.append({
        kind: 'unit.created',
        actor: 'core',
        unitId: unitB,
        data: {
          unitId: unitB,
          name: 'b',
          repoKey: 'r1',
          branch: 'b',
          ownedPaths: ['b/**'],
          after: [],
          contract: false,
          splitId: null,
        },
      });
      const judge = (unitId: string) =>
        decideRouting(s.task.state, { stepId: null, unitId, def: WORK.steps[0]! }).continuation;
      expect(judge(unitA)).toMatchObject({ mode: 'same-session', sessionId });
      expect(judge(unitB)).toMatchObject({ mode: 'fresh', reason: 'no-live-session' });
    } finally {
      await s.stop();
    }
  });
});
