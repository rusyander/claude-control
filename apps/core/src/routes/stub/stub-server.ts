import { pathToFileURL } from 'node:url';
import { startStubModel, type Script } from '@agentdeck/stub-model';
import { decodeStubConfig, STUB_IDENTITY_PATH, type StubScriptSource } from './stub-config.ts';

/**
 * Процесс сервера-заглушки (11 R:PR-09): отдельная программа, которую маршрут `stub` запускает
 * через платформу, — как свой сервер моделей у `local:own`. Смерть ядра его не касается (P10:
 * ядро убивают посреди аренды, перезапущенное ядро возвращается к ТОМУ ЖЕ серверу). Настройка —
 * одним аргументом (base64url JSON: окружение через WMI не доходит); сценарий-функция приходит модулем и именем экспорта, потому что
 * функцию через границу процесса не передать. Путь `STUB_IDENTITY_PATH` отвечает владельцем
 * (rid ресурса) и pid — по нему маршрут узнаёт, что поднялся именно его сервер.
 */

async function loadScript(source: StubScriptSource): Promise<Script> {
  if (Array.isArray(source)) return source;
  const module = (await import(pathToFileURL(source.module).href)) as Record<string, unknown>;
  const value = module[source.export];
  if (value === undefined) throw new Error(`${source.module} has no export ${source.export}`);
  if (!source.args) return value as Script;
  if (typeof value !== 'function') throw new Error(`${source.export} is not a script factory`);
  return (value as (...args: unknown[]) => Script)(...source.args);
}

const config = decodeStubConfig(process.argv[2]);
const stub = await startStubModel({
  port: config.port,
  models: config.models,
  script: await loadScript(config.script),
  ...(config.trace ? { trace: config.trace } : {}),
  route: ({ path }) =>
    path === STUB_IDENTITY_PATH ? { body: { owner: config.owner, pid: process.pid } } : undefined,
});
// Чистая остановка по TERM (POSIX); на Windows дерево снимается без сигнала — сокет закроет ОС.
process.on('SIGTERM', () => void stub.close().finally(() => process.exit(0)));
