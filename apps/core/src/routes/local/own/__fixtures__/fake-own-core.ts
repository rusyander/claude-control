// Подставное ядро для P10 `local:own`: настоящий процесс берёт аренду (слот занят, сервер с
// моделью идёт), ставит второй запрос в очередь слота, печатает `LEASE <json>`, когда место
// ждущего записано, и ждёт, пока его не убьют, — смерть ядра посреди аренды и очереди.
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { createOwnRoute } from '../own.ts';
import { createSlotQueue } from '../slot.ts';
import { ownDir, ownOptions } from './own-options.ts';

const layout = ownDir(process.argv[2] ?? '', false);
const slots = createSlotQueue();
const route = createOwnRoute({ ...ownOptions(layout), slots });
const record: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};
const lease = await route.acquire({ taskId: 'held', model: 'tiny-model' }, record);
void route.acquire({ taskId: 'queued', model: 'tiny-model' }, record);
// Ждущий стоит в очереди (место маршрут пишет до постановки в неё).
while (slots.waiting('gpu') === 0) await new Promise((done) => setTimeout(done, 20));
process.stdout.write(
  `LEASE ${JSON.stringify({ lease, endpoint: await route.endpoint(lease, record) })}\n`,
);
setInterval(() => undefined, 60_000);
