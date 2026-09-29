import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  actionsOf,
  capabilityRefusal,
  LOCAL_ACTIONS,
  resolveRouteKey,
  ROUTE_LEDGER,
  type RouteClass,
  type RouteLedger,
} from './capability-ledger.ts';
import type { AnyPanelAction } from './registry.ts';

/**
 * G4: реестр возможностей агента сверяется с ЖИВОЙ сборкой приложения — тем же
 * `buildRouteTable`, что поднимает сервер, на временном каталоге конфигурации.
 * Маршрут без строки, строка без маршрута, действие без строки, строка с
 * несуществующим действием, выдача, которую код действия не оправдывает, и
 * переклассифицированный человеческий маршрут — красное. Каждую проверку ниже
 * сопровождает подложенная поломка: проверка, которая не может покраснеть, —
 * украшение.
 */

/**
 * Человеческие маршруты (D2, решение владельца 28.09.2026). Переклассифицировать
 * любой — только решением владельца: дорожка, которой это понадобилось,
 * спрашивает, а не правит этот список.
 */
const PINNED_HUMAN: Readonly<Record<string, RouteClass>> = {
  'DELETE /api/credentials': 'human:secret',
  'DELETE /api/endpoints/:id/token': 'human:secret',
  'DELETE /api/mcp/:id/oauth': 'human:consent',
  'DELETE /api/project-tests/env-secret': 'human:secret',
  'DELETE /api/prompts/:id': 'human:prompts',
  'DELETE /api/remote/devices': 'human:remote',
  'GET /api/chat/:chatId/export': 'human:download',
  'GET /api/compromises': 'human:prompts',
  'GET /api/env/reveal': 'human:secret',
  'GET /api/project-tests/env-secrets': 'human:secret',
  'GET /api/project-tests/export': 'human:download',
  'GET /api/project-tests/release/export': 'human:download',
  'GET /api/project-tests/release/pdf': 'human:download',
  'GET /api/project-tests/run/export': 'human:download',
  'GET /api/project-tests/run/pdf': 'human:download',
  'GET /api/prompt-gate': 'human:prompt-gate',
  'GET /api/prompts': 'human:prompts',
  'GET /api/prompts/:id': 'human:prompts',
  'GET /api/remote': 'human:remote',
  'GET /api/settings/export': 'human:download',
  'PATCH /api/remote': 'human:remote',
  'POST /api/backups/secret-passphrase': 'human:secret',
  'POST /api/chat/:chatId/auto-approve': 'human:rights',
  'POST /api/chat/:chatId/branch-decision': 'human:rights',
  'POST /api/chat/:chatId/permission-decision': 'human:rights',
  'POST /api/chat/split': 'human:split-apply',
  'POST /api/chat/split/:parent/cancel': 'human:split-apply',
  'POST /api/chat/split/:parent/cleanup': 'human:split-apply',
  'POST /api/chat/split/:parent/review-decision': 'human:outward',
  'POST /api/chat/split/:parent/review-push': 'human:outward',
  'POST /api/chat/split/:parent/review-retry': 'human:outward',
  'POST /api/chat/split/:parent/tickets/file': 'human:outward',
  'POST /api/credentials': 'human:secret',
  'POST /api/env-transfer/import/apply': 'human:upload',
  'POST /api/env-transfer/import/plan': 'human:upload',
  'POST /api/integrations/ci/import': 'human:upload',
  'POST /api/integrations/confluence/page': 'human:outward',
  'POST /api/integrations/jira/issue': 'human:outward',
  'POST /api/integrations/jira/issue/:key/comment': 'human:outward',
  'POST /api/integrations/jira/issue/:key/transition': 'human:outward',
  'POST /api/integrations/mcp/connect': 'human:consent',
  'POST /api/integrations/telegram/test': 'human:outward',
  'POST /api/integrations/tms/pull': 'human:outward',
  'POST /api/integrations/tms/push': 'human:outward',
  'POST /api/integrations/webhook/test': 'human:outward',
  'POST /api/location': 'human:location',
  'POST /api/mcp/:id/oauth/start': 'human:consent',
  'POST /api/media/decks': 'human:paid',
  'POST /api/media/images': 'human:paid',
  'POST /api/project-git/push': 'human:outward',
  'POST /api/project-tests/defect/create': 'human:outward',
  'POST /api/project-tests/env-secret': 'human:secret',
  'POST /api/project-tests/import/cases': 'human:upload',
  'POST /api/project-tests/import/results': 'human:upload',
  'POST /api/project-tests/run/publish': 'human:outward',
  'POST /api/remote/devices': 'human:remote',
  'POST /api/remote/test': 'human:remote',
  'POST /api/remote/token': 'human:remote',
  'POST /api/sandbox/mcp-call': 'human:outward',
  'POST /api/sandbox/mcp-tools': 'human:outward',
  'POST /api/settings/import': 'human:settings-import',
  'POST /api/sieves/learned/:id/accept': 'human:prompts',
  'PUT /api/endpoints/:id/token': 'human:secret',
  'PUT /api/integrations/confluence/page/:id': 'human:outward',
  'PUT /api/platforms/:id/token': 'human:secret',
  'PUT /api/project-files/content': 'human:code-write',
  'PUT /api/prompt-gate': 'human:prompt-gate',
  'PUT /api/prompts/:id': 'human:prompts',
  'POST /api/chat/split/:parent/start-now': 'human:split-apply',
  'POST /api/chat/split/:parent/relaunch': 'human:split-apply',
  'POST /api/chat/split/:parent/restart-group': 'human:split-apply',
  'POST /api/chat/split/:parent/drop-group': 'human:split-apply',
  'POST /api/project-tests/baseline': 'human:upload',
};

