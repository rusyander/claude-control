import type { FastifyInstance, RouteOptions } from 'fastify';
import { ROUTE_LEDGER } from '../../panel-agent/capability-ledger/capability-ledger.constants.ts';
import type { RouteLedger } from '../../panel-agent/capability-ledger/capability-ledger.types.ts';
import type { ServerContext } from '../../../context.ts';
import { humanOnlyDepsFor, setPanelDirs } from './human-only-deps.ts';
import { gateModeOf, humanOnly, type HumanOnlyDeps } from './human-only.ts';

/**
 * Ворота «только человек» на КАЖДОМ маршруте `human:*` журнала возможностей —
 * одним хуком, а не строкой в каждом файле маршрутов (RF-DS-01..03, повторное
 * ревью 24.10).
 *
 * Зачем. Журнал (`capability-ledger.constants.ts`) давно знает, какие маршруты
 * принадлежат человеку, но закрывал их только от агента ПАНЕЛИ — внутри слоя
 * действий. По HTTP те же маршруты оставались открыты процессу модели: свой
 * бот ответов Telegram (`PUT /api/integrations/telegram/answers`), импорт
 * настроек с `chatAutoMode=true` (`POST /api/settings/import`), решение по
 * ревью MR сразу для всех групп (`…/review-decision`). Закрывать их поштучно —
 * значит пропустить следующий: новый маршрут `human:*` здесь закрыт сам, без
 * правки своего файла.
 *
 * Как. Хук `onRoute` ставит `humanOnly` первым `preHandler`-ом любому маршруту,
 * чья строка журнала — `human:*`, если строгих ворот на нём ещё нет. `HEAD`
 * судится как свой `GET`: Fastify строит его из настроек `GET` ДО хуков, и без
 * этого близнец ушёл бы без ворот. Вызов изнутри панели (`app.inject`: агент
 * панели, ответы Telegram) воротами пропускается — у него нет сокета.
 */

/**
 * Маршруты `human:*`, которые зовёт процесс НА СТОРОНЕ модели по своей работе, —
 * без ворот, с причиной. Список закреплён тестом: новая строка — решение, а не
 * случайность.
 */
export const UNGATED_HUMAN_ROUTES: Readonly<Record<string, string>> = {
  // Хук сессии вне панели снимает СВОЮ карточку с телефона, когда в окне CLI
  // уже ответили (`outside-relay-hook.mjs`). Снятие ничего не разрешает: CLI
  // спрашивает человека своим окном.
  'POST /api/outside/asks/:id/release':
    'the outside-session hook withdraws its own phone card; withdrawing approves nothing',
};

const keyOf = (method: string, url: string): string =>
  `${method === 'HEAD' ? 'GET' : method} ${url}`;

/** Принадлежит ли маршрут человеку по журналу (и не исключён ли явно). */
export function isHumanRoute(method: string, url: string, ledger: RouteLedger = ROUTE_LEDGER) {
  const key = keyOf(method, url);
  return Boolean(ledger[key]?.startsWith('human:')) && !(key in UNGATED_HUMAN_ROUTES);
}

/** Строгие ворота среди обработчиков маршрута. */
export function hasStrictGate(preHandler: RouteOptions['preHandler']): boolean {
  return [preHandler ?? []].flat().some((handler) => gateModeOf(handler) === 'strict');
}

/**
 * Регистратор таблицы маршрутов: ставится ПЕРВЫМ — хук `onRoute` действует
 * только на маршруты, объявленные после него.
 */
export function gateHumanRoutes(
  app: FastifyInstance,
  ledger: RouteLedger = ROUTE_LEDGER,
  deps: HumanOnlyDeps = humanOnlyDepsFor(),
): void {
  const gate = humanOnly(deps);
  app.addHook('onRoute', (route) => {
    const methods = [route.method].flat();
    if (!methods.some((method) => isHumanRoute(method, route.url, ledger))) return;
    if (hasStrictGate(route.preHandler)) return;
    route.preHandler = [gate, ...[route.preHandler ?? []].flat()];
  });
}

/**
 * Регистратор сборки сервера: ворота журнала и каталоги панели для шва
 * одноразового стенда (`throwaway-stand.ts`) — текущие, из контекста: каталог
 * конфигурации переключается на ходу.
 */
export function gateHumanRoutesFor(app: FastifyInstance, ctx: ServerContext): void {
  setPanelDirs(() => ({ config: ctx.location.paths.root, data: ctx.location.paths.appData }));
  gateHumanRoutes(app);
}
