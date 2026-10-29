import { join } from 'node:path';
import type { Route, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { AdapterRegistry } from '../adapters/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { createCliLoginRoute } from '../routes/cli-login/cli-login.ts';
import { createOwnRoute, type OwnModel } from '../routes/local/own/own.ts';
import { createRouteRegistry, type RouteRegistry } from '../routes/registry.ts';
import { createStubRoute, type StubScriptSource } from '../routes/stub/stub.ts';

/**
 * Маршруты настоящего запуска ядра (11 R:PR-08): вход CLI — по одному на каждый переходник
 * реестра (их список знает только реестр, P108); заглушки и своя модель — из раздела `routes`
 * файла `config.json` дома ядра. Файла нет или раздела нет — только входы CLI. Раздел есть, но
 * не той формы — загрузка отказывает, назвав поле: маршрут, который человек описал, не пропадает
 * молча (решение совместимости назвало бы его потом «неизвестным»).
 */

export interface StubRouteConfig {
  name: string;
  script: StubScriptSource;
  models?: string[];
  trace?: string;
}

export interface OwnRouteConfig {
  server: { command: string; leadArgs?: string[]; extraArgs?: string[] };
  models: OwnModel[];
}

export interface CoreRouteConfig {
  stub?: StubRouteConfig[];
  localOwn?: OwnRouteConfig;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function refuse(field: string, why: string): never {
  throw new Error(`core config routes.${field}: ${why}`);
}

function parseStub(raw: unknown, at: string): StubRouteConfig {
  if (!isObj(raw)) refuse(at, 'not an object');
  if (typeof raw.name !== 'string' || !raw.name.trim()) refuse(`${at}.name`, 'not a name');
  const script = raw.script;
  const moduleScript =
    isObj(script) && typeof script.module === 'string' && typeof script.export === 'string';
  if (!Array.isArray(script) && !moduleScript) {
    refuse(`${at}.script`, 'neither steps nor {module, export}');
  }
  if (raw.models !== undefined && !isStrings(raw.models)) refuse(`${at}.models`, 'not strings');
  if (raw.trace !== undefined && typeof raw.trace !== 'string') refuse(`${at}.trace`, 'not a path');
  return raw as unknown as StubRouteConfig;
}

function parseOwn(raw: unknown): OwnRouteConfig {
  if (!isObj(raw)) refuse('localOwn', 'not an object');
  const server = raw.server;
  if (!isObj(server) || typeof server.command !== 'string' || !server.command) {
    refuse('localOwn.server.command', 'no command');
  }
  for (const k of ['leadArgs', 'extraArgs'] as const) {
    if (server[k] !== undefined && !isStrings(server[k])) {
      refuse(`localOwn.server.${k}`, 'not strings');
    }
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) refuse('localOwn.models', 'empty');
  raw.models.forEach((m: unknown, i) => {
    const at = `localOwn.models[${i}]`;
    if (!isObj(m) || typeof m.id !== 'string' || typeof m.path !== 'string') {
      refuse(at, 'needs id and path');
    }
    if (typeof m.sizeBytes !== 'number' || !(m.sizeBytes > 0)) refuse(`${at}.sizeBytes`, 'not > 0');
  });
  return raw as unknown as OwnRouteConfig;
}

/** Раздел `routes` из текста `config.json`; нет раздела — `undefined`. */
export function parseRouteConfig(text: string): CoreRouteConfig | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`core config: not JSON (${(error as Error).message})`, { cause: error });
  }
  if (!isObj(doc) || doc.routes === undefined) return undefined;
  const routes = doc.routes;
  if (!isObj(routes)) refuse('', 'not an object');
  const out: CoreRouteConfig = {};
  if (routes.stub !== undefined) {
    if (!Array.isArray(routes.stub)) refuse('stub', 'not a list');
    out.stub = routes.stub.map((s: unknown, i) => parseStub(s, `stub[${i}]`));
  }
  if (routes.localOwn !== undefined) out.localOwn = parseOwn(routes.localOwn);
  return out;
}

/** Раздел `routes` файла дома ядра: файла нет — `undefined`; не читается — отказ загрузки. */
export function readRouteConfig(layout: CoreHomeLayout): CoreRouteConfig | undefined {
  const bytes = readBytesSync(layout.config);
  if ('absent' in bytes) return undefined;
  if (!('value' in bytes)) throw new Error(`core config unreadable: ${bytes.unknown}`);
  return parseRouteConfig(bytes.value.toString('utf8'));
}

/**
 * `core` — это ядро: `bootId` из часов ядра (владелец мест ждущих своей модели, по нему следующее
 * ядро узнаёт место упавшего) и журнал для решений маршрута вне аренды задачи.
 */
export function buildCoreRoutes(
  adapters: AdapterRegistry,
  layout: CoreHomeLayout,
  config: CoreRouteConfig | undefined,
  core?: { bootId: string; journal?: RouteRecorder },
): RouteRegistry {
  // Окно у входа CLI — событием потока, только если переходник его объявил и разбирает; сейчас
  // ни один не объявил (нет случая в наборе соответствия) — `unknown`, отказ читается в потоке.
  const routes: Route[] = adapters.all().map((adapter) => createCliLoginRoute({ id: adapter.id }));
  for (const stub of config?.stub ?? []) routes.push(createStubRoute({ ...stub }));
  if (config?.localOwn) {
    routes.push(
      createOwnRoute({
        server: config.localOwn.server,
        models: config.localOwn.models,
        workRoot: join(layout.root, 'routes', 'local-own'),
        ...(core ? { core: { bootId: core.bootId } } : {}),
        ...(core?.journal ? { journal: core.journal } : {}),
      }),
    );
  }
  return createRouteRegistry(routes);
}