/**
 * Выдачи, адрес которых собирает функция-помощник, а не литерал в `route`/
 * `afterRoute`: выдача оправдана, если исходник действия зовёт помощника.
 */
/**
 * Сегмент адреса из конечного набора литералов кода, а не из ввода модели: парсер
 * значений карты не видит, а заглушка статичный сегмент больше не оправдывает
 * (ревью U0, m4: `/api/chat/split/${…}/${MODE_ROUTE[…]}` оправдывал ЛЮБОЙ
 * `POST /api/chat/split/:parent/<имя>`). Список по действию и руками: новый режим в
 * карте без строки здесь — красное «не оправдано», а не молчаливая выдача.
 */
const CLOSED_SETS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // actions-chat-control.ts: MODE_ROUTE
  split_control: {
    'MODE_ROUTE[input.mode]': ['pause', 'resume-paused', 'release', 'hold', 'resume'],
  },
  // actions-tests-manual.ts: одно определение на два действия, `kind` — его параметр
  finish_manual_run: { kind: ['finish'] },
  cancel_manual_run: { kind: ['cancel'] },
};

const HELPER_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // actions-hooks-env.ts: scriptUrl(id) → `/api/scripts/${…}`
  scriptUrl: ['GET /api/scripts/*', 'PUT /api/scripts/*', 'DELETE /api/scripts/*'],
  // actions-contour.ts: applyConsumers(id, inject) → POST `…/apply`, PUT `/api/platforms/${id}`
  applyConsumers: ['POST /api/platforms/:id/apply', 'PUT /api/platforms/:id'],
  // actions-groups.ts: knobsOf(inject, id) → GET `/api/groups/${id}/knobs`
  knobsOf: ['GET /api/groups/:id/knobs'],
  // actions-project-config.ts: rulesUrl/mcpUrl/permissionsUrl(project) → `/api/projects/${id}/…`
  rulesUrl: ['GET /api/projects/:id/rules', 'PUT /api/projects/:id/rules'],
  mcpUrl: [
    'GET /api/projects/:id/mcp',
    'POST /api/projects/:id/mcp',
    'PUT /api/projects/:id/mcp/:serverId',
    'DELETE /api/projects/:id/mcp/:serverId',
    'POST /api/projects/:id/mcp/:serverId/enabled',
  ],
  permissionsUrl: [
    'GET /api/projects/:id/permissions',
    'POST /api/projects/:id/permissions',
    'PUT /api/projects/:id/permissions/:permId',
    'DELETE /api/projects/:id/permissions/:permId',
  ],
  // actions-project-config.ts: choiceUrl(project) → GET `/api/projects/group-choice?path=…`
  choiceUrl: ['GET /api/projects/group-choice'],
  // actions-project-git.ts: mirrorUrl(project) → GET `/api/project-git/mirror-settings?path=…`
  mirrorUrl: ['GET /api/project-git/mirror-settings'],
  // actions-project-runner.ts: describeUrl(dir) → GET `/api/project-runner/describe?path=…`
  describeUrl: ['GET /api/project-runner/describe'],
  // actions-tests-reads.ts: testsReportRoute(input) → GET per report kind
  testsReportRoute: [
    'GET /api/project-tests',
    'GET /api/project-tests/report',
    'GET /api/project-tests/run/diff',
    'GET /api/project-tests/impact',
    'GET /api/project-tests/history',
    'GET /api/project-tests/case-history',
    'GET /api/project-tests/flaky',
    'GET /api/project-tests/quarantine',
    'GET /api/project-tests/risk',
    'GET /api/project-tests/taxonomy',
    'GET /api/project-tests/pyramid',
    'GET /api/project-tests/release',
    'GET /api/project-tests/plans',
    'GET /api/project-tests/plan/points',
    'GET /api/project-tests/manual',
    'GET /api/project-tests/baselines',
    'GET /api/project-tests/e2e',
  ],
  // actions-chat-control.ts: groupPlan(input, inject) → GET `/api/chat/${id}/group-settings`
  groupPlan: ['GET /api/chat/:chatId/group-settings'],
  // actions-chat-control.ts: splitPrompt(inject, chat) → GET `/api/chat/split/request?…`
  splitPrompt: ['GET /api/chat/split/request'],
  // actions-chat.ts: splitOf(inject, id) → readTree → GET `/api/chat/${id}/tree`
  splitOf: ['GET /api/chat/:id/tree'],
  // actions-chat-control.ts: splitTarget(input, inject) → readTree → GET `/api/chat/${id}/tree`
  splitTarget: ['GET /api/chat/:id/tree'],
};

// ---- checks: pure functions over (routes, ledger, actions), so a planted defect can prove each ----

