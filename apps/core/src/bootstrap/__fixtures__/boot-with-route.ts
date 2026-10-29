// Настоящее ядро в своём процессе: загрузка на доме argv[2] с маршрутом-заглушкой в реестре,
// одна аренда (сервер модели — отдельный процесс), строка `LEASE <json>` в stdout. Строка `stop`
// на stdin — чистая остановка ядра (`core.stop()`), затем `STOPPED` и выход; без неё процесс
// ждёт, пока его не убьют (крах ядра).
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { createRouteRegistry } from '../../routes/registry.ts';
import { createStubRoute } from '../../routes/stub/stub.ts';
import { bootCore } from '../boot.ts';

const home = process.argv[2];
if (!home) throw new Error('usage: boot-with-route.ts <core home>');
const route = createStubRoute({ name: 'boot', script: ['served by the booted core'] });
const core = await bootCore({
  home,
  build: 'boot-route-test',
  routes: createRouteRegistry([route]),
});
const record: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};
const lease = await core.routes
  .require(route.id)
  .acquire({ taskId: 't', model: 'stub-model', dialect: 'openai-chat' }, record);
process.stdout.write(
  `LEASE ${JSON.stringify({ lease, endpoint: await route.endpoint(lease, record) })}\n`,
);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (!chunk.includes('stop')) return;
  void core.stop().then(() => {
    process.stdout.write('STOPPED\n');
    process.exit(0);
  });
});
