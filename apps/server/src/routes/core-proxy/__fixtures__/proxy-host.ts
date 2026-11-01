import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { registerCoreProxyRoutes } from '../core-proxy-routes.ts';

// Процесс панели для P23/P131: только прокладка к ядру — та же сборка, что у сервера панели
// (`registerCoreProxyRoutes`: настоящая таблица TCP, дом ядра из AGENTDECK_CORE_HOME, ворота
// записи звена из AGENTDECK_HOP_RECORD, если сторож его дал). Первой строкой stdout — порт, pid и
// есть ли у процесса файл итога записи (`hopRecord`): так видно, что сторож передал его серверу.
const app = Fastify({ logger: false });
registerCoreProxyRoutes(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const { port } = app.server.address() as AddressInfo;
const hopRecord = Boolean(process.env.AGENTDECK_HOP_RECORD);
process.stdout.write(`${JSON.stringify({ port, pid: process.pid, hopRecord })}\n`);