function unaccounted(routes: readonly string[], ledger: RouteLedger) {
  const known = new Set(routes);
  return {
    missing: routes.filter((key) => !(key in ledger)),
    stale: Object.keys(ledger).filter((key) => !known.has(key)),
  };
}

function unknownActions(ledger: RouteLedger, actions: readonly AnyPanelAction[]): string[] {
  const routed = new Set(actions.filter((action) => action.route).map((action) => action.name));
  return Object.entries(ledger).flatMap(([key, routeClass]) =>
    actionsOf(routeClass)
      .filter((name) => !routed.has(name))
      .map((name) => `${key} → ${name}`),
  );
}

function rowless(ledger: RouteLedger, actions: readonly AnyPanelAction[]) {
  const granted = new Set(Object.values(ledger).flatMap((routeClass) => actionsOf(routeClass)));
  return {
    withoutRow: actions
      .filter((action) => action.route && !granted.has(action.name))
      .map((action) => action.name),
    locals: actions
      .filter((action) => !action.route)
      .map((action) => action.name)
      .sort(),
  };
}

/**
 * Сверка человеческих строк с закреплённым списком в ОБЕ стороны: закреплённая
 * строка переклассифицирована — красное; строка `human:` вне списка — тоже
 * красное (U5c, 28.09.2026: три новые строки не были закреплены, и выдачу
 * `POST /api/sandbox/mcp-call` действию `sandbox_ask` не заметил никто).
 */
function humanDrift(ledger: RouteLedger, pinned: Readonly<Record<string, RouteClass>>): string[] {
  const drifted = Object.entries(pinned)
    .filter(([key, routeClass]) => ledger[key] !== routeClass)
    .map(([key, routeClass]) => `${key}: ${routeClass} → ${ledger[key] ?? '(no row)'}`);
  const unpinned = Object.entries(ledger)
    .filter(([key, routeClass]) => routeClass.startsWith('human:') && !(key in pinned))
    .map(([key, routeClass]) => `${key}: ${routeClass} is not pinned`);
  return [...drifted, ...unpinned];
}

function unjustified(ledger: RouteLedger, actions: readonly AnyPanelAction[]): string[] {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const out: string[] = [];
  for (const [key, routeClass] of Object.entries(ledger)) {
    for (const name of actionsOf(routeClass)) {
      const action = byName.get(name);
      if (action && !grantJustified(key, action)) out.push(`${key} → ${name}`);
    }
  }
  return out;
}

function grantJustified(key: string, action: AnyPanelAction): boolean {
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const pattern = key.slice(space + 1);
  const source = [action.route, action.afterRoute]
    .filter(Boolean)
    .map((fn) => String(fn))
    .join('\n');
  const viaHelper = Object.entries(HELPER_GRANTS).some(
    ([helper, keys]) => keys.includes(key) && new RegExp(`\\b${helper}\\(`).test(source),
  );
  if (viaHelper) return true;
  // Подстановка из конечного набора литералов кода — каждым значением по очереди.
  let variants = [source];
  for (const [expression, values] of Object.entries(CLOSED_SETS[action.name] ?? {})) {
    const hole = '${' + expression + '}';
    variants = variants.flatMap((text) =>
      text.includes(hole) ? values.map((value) => text.split(hole).join(value)) : [text],
    );
  }
  const { constants, definitions } = moduleDefinitions();
  // Один шаг вглубь: константа адреса (`CLI_URL`) или функция-сборщик
  // (`contourUrl(id)`) модуля действий, на которую ссылается исходник действия.
  const referenced = [...definitions]
    .filter(([name]) =>
      new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(source),
    )
    .flatMap(([, texts]) => [...texts]);
  const resolve = holeResolver(constants, definitions);
  // Метод и адрес — ПАРОЙ одного запроса, а не каждый где-то в исходнике: иначе
  // `POST` соседнего запроса и `/api/sandbox/${id}` удаления оправдывали любой
  // `POST /api/sandbox/<что угодно>` (U5c, 28.09.2026).
  return [...variants, ...referenced].some((piece) =>
    requestPairs(piece, resolve, definitions).some(
      ([verb, literal]) => verb === method && literalMatches(pattern, literal),
    ),
  );
}

