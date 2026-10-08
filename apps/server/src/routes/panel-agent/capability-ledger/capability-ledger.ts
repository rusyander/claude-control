import type { ActionRouteRequest } from '../registry.ts';
import type {
  CapabilityPhase,
  HumanReason,
  RouteClass,
  RouteLedger,
} from './capability-ledger.types.ts';

export { ROUTE_LEDGER } from './capability-ledger.constants.ts';
export type {
  CapabilityPhase,
  GapLane,
  HumanReason,
  InternalKind,
  RouteClass,
  RouteLedger,
} from './capability-ledger.types.ts';

/**
 * Реестр возможностей (G4) в деле: исполнитель агента спрашивает его перед
 * КАЖДЫМ внутренним вызовом маршрута. Закрыто по умолчанию: маршрута нет в
 * реестре — отказ; `human:` — отказ на любом шаге; исполнить можно только то,
 * что строка отдала этому действию; писать (не-GET) при сборке карточки и в
 * подготовке — только в `internal:preview`.
 */

/** Действия без маршрута: исполняются в процессе сервера, в реестре их нет. */
export const LOCAL_ACTIONS: readonly string[] = ['where_am_i', 'list_sections', 'open_page'];

/** Почему нажать должен человек — модели, по-английски. */
export const HUMAN_REASONS: Readonly<Record<HumanReason, string>> = {
  'split-apply': 'applying, cancelling or cleaning up a split is the human’s click',
  rights: 'permission and branch decisions and auto-approve belong to the human',
  outward: 'writes that leave this machine (git push, tracker, wiki, publishing) are the human’s',
  secret: 'secrets and tokens are entered and read only by the human',
  consent: 'granting an MCP server access (sign-in) is the human’s consent',
  remote: 'remote access and paired devices are managed only by the human',
  'prompt-gate': 'the prompt gate is set only by the human',
  location: 'the configuration folder is switched only by the human',
  'settings-import': 'importing settings is done only by the human',
  prompts: 'the panel’s own prompts are edited only by the human',
  'code-write': 'project source files are written only by the human',
  upload: 'importing a file is the human’s: they pick the file',
  download: 'exports and downloads are the human’s',
  paid: 'paid generation is started only by the human',
  'dev-restart': 'restarting the dev server cuts off running turns — only the human decides',
};

/** Действия, которым строка отдаёт маршрут. */
export function actionsOf(routeClass: RouteClass): string[] {
  return routeClass.startsWith('action:') ? routeClass.slice('action:'.length).split(',') : [];
}

interface CompiledRoute {
  key: string;
  method: string;
  segments: string[];
}

const compiled = new WeakMap<RouteLedger, CompiledRoute[]>();

function routesOf(ledger: RouteLedger): CompiledRoute[] {
  let routes = compiled.get(ledger);
  if (!routes) {
    routes = Object.keys(ledger).map((key) => {
      const space = key.indexOf(' ');
      return {
        key,
        method: key.slice(0, space),
        segments: key
          .slice(space + 1)
          .split('/')
          .slice(1),
      };
    });
    compiled.set(ledger, routes);
  }
  return routes;
}

/**
 * Ранг совпадения по сегментам: 0 — точный, 1 — параметр, 2 — хвост `*`.
 * Меньший ранг раньше — тот же порядок, что у маршрутизатора Fastify
 * (статичный сегмент, затем параметр, затем хвост). Не совпало — `undefined`.
 */
function matchRank(pattern: string[], segments: string[]): number[] | undefined {
  const rank: number[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index]!;
    const segment = segments[index];
    if (part === '*' && index === pattern.length - 1) {
      return segment === undefined ? undefined : [...rank, 2];
    }
    if (segment === undefined) return undefined;
    if (part.startsWith(':')) {
      if (segment === '') return undefined;
      rank.push(1);
    } else if (part === segment) rank.push(0);
    else return undefined;
  }
  return segments.length === pattern.length ? rank : undefined;
}

function compareRank(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? -1) - (right[index] ?? -1);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Сегменты пути, который обслужит маршрутизатор, или `undefined`, если адрес не
 * разбирается. Ревью U0, M1 (28.09.2026): `inject` (light-my-request) разбирает
 * адрес по WHATWG — снимает `.`/`..` и `%2e`, `\` считает `/`, выбрасывает табы и
 * переводы строк, — затем find-my-way раскодирует путь (`decodeURI`: `%2F` остаётся
 * внутри сегмента). Реестр судил СЫРОЙ адрес: `GET /api/scripts/../prompts` считался
 * строкой `scripts/*`, а исполнялся `GET /api/prompts` (человеческий).
 */
