import { join } from 'node:path';
import type { Route, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { AdapterRegistry } from '../adapters/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { readCoreConfig, sectionProblem } from '../platform/core-config/read.ts';
import { createCliLoginRoute } from '../routes/cli-login/cli-login.ts';
import { createOwnRoute, type OwnModel } from '../routes/local/own/own.ts';
import { createRouteRegistry, type RouteRegistry } from '../routes/registry.ts';
import { createStubRoute, type StubScriptSource } from '../routes/stub/stub.ts';
import { panelRoutes, type PanelRouteSources } from './panel-routes.ts';

export type { PanelRouteSources } from './panel-routes.ts';

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

/**
 * Раздел `routes` через единого читателя настройки (`platform/core-config/read.ts`, схема раздела
 * в контрактах): файла нет или раздела нет — `undefined`; файл не читается или раздел не прошёл
 * схему — отказ загрузки с каждым негодным полем (`routes: localOwn.server: …`). Правка мимо API
 * (дрейф) не действует: маршруты — из последней записи ядра.
 */
export function readRouteConfig(layout: CoreHomeLayout): CoreRouteConfig | undefined {
  const read = readCoreConfig(layout);
  if ('absent' in read) return undefined;
  if ('unknown' in read) throw new Error(`core config unreadable: ${read.unknown}`);
  const problem = sectionProblem(read.value, 'routes');
  if (problem) throw new Error(`core config ${problem}`);
  return read.value.doc.routes as CoreRouteConfig | undefined;
}

/**
 * `core` — это ядро: `bootId` из часов ядра (владелец мест ждущих своей модели, по нему следующее
 * ядро узнаёт место упавшего) и журнал для решений маршрута вне аренды задачи. `panel` — профили
 * ключей API и контуров из каталога данных панели (только чтение) с портом наличия ключа: нет —
 * маршрутов `api-key`/`gateway` нет (факт доступа без порта был бы догадкой).
 */
export function buildCoreRoutes(
  adapters: AdapterRegistry,
  layout: CoreHomeLayout,
  config: CoreRouteConfig | undefined,
  core?: { bootId: string; journal?: RouteRecorder },
  panel?: PanelRouteSources,
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
  if (panel) routes.push(...panelRoutes(panel));
  return createRouteRegistry(routes);
}