/** Методы литералами в выражении метода: `'POST'`, `input.connect ? 'POST' : 'DELETE'`. */
const METHOD_LITERALS = /(['"`])(GET|POST|PUT|PATCH|DELETE)\1/g;

interface SourceScan {
  /** Пары фигурных скобок кода (не строк и не комментариев): `[открыта, закрыта]`. */
  braces: Array<[number, number]>;
  /** 1 — символ внутри строки, шаблона или комментария. */
  text: Uint8Array;
}

/** Разметка исходника: где код, а где текст, и где объекты `{…}`. */
function scanSource(source: string): SourceScan {
  const text = new Uint8Array(source.length);
  const braces: Array<[number, number]> = [];
  const stack: Array<{ at: number; template: boolean }> = [];
  const modes: Array<'code' | 'template'> = ['code'];
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (modes.at(-1) === 'template') {
      if (char === '`') {
        text[at] = 1;
        modes.pop();
        at += 1;
      } else if (char === '$' && source[at + 1] === '{') {
        stack.push({ at: at + 1, template: true });
        modes.push('code');
        at += 2;
      } else {
        const step = char === '\\' ? 2 : 1;
        text.fill(1, at, at + step);
        at += step;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') {
        end += source[end] === '\\' ? 2 : 1;
      }
      text.fill(1, at, end + 1);
      at = end + 1;
    } else if (char === '`') {
      text[at] = 1;
      modes.push('template');
      at += 1;
    } else if (char === '/' && (source[at + 1] === '/' || source[at + 1] === '*')) {
      const close = source[at + 1] === '/' ? '\n' : '*/';
      const found = source.indexOf(close, at + 2);
      const end = found === -1 ? source.length : found + close.length;
      text.fill(1, at, end);
      at = end;
    } else {
      if (char === '{') stack.push({ at, template: false });
      if (char === '}') {
        const open = stack.pop();
        if (open) {
          braces.push([open.at, at]);
          if (open.template) modes.pop();
        }
      }
      at += 1;
    }
  }
  return { braces, text };
}

/** Части между запятыми верхнего уровня от `start` до закрывающей скобки `close`. */
function topLevelParts(source: string, scan: SourceScan, start: number, close: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = start;
  for (let at = start; at < source.length; at += 1) {
    if (scan.text[at]) continue;
    const char = source[at]!;
    if (depth === 0 && (char === close || char === ',')) {
      parts.push(source.slice(from, at));
      if (char === close) return parts;
      from = at + 1;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
  }
  return parts;
}

/** Ключи верхнего уровня объекта `{…}` с текстом значения; `{ url }` — сокращение. */
function objectEntries(source: string, scan: SourceScan, open: number): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of topLevelParts(source, scan, open + 1, '}')) {
    const clean = part.replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*/, '');
    const entry = /^\s*([A-Za-z_$][\w$]*)\s*(?::([\s\S]*))?$/.exec(clean);
    if (entry) entries.set(entry[1]!, (entry[2] ?? entry[1]!).trim());
  }
  return entries;
}

/**
 * Запросы исходника парами (метод, адрес): объект `{ method, url }` (без
 * `method` — GET, как у `inject`) и `readRoute(inject, адрес)` — GET; вызов
 * после преобразования vitest — `(0, __vi_import_0__.readRoute)(…)`. Метод
 * без литерала (`{ method, url }` из переменной) пары не даёт: такую выдачу
 * оправдывает только `HELPER_GRANTS`. Адрес константой или сборщиком модуля —
 * их адреса.
 */
function requestPairs(
  source: string,
  resolve: (expression: string) => string | undefined,
  definitions: ReadonlyMap<string, ReadonlySet<string>>,
): Array<[method: string, literal: string]> {
  const scan = scanSource(source);
  const pairs: Array<[string, string]> = [];
  const literalsOf = (expression: string): string[] => {
    const found = urlLiterals(expression, resolve);
    if (found.length > 0) return found;
    const resolved = resolve(expression.trim());
    if (resolved !== undefined) return [resolved];
    const name = /^([A-Za-z_$][\w$]*)(?:\(|$)/.exec(expression.trim())?.[1];
    const texts = name === undefined ? undefined : definitions.get(name);
    return texts ? urlLiterals([...texts].join('\n'), resolve) : [];
  };
  const seen = new Set<number>();
  for (const match of source.matchAll(/\burl\b/g)) {
    if (scan.text[match.index]) continue;
    let owner: [number, number] | undefined;
    for (const span of scan.braces) {
      if (span[0] < match.index && match.index < span[1] && (!owner || span[0] > owner[0])) {
        owner = span;
      }
    }
    if (!owner || seen.has(owner[0])) continue;
    seen.add(owner[0]);
    const entries = objectEntries(source, scan, owner[0]);
    const url = entries.get('url');
    if (url === undefined) continue;
    const method = entries.get('method');
    const verbs =
      method === undefined ? ['GET'] : [...method.matchAll(METHOD_LITERALS)].map((m) => m[2]!);
    for (const verb of verbs) for (const literal of literalsOf(url)) pairs.push([verb, literal]);
  }
  for (const match of source.matchAll(/\breadRoute\b(?:<[\s\S]*?>)?\)?\(/g)) {
    if (scan.text[match.index]) continue;
    const url = topLevelParts(source, scan, match.index + match[0].length, ')')[1];
    if (url !== undefined) for (const literal of literalsOf(url)) pairs.push(['GET', literal]);
  }
  return pairs;
}

/**
 * Подстановка `${…}` шаблона: константа адреса — её значение, вызов
 * функции-сборщика (`${contourUrl(id)}/spend`) — её единственный адрес.
 */
function holeResolver(
  constants: ReadonlyMap<string, ReadonlySet<string>>,
  definitions: ReadonlyMap<string, ReadonlySet<string>>,
): (expression: string) => string | undefined {
  const single = (values: Iterable<string>): string | undefined => {
    const distinct = [...new Set(values)];
    return distinct.length === 1 ? distinct[0] : undefined;
  };
  const constant = (expression: string): string | undefined => {
    const values = constants.get(expression);
    return values ? single(values) : undefined;
  };
  return (expression) => {
    const direct = constant(expression);
    if (direct !== undefined) return direct;
    const call = /^([A-Za-z_$][\w$]*)\(/.exec(expression)?.[1];
    const texts = call === undefined ? undefined : definitions.get(call);
    return texts ? single(urlLiterals([...texts].join('\n'), constant)) : undefined;
  };
}

interface ModuleDefinitions {
  /** `const CLI_URL = '/api/chat/cli'` — подставляется в `${CLI_URL}` шаблонов. */
  constants: Map<string, Set<string>>;
  /** Текст каждого верхнеуровневого `const`/`function` модулей действий с адресом внутри. */
  definitions: Map<string, Set<string>>;
}

let definitionsCache: ModuleDefinitions | undefined;

/**
 * Определения модулей действий, где лежит адрес: адрес, вынесенный в константу
 * или функцию-сборщик, оправдывает выдачу так же, как литерал на месте.
 */
function moduleDefinitions(): ModuleDefinitions {
  if (definitionsCache) return definitionsCache;
  const dir = dirname(fileURLToPath(import.meta.url));
  const constants = new Map<string, Set<string>>();
  const definitions = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, name: string, value: string): void => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(value);
  };
  const constant = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/api\/[^'"`$]*)\2/g;
  const head = /^(?:export\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/;
  const texts = readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
  for (const text of texts) {
    for (const match of text.matchAll(constant)) add(constants, match[1]!, match[3]!);
  }
  // Определение с адресом: литерал `/api/` или подстановка константы адреса.
  const carriesUrl = new RegExp(
    [/\/api\//.source, ...[...constants.keys()].map((name) => `\\$\\{${name}\\}`)].join('|'),
  );
  for (const text of texts) {
    // Верхнеуровневый оператор — от строки с `const|function имя` до следующей
    // строки, начатой с нуля не закрывающей скобкой.
    let name: string | undefined;
    let body: string[] = [];
    const flush = (): void => {
      if (name && carriesUrl.test(body.join('\n'))) add(definitions, name, body.join('\n'));
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^[^\s)}\]]/.test(line)) {
        flush();
        name = head.exec(line)?.[1];
        body = [];
      }
      if (name) body.push(line);
    }
    flush();
  }
  definitionsCache = { constants, definitions };
  return definitionsCache;
}

