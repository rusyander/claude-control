import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import type { CoreChatPort } from '../../chat/core-run/core-run.types.ts';
import { ProjectTestsError } from '../files.ts';
import type { RecordedWalkPort, RecordedWalkRequest } from './recorded.types.ts';

/**
 * Задача прохода по стенду в ядре (сценарий `browser-walk`, D23). Проход правок не делает,
 * поэтому место — по умолчанию (копия), без гранта на дерево проекта.
 *
 * Запуск — политикой `auto`, а не командой `launch` следом за оценкой. Оценка копии отвечает
 * в состоянии `estimating` (единица 0 «estimate» ещё идёт), и `launch` в нём — `state-conflict`:
 * на живом ядре (W3-D F2, `recorded-walk-core.live.integration.test.ts`) каждая «Записать
 * сценарий» и каждое расхождение падали «launch not allowed in estimating». Нажатие человека и
 * есть согласие на запуск — ядро само запускает принятое деление (`afterAccept`), а не прошедшее
 * предпроверку спрашивает человека точкой 10, не молча.
 * Отказ ядра поднимается ошибкой с его кодом: карточка расхождения показывает его, а не молчит.
 */

/** Предел подписи задачи в ядре. */
const TITLE_MAX = 300;

export function createCoreWalkPort(port: CoreChatPort): RecordedWalkPort {
  return {
    async open(request: RecordedWalkRequest) {
      const parsed = estimateFieldsSchema.safeParse({
        title: request.title.slice(0, TITLE_MAX),
        request: request.text,
        repos: [{ path: request.root, baseRef: null }],
        scenario: { preset: 'browser-walk' },
        launchPolicy: 'auto',
        ciWait: false,
      });
      if (!parsed.success) {
        throw new ProjectTestsError(
          `Задача прохода не собралась: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const estimate = await port.estimate(parsed.data);
      if (!estimate.ok) throw new ProjectTestsError(`${estimate.code}: ${estimate.message}`);
      return { taskId: estimate.taskId };
    },
  };
}