function servedSegments(url: string): string[] | undefined {
  try {
    const target = url.startsWith('//') ? `http://localhost${url}` : url;
    const { pathname } = new URL(target, 'http://localhost');
    // `%25` find-my-way раскодирует на шаг позже, в параметре; в пути он остаётся `%25`.
    return decodeURI(pathname.replace(/%25/g, '%2525')).split('/').slice(1);
  } catch {
    return undefined;
  }
}

/** Строка реестра, которая обслужит запрос (`МЕТОД /api/шаблон`), или `undefined`. */
export function resolveRouteKey(
  ledger: RouteLedger,
  method: string,
  url: string,
): string | undefined {
  const segments = servedSegments(url);
  if (!segments) return undefined;
  let best: { key: string; rank: number[] } | undefined;
  for (const route of routesOf(ledger)) {
    if (route.method !== method) continue;
    const rank = matchRank(route.segments, segments);
    if (rank && (!best || compareRank(rank, best.rank) < 0)) best = { key: route.key, rank };
  }
  return best?.key;
}

/**
 * Адрес с «переодетым» путём: сегмент `.`/`..` сырой или закодированный (`%2e`,
 * `%2E`, `.%2e`), обратная косая или управляющий символ (их `inject` превращает в
 * разделитель или выбрасывает), адрес не от корня (`//хост`, `scheme:`). Сборщик
 * адреса действия кладёт id модели в сегмент (`encodeURIComponent('..')` — это `..`),
 * так что такой адрес — всегда попытка выйти за строку реестра, а не данные.
 */
export function disguisedPath(url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//')) return true;
  const path = url.split(/[?#]/, 1)[0]!;
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет проверки
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return true;
  return path
    .split('/')
    .slice(1)
    .some((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return true;
      }
      return decoded === '.' || decoded === '..';
    });
}

/** Строка реестра в тексте для модели: без `/api/` — адреса ей не показываются. */
const shown = (method: string, path: string): string =>
  `${method} ${path.split(/[?#]/, 1)[0]!.replace(/^\/api\//, '')}`;

/**
 * Отказ реестра для вызова `request` действием `action` на шаге `phase`, или
 * `undefined`, если вызов разрешён. Текст — модели: что не исполнено и почему.
 */
export function capabilityRefusal(
  ledger: RouteLedger,
  action: string,
  phase: CapabilityPhase,
  request: Pick<ActionRouteRequest, 'method' | 'url'>,
): string | undefined {
  const notRun =
    phase === 'after'
      ? 'The main step already ran; this follow-up step was not executed.'
      : 'Nothing was executed.';
  if (disguisedPath(request.url)) {
    return (
      `Refused by the panel’s capability ledger: ${action} built an address with a '.' or '..' ` +
      `path part (plain or encoded) or a disguised separator. An id or name can never be '.' or ` +
      `'..'; take it from the list the panel gave. ${notRun}`
    );
  }
  const key = resolveRouteKey(ledger, request.method, request.url);
  if (key === undefined) {
    return (
      `Refused by the panel’s capability ledger: ${action} called ` +
      `${shown(request.method, request.url)}, which is not in the ledger. ${notRun}`
    );
  }
  const routeClass = ledger[key]!;
  const label = shown(request.method, key.slice(key.indexOf(' ') + 1));
  if (routeClass.startsWith('human:')) {
    const reason = HUMAN_REASONS[routeClass.slice('human:'.length) as HumanReason];
    return (
      `This step is the human’s (${label}): ${reason}. Prepare everything and ask the human to ` +
      `press the button in the panel. ${notRun}`
    );
  }
  const granted = actionsOf(routeClass).includes(action);
  if (phase === 'execute') {
    return granted
      ? undefined
      : `Refused by the panel’s capability ledger: ${label} is not granted to ${action}. ${notRun}`;
  }
  if (request.method === 'GET' || routeClass === 'internal:preview') return undefined;
  if (phase === 'after' && granted) return undefined;
  return (
    `Refused by the panel’s capability ledger: ${action} may only read ${label} while ` +
    `preparing its card. ${notRun}`
  );
}