/** Заглушка `${…}` в тексте шаблонной строки. */
const HOLE = '\u0000';

/**
 * Строковые и шаблонные литералы исходника, начинающиеся с `/api/`. Шаблон
 * разбирается честно: `${…}` с вложенными строками и шаблонами становится
 * заглушкой, а не концом литерала (`split('/')` внутри подстановки ломал
 * наивное регулярное выражение); `resolve` превращает подстановку в адрес.
 */
function urlLiterals(
  source: string,
  resolve: (expression: string) => string | undefined = () => undefined,
): string[] {
  const out: string[] = [];
  let at = 0;
  const quoted = (quote: string): string => {
    let text = '';
    at += 1;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === '\\') {
        text += source[at + 1] ?? '';
        at += 2;
        continue;
      }
      text += source[at];
      at += 1;
    }
    at += 1;
    return text;
  };
  const expression = (): void => {
    let depth = 1;
    while (at < source.length && depth > 0) {
      const char = source[at]!;
      if (char === "'" || char === '"') quoted(char);
      else if (char === '`') template();
      else {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        at += 1;
      }
    }
  };
  const template = (): string => {
    let text = '';
    at += 1;
    while (at < source.length && source[at] !== '`') {
      if (source[at] === '\\') {
        text += source[at + 1] ?? '';
        at += 2;
      } else if (source[at] === '$' && source[at + 1] === '{') {
        at += 2;
        const start = at;
        expression();
        // `${CLI_URL}?refresh=1`, `${contourUrl(id)}/spend`: адрес константы или сборщика.
        text += resolve(source.slice(start, at - 1).trim()) ?? HOLE;
      } else {
        text += source[at];
        at += 1;
      }
    }
    at += 1;
    return text;
  };
  while (at < source.length) {
    const char = source[at]!;
    let text: string | undefined;
    if (char === "'" || char === '"') text = quoted(char);
    else if (char === '`') text = template();
    else at += 1;
    if (text?.startsWith('/api/')) out.push(text);
  }
  return out;
}

/** Литерал (с заглушками) может попасть в шаблон маршрута `pattern`. */
function literalMatches(pattern: string, literal: string): boolean {
  const want = pattern.split('/').slice(1);
  const have = literal.split('?', 1)[0]!.split('/').slice(1);
  const wildcard = want.at(-1) === '*';
  const fixed = wildcard ? want.slice(0, -1) : want;
  if (wildcard ? have.length <= fixed.length : have.length !== fixed.length) return false;
  return fixed.every((part, index) => {
    const segment = have[index]!;
    if (part.startsWith(':')) return segment !== '';
    if (!segment.includes(HOLE)) return segment === part;
    // Ревью U0, m4 (28.09.2026): заглушка — значение модели, оно попадает только в
    // `:param`/`*`. Прежнее `HOLE → .*` оправдывало шаблоном `/api/x/${id}` любой
    // статичный сосед `/api/x/<имя>`. Исключение — хвост последнего сегмента после
    // статичного имени: `topics${query}` — это строка запроса, а не имя.
    const tail = index === have.length - 1 && segment.indexOf(HOLE) > 0;
    return tail && segment.slice(0, segment.indexOf(HOLE)) === part;
  });
}

