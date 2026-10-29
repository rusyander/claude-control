// Подставное ядро «B» для P10 `local:own`: настоящий процесс только возвращает состояние прошлого
// ядра (аренды, места ждущих) и читает живость владельцев мест, печатает `RESTORED` и ждёт, пока
// его не убьют, — второе ядро, упавшее посреди окна повторной выдачи. Аргумент pid — живость
// этого процесса для B «неизвестна» (ОС не назвала время старта).
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { createLivenessProbe } from '../../../../platform/process-identity.ts';
import { createOwnRoute } from '../own.ts';
import { createSlotQueue } from '../slot.ts';
import { ownDir, ownOptions } from './own-options.ts';

const layout = ownDir(process.argv[2] ?? '', false);
const unknownPid = Number(process.argv[3] ?? 0);
const real = createLivenessProbe();
const route = createOwnRoute({
  ...ownOptions(layout),
  slots: createSlotQueue(),
  probe: { ...real, isAlive: async (id) => (id.pid === unknownPid ? 'unknown' : real.isAlive(id)) },
});
const record: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};
// Освобождение чужой аренды без ресурсов ничего не трогает, но сначала возвращает состояние.
await route.release(
  { leaseId: 'none', routeId: 'local:own', model: 'tiny-model', resources: [] },
  record,
);
process.stdout.write('RESTORED\n');
setInterval(() => undefined, 60_000);
