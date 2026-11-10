import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskFoldState } from './reduce.types.ts';

/**
 * Свёртка видов журнала этапа 12 (свёртка v14): остановка задачи, перехват единицы человеком и
 * возврат ядру, потеря входа маршрута. Конец MR (`publish.mr-state`) — в `publish.ts`, рядом с
 * личностью MR. Чистая, как `reduce`: противоречие — аномалия, запись не трогается.
 * `undefined` — вид не этого модуля.
 */

type Anomaly = (reason: string) => TaskFoldState;

function data<K extends keyof JournalDataV1>(line: JournalLine, _kind: K): JournalDataV1[K] {
  return line.data as unknown as JournalDataV1[K];
}

export function reduceStage12(
  state: TaskFoldState,
  line: JournalLine,
  anomaly: Anomaly,
): TaskFoldState | undefined {
  const seq = line.seq;
  switch (line.kind) {
    case 'task.stop':
      return { ...state, stop: { stop: data(line, 'task.stop').stop, seq } };
    case 'task.takeover': {
      // Второй перехват поверх открытого — противоречие: единицу уже ведёт человек.
      if (state.takeover) return anomaly(`takeover of unit ${state.takeover.unitId} already open`);
      const d = data(line, 'task.takeover');
      return {
        ...state,
        takeover: {
          unitId: d.unitId,
          copy: d.copy,
          seq,
          ...(d.chatTaskId ? { chatTaskId: d.chatTaskId } : {}),
        },
      };
    }
    case 'task.handback': {
      if (!state.takeover) return anomaly('handback without an open takeover');
      const note = data(line, 'task.handback').note ?? null;
      return { ...state, takeover: null, handback: { note, seq } };
    }
    case 'route.login-lost': {
      const d = data(line, 'route.login-lost');
      return {
        ...state,
        loginLost: { ...state.loginLost, [d.stepId]: { routeId: d.routeId, seq } },
      };
    }
    default:
      return undefined;
  }
}