// ---- the live app assembly ----

const routes: string[] = [];
let app: FastifyInstance | undefined;
let shutdown: (() => void) | undefined;
let actions: readonly AnyPanelAction[] = [];
let home = '';
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
};

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-ledger-home-')));
  const config = join(home, '.claude');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  // Каталог конфигурации — временный, иначе сборка не поднимается вовсе: настоящий
  // `~/.claude` владельца тест не читает и не пишет.
  const { detectClaudeLocation } = await import('../../lib/claude-paths.ts');
  const root = realpathSync(detectClaudeLocation().paths.root);
  if (!root.startsWith(home)) throw new Error(`refusing to assemble over ${root}`);

  const { default: Fastify } = await import('fastify');
  const { ServerContext } = await import('../../context.ts');
  const { createRuntime } = await import('../../bootstrap/runtime.ts');
  const { buildRouteTable } = await import('../../bootstrap/route-table.ts');
  ({ PANEL_ACTIONS: actions } = await import('./actions.ts'));

  const ctx = new ServerContext();
  const runtime = createRuntime(ctx, 'http://127.0.0.1:1');
  shutdown = () => runtime.shutdown();
  const instance = Fastify();
  instance.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
    }
  });
  // Ни один обработчик не исполняется: ответ — шаблон маршрута, который выбрал
  // маршрутизатор Fastify. Это эталон для `resolveRouteKey`.
  instance.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions.url;
    await reply.send({ key: url ? `${request.method} ${url}` : null });
    return reply;
  });
  const access = {
    allowedOrigins: new Set<string>(),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  for (const register of buildRouteTable(runtime, access)) register(instance, ctx);
  await instance.ready();
  app = instance;
}, 120_000);

