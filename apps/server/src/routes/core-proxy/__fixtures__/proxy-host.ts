import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { readTcpTable } from '../../../lib/peer-process/peer-process.ts';
import { coreHomeOf } from '../../../domains/core-proxy/core-proxy.ts';
import { createCoreProxyRoutes } from '../core-proxy-routes.ts';

// Процесс панели для P23: только прокладка к ядру, настоящая таблица TCP, дом ядра — из
// AGENTDECK_CORE_HOME (одноразовый). Первой строкой stdout — порт и pid; дальше молчит.
const app = Fastify({ logger: false });
createCoreProxyRoutes({ home: () => coreHomeOf(), readTcp: (wanted) => readTcpTable(wanted) })(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const { port } = app.server.address() as AddressInfo;
process.stdout.write(`${JSON.stringify({ port, pid: process.pid })}\n`);
