import { join } from 'node:path';
import type { UserRoute } from '@agentdeck/contracts/core/config';
import type { Route, RouteId, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { AdapterRegistry } from '../adapters/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { readCoreConfig, sectionProblem } from '../platform/core-config/read.ts';
import { createCliLoginRoute } from '../routes/cli-login/cli-login.ts';
import { createOwnRoute, type OwnModel } from '../routes/local/own/own.ts';
import { createUserRoute } from '../routes/local/user/user.ts';
import { createLiveRouteRegistry, type RouteRegistry } from '../routes/registry.ts';
import { createStubRoute, type StubScriptSource } from '../routes/stub/stub.ts';
import type { PanelProfiles } from './panel-profiles.ts';
import { panelRoutes, type PanelRouteSources } from './panel-routes.ts';

export type { PanelRouteSources } from './panel-routes.ts';

/**
 * Маршруты настоящего запуска ядра (11 R:PR-08): вход CLI — по одному на каждый переходник
 * реестра (их список знает только реестр, P108); заглушки, своя модель и серверы человека — из раздела `routes`
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
  /** Серверы моделей человека: только HTTP, ядро их не поднимает (`routes/local/user`). */
  localUser?: UserRoute[];
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
  return buildLiveCoreRoutes(adapters, layout, config, core, panel).registry;
}

/**
 * Маршруты ядра с пересборкой маршрутов панели (s10 G7): `refreshPanel` пересобирает
 * `api-key`/`gateway` из свежих профилей, не трогая входы CLI, заглушки, свою модель и серверы
 * человека (их экземпляры держат поднятые серверы). Маршруты панели без состояния (освобождение
 * пустое), поэтому новый экземпляр того же id ничего не теряет; контур, заведённый после
 * загрузки, становится маршрутом, удалённый уходит. Без панели пересобирать нечего.
 */
export interface LiveCoreRoutes {
  registry: RouteRegistry;
  /** Пересобрать маршруты панели; возвращает id добавленных и снятых. */
  refreshPanel(profiles: PanelProfiles): { added: RouteId[]; removed: RouteId[] };
}

/**
 * Пересборка по правке панели с записью в журнал: изменился набор — `routes.refreshed` с
 * добавленными и снятыми id; набор не собрался — `routes.refresh-failed`, прежний набор остаётся,
 * а такт шлюза всё равно идёт (правка контура не падает из-за чужого профиля).
 */
export function refreshRoutesNoted(
  refresh: LiveCoreRoutes['refreshPanel'],
  profiles: PanelProfiles,
  note: (event: string, data: Record<string, unknown>) => void,
): void {
  try {
    const { added, removed } = refresh(profiles);
    if (added.length > 0 || removed.length > 0) note('routes.refreshed', { added, removed });
  } catch (error) {
    note('routes.refresh-failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildLiveCoreRoutes(
  adapters: AdapterRegistry,
  layout: CoreHomeLayout,
  config: CoreRouteConfig | undefined,
  core?: { bootId: string; journal?: RouteRecorder },
  panel?: PanelRouteSources,
): LiveCoreRoutes {
  // Окно у входа CLI — событием потока, только если переходник его объявил и разбирает; сейчас
  // ни один не объявил (нет случая в наборе соответствия) — `unknown`, отказ читается в потоке.
  // Заготовкам (этап 10) и переходникам только с адресом модели (`cliLogin: false`, Codex) входа
  // CLI нет: иначе он попал бы в набор по умолчанию каждой задачи, а запуск его всегда отказывает.
  const routes: Route[] = adapters
    .all()
    .filter((adapter) => adapter.built !== false && adapter.cliLogin !== false)
    .map((adapter) => createCliLoginRoute({ id: adapter.id }));
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
  for (const user of config?.localUser ?? []) routes.push(createUserRoute({ route: user }));
  let fromPanel = panel ? panelRoutes(panel) : [];
  const registry = createLiveRouteRegistry([...routes, ...fromPanel]);
  return {
    registry,
    refreshPanel: (profiles) => {
      if (!panel) return { added: [], removed: [] };
      const next = panelRoutes({ ...panel, profiles });
      // Набор проверяется целиком в `replace`: повторный id оставляет прежний набор.
      registry.replace([...routes, ...next]);
      const before = new Set(fromPanel.map((route) => route.id));
      const after = new Set(next.map((route) => route.id));
      fromPanel = next;
      return {
        added: [...after].filter((id) => !before.has(id)),
        removed: [...before].filter((id) => !after.has(id)),
      };
    },
  };
}