afterAll(async () => {
  shutdown?.();
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('capability ledger (G4) against the live app assembly', () => {
  it('every route of the app has a row, and every row is a route of the app', () => {
    expect(routes.length).toBeGreaterThan(400);
    expect(new Set(routes).size).toBe(routes.length);
    expect(unaccounted(routes, ROUTE_LEDGER)).toEqual({ missing: [], stale: [] });
  });

  it('planted: a new route without a row and a row without a route are both red', () => {
    const { ['GET /api/projects']: _dropped, ...withoutRow } = ROUTE_LEDGER;
    expect(unaccounted([...routes, 'POST /api/brand-new'], withoutRow)).toEqual({
      missing: ['GET /api/projects', 'POST /api/brand-new'],
      stale: [],
    });
    expect(unaccounted(routes, { ...ROUTE_LEDGER, 'GET /api/gone': 'gap:U1' }).stale).toEqual([
      'GET /api/gone',
    ]);
  });

  it('every action a row names is a routed action of PANEL_ACTIONS', () => {
    expect(actions.length).toBeGreaterThan(100);
    expect(unknownActions(ROUTE_LEDGER, actions)).toEqual([]);
    expect(
      unknownActions(
        { ...ROUTE_LEDGER, 'GET /api/projects': 'action:list_projects,ghost' },
        actions,
      ),
    ).toEqual(['GET /api/projects → ghost']);
  });

  it('every routed action has a row; the local ones are exactly LOCAL_ACTIONS', () => {
    expect(rowless(ROUTE_LEDGER, actions)).toEqual({
      withoutRow: [],
      locals: [...LOCAL_ACTIONS].sort(),
    });
    const { ['GET /api/projects']: _dropped, ...withoutListProjects } = ROUTE_LEDGER;
    expect(rowless(withoutListProjects, actions).withoutRow).toEqual(['list_projects']);
  });

  it('method and URL are read as a pair of one request, not each anywhere in the source', () => {
    const source =
      'async (input, inject) => {\n' +
      '  const view = await (0, __vi_import_0__.readRoute)(inject, `/api/x/${input.id}`);\n' +
      "  // { method: 'DELETE', url: '/api/comment' }\n" +
      "  return { method: input.on ? 'POST' : 'DELETE', url: '/api/y', body: { url: 'z' } };\n" +
      '}';
    expect(requestPairs(source, () => undefined, new Map())).toEqual([
      ['POST', '/api/y'],
      ['DELETE', '/api/y'],
      ['GET', `/api/x/${HOLE}`],
    ]);
    // Метод переменной — пары нет: такую выдачу оправдывает только HELPER_GRANTS.
    expect(requestPairs("({ method, url: '/api/y' })", () => undefined, new Map())).toEqual([]);
    // Без `method` — GET, как у inject.
    expect(requestPairs("inject({ url: '/api/y' })", () => undefined, new Map())).toEqual([
      ['GET', '/api/y'],
    ]);
  });

  it('every grant is justified by the action’s own code (method and URL of one request, or a named helper)', () => {
    expect(unjustified(ROUTE_LEDGER, actions)).toEqual([]);
    // Мутант U5c (28.09.2026): `sandbox_ask` шлёт POST на `/api/sandbox/run` и DELETE на
    // `/api/sandbox/${id}`. Метод одного запроса и адрес другого выдачу не оправдывают.
    expect(
      unjustified({ ...ROUTE_LEDGER, 'POST /api/sandbox/mcp-call': 'action:sandbox_ask' }, actions),
    ).toEqual(['POST /api/sandbox/mcp-call → sandbox_ask']);
    // m4: шаблон `/api/chat/split/${…}/${MODE_ROUTE[…]}` не оправдывает статичного соседа
    // вне набора режимов (прежнее `HOLE → .*` оправдывало).
    expect(
      unjustified(
        { ...ROUTE_LEDGER, 'POST /api/chat/split/:parent/start-now': 'action:split_control' },
        actions,
      ),
    ).toEqual(['POST /api/chat/split/:parent/start-now → split_control']);
    const overGranted = {
      ...ROUTE_LEDGER,
      'DELETE /api/projects/:id': 'action:delete_project,list_projects',
      'PUT /api/rules/:id': 'action:save_rule,delete_rule',
    } as const;
    expect(unjustified(overGranted, actions)).toEqual(
      ['PUT /api/rules/:id → delete_rule', 'DELETE /api/projects/:id → list_projects'].sort(
        (a, b) =>
          Object.keys(overGranted).indexOf(a.split(' → ')[0]!) -
          Object.keys(overGranted).indexOf(b.split(' → ')[0]!),
      ),
    );
    // Каждый помощник действительно зовётся хоть одним действием — иначе строка устарела.
    const sources = actions.map(
      (action) => `${String(action.route)}\n${String(action.afterRoute)}`,
    );
    for (const helper of Object.keys(HELPER_GRANTS)) {
      expect(
        sources.some((source) => source.includes(`${helper}(`)),
        helper,
      ).toBe(true);
    }
  });

  it('the URL literal parser reads templates with nested strings and substitutions', () => {
    const source =
      "(input) => ({ method: 'GET', url: `/api/scripts/${input.id.split('/').map(encode).join('/')}` })" +
      "\n(input) => ({ url: `/api/agent/help/topics${input.language ? `?lang=${input.language}` : ''}` })" +
      '\n(i) => readRoute(inject, "/api/projects")';
    expect(urlLiterals(source)).toEqual([
      `/api/scripts/${HOLE}`,
      `/api/agent/help/topics${HOLE}`,
      '/api/projects',
    ]);
    expect(literalMatches('/api/scripts/*', `/api/scripts/${HOLE}`)).toBe(true);
    expect(literalMatches('/api/agent/help/topics', `/api/agent/help/topics${HOLE}`)).toBe(true);
    expect(literalMatches('/api/projects/:id', '/api/projects')).toBe(false);
    // m4: значение модели — только параметр или хвост, никогда статичный сосед.
    expect(literalMatches('/api/projects/:id', `/api/projects/${HOLE}`)).toBe(true);
    expect(literalMatches('/api/projects/local', `/api/projects/${HOLE}`)).toBe(false);
    expect(literalMatches('/api/projects/:id/local', `/api/projects/${HOLE}/local`)).toBe(true);
    expect(literalMatches('/api/env/reveal', `/api/env/${HOLE}`)).toBe(false);
    expect(literalMatches('/api/env/reveal', `/api/${HOLE}/reveal`)).toBe(false);
  });

  it('human-only rows are pinned (D2): reclassifying one needs the owner', () => {
    expect(Object.keys(PINNED_HUMAN).length).toBeGreaterThan(50);
    expect(humanDrift(ROUTE_LEDGER, PINNED_HUMAN)).toEqual([]);
    expect(
      humanDrift(
        { ...ROUTE_LEDGER, 'POST /api/sandbox/mcp-call': 'action:sandbox_ask' },
        PINNED_HUMAN,
      ),
    ).toEqual(['POST /api/sandbox/mcp-call: human:outward → action:sandbox_ask']);
    // Новая строка `human:` вне списка — тоже красное: иначе её молча выдадут действию.
    expect(
      humanDrift({ ...ROUTE_LEDGER, 'POST /api/brand-new': 'human:outward' }, PINNED_HUMAN),
    ).toEqual(['POST /api/brand-new: human:outward is not pinned']);
    expect(
      humanDrift({ ...ROUTE_LEDGER, 'POST /api/chat/split': 'action:start_chat' }, PINNED_HUMAN),
    ).toEqual(['POST /api/chat/split: human:split-apply → action:start_chat']);
  });

  it('resolveRouteKey picks the same route as the Fastify router (static > param > wildcard)', async () => {
    const keys = Object.keys(ROUTE_LEDGER);
    const staticAt = new Map<string, Set<string>>();
    for (const key of keys) {
      const [method, pattern] = key.split(' ') as [string, string];
      pattern
        .split('/')
        .slice(1)
        .forEach((part, index) => {
          if (part.startsWith(':') || part === '*') return;
          const slot = `${method}#${index}`;
          if (!staticAt.has(slot)) staticAt.set(slot, new Set());
          staticAt.get(slot)!.add(part);
        });
    }
    const samples = new Set<string>();
    for (const key of keys) {
      const [method, pattern] = key.split(' ') as [string, string];
      const parts = pattern.split('/').slice(1);
      const base = parts.map((part) => (part === '*' ? 'a/b' : part.startsWith(':') ? 'x1' : part));
      samples.add(`${method} /${base.join('/')}`);
      parts.forEach((part, index) => {
        if (!part.startsWith(':')) return;
        for (const collide of staticAt.get(`${method}#${index}`) ?? []) {
          const variant = [...base];
          variant[index] = collide;
          samples.add(`${method} /${variant.join('/')}`);
        }
      });
    }
    // Ревью U0, M1/m5 (28.09.2026): точки сырые, закодированные и смешанные — `inject`
    // снимает их до маршрутизатора, и реестр обязан видеть тот же маршрут, что и он.
    const dotted = [
      'GET /api/scripts/../prompts',
      'GET /api/scripts/%2e%2e/prompts',
      'GET /api/scripts/%2E%2E/remote',
      'GET /api/scripts/.%2e/compromises',
      'GET /api/scripts/%2E./env/reveal?key=A',
      'GET /api/scripts/x/./y',
      'GET /api/scripts/x/../../prompts',
      'DELETE /api/scripts/../credentials',
      'PUT /api/scripts/a/%2e%2e/%2e%2e/remote',
    ];
    for (const extra of [
      'GET /api/nowhere',
      'POST /api/projects/x1/y/z',
      'GET /api/scripts',
      'PUT /api/scripts/a%2Fb?x=1',
      'GET /api/%70rompts',
      ...dotted,
    ]) {
      samples.add(extra);
    }
    // …и сама точка — отказ на любом шаге, даже когда адрес остался внутри строки.
    for (const sample of dotted) {
      const [method, url] = sample.split(' ') as ['GET', string];
      for (const phase of ['execute', 'card', 'prep', 'after'] as const) {
        expect(
          capabilityRefusal(ROUTE_LEDGER, 'read_script', phase, { method, url }),
          sample,
        ).toMatch(/'\.' or '\.\.' path part/);
      }
    }
    const mismatches: string[] = [];
    for (const sample of samples) {
      const [method, url] = sample.split(' ') as [string, string];
      const answer = await app!.inject({ method: method as 'GET', url });
      const fastify = (answer.json() as { key: string | null }).key;
      const ours = resolveRouteKey(ROUTE_LEDGER, method, url) ?? null;
      if (fastify !== ours) mismatches.push(`${sample}: fastify ${fastify}, ledger ${ours}`);
    }
    expect(samples.size).toBeGreaterThan(keys.length);
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe('capabilityRefusal: the phase rules', () => {
  const ledger: RouteLedger = {
    'GET /api/items': 'action:list_items',
    'POST /api/items': 'action:save_item',
    'PUT /api/items/:id/steps': 'action:save_item',
    'POST /api/preview': 'internal:preview',
    'GET /api/secret': 'human:secret',
    'POST /api/split': 'human:split-apply',
    'POST /api/later': 'gap:U1',
    'GET /api/later': 'gap:U1',
  };
  const allowed = (action: string, phase: Parameters<typeof capabilityRefusal>[2], key: string) => {
    const [method, url] = key.split(' ') as ['GET', string];
    return capabilityRefusal(ledger, action, phase, { method, url }) === undefined;
  };

  it.each([
    ['list_items', 'execute', 'GET /api/items', true],
    ['save_item', 'execute', 'GET /api/items', false],
    ['save_item', 'execute', 'POST /api/items', true],
    ['save_item', 'execute', 'POST /api/later', false],
    ['save_item', 'execute', 'POST /api/split', false],
    ['save_item', 'execute', 'POST /api/nowhere', false],
    ['save_item', 'card', 'GET /api/items?x=1', true],
    ['save_item', 'card', 'GET /api/later', true],
    ['save_item', 'card', 'GET /api/secret', false],
    ['save_item', 'card', 'POST /api/items', false],
    ['save_item', 'card', 'POST /api/preview', true],
    ['save_item', 'prep', 'POST /api/items', false],
    ['save_item', 'prep', 'GET /api/nowhere', false],
    ['save_item', 'after', 'PUT /api/items/7/steps', true],
    ['list_items', 'after', 'PUT /api/items/7/steps', false],
    ['save_item', 'after', 'POST /api/later', false],
    ['save_item', 'after', 'POST /api/preview', true],
    ['save_item', 'after', 'GET /api/secret', false],
  ] as const)('%s %s %s → allowed %s', (action, phase, key, expected) => {
    expect(allowed(action, phase, key)).toBe(expected);
  });

  it('the refusal names the step without /api/ and says nothing ran', () => {
    const human = capabilityRefusal(ledger, 'x', 'execute', { method: 'POST', url: '/api/split' });
    expect(human).toMatch(/^This step is the human’s \(POST split\): .+ Nothing was executed\.$/);
    const after = capabilityRefusal(ledger, 'x', 'after', { method: 'POST', url: '/api/later' });
    expect(after).toContain('The main step already ran; this follow-up step was not executed.');
    expect(`${human}${after}`).not.toMatch(/\/api\//);
  });
});
