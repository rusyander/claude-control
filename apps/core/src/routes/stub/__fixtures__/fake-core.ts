// Подставное ядро: настоящий процесс, который берёт аренду маршрута-заглушки, печатает её и
// адрес строкой `LEASE <json>` и ждёт, пока его не убьют, — смерть ядра посреди аренды (P10).
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { createStubRoute } from '../stub.ts';

const route = createStubRoute({ name: 'crash', script: ['survived the core'] });
const record: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};
const lease = await route.acquire(
  { taskId: 't', model: 'stub-model', dialect: 'openai-chat' },
  record,
);
process.stdout.write(
  `LEASE ${JSON.stringify({ lease, endpoint: await route.endpoint(lease, record) })}\n`,
);
setInterval(() => undefined, 60_000);
