import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { RouteId, RouteKind } from '@agentdeck/contracts/core/routes';
import { locateCli } from '../../platform/cli-location.ts';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import type { OsKind } from '../../platform/os-kind.ts';
import { isAbsolutePath } from '../../platform/paths.ts';
import { fileSize } from '../../platform/safe-io/files.ts';
import type { PreflightProbes, RoadOutcome } from './preflight.types.ts';

/**
 * Пробы дорог сессии (04:105-112, P101): CLI, маршрут, MCP ядра, захват. Каждая отвечает о том,
 * чем пойдёт сессия задачи на деле: CLI — тот же поиск исполняемого файла, что у запускателя
 * (PATH процесса ядра, без общих каталогов — иначе проба нашла бы то, чего запуск не найдёт);
 * маршрут — тот же реестр, из которого берёт дорога сессии; MCP — та же запись `mcpServers`,
 * которую дорога кладёт в шаг; захват — та же прокладка `nodeRequires`. Не подключено снаружи —
 * `unknown` с названием, чего нет: неизвестность никогда не «да».
 */

export type AllowedRoute = JournalDataV1['task.created']['allowedRoutes'][number];

export interface RoadProbeInput {
  /** Разрешённые тройки задачи (переходник, маршрут, модель) — их CLI и маршруты проверяются. */
  allowed: readonly AllowedRoute[];
  /**
   * Исполняемый файл CLI переходника из реестра переходников; `undefined` — переходника нет в
   * сборке. Сам реестр не дан (`undefined`) — дорога `cli` неизвестна.
   */
  cliOf?: (adapterId: string) => string | undefined;
  /** Реестр маршрутов загрузки; не дан — дорога `route` неизвестна. */
  routes?: { get(id: RouteId): { kind: RouteKind } | undefined };
  /** Запись `mcpServers` моста ядра, как её кладёт дорога сессии. */
  coreMcp?: { command: string; args: readonly string[] };
  /** Прокладка захвата (`nodeRequires` сессии) и ручки захвата на API этой сборки. */
  capture?: { preload: string; endpointRegistered: boolean };
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
}

const NO_ROUTE: RoadOutcome = {
  status: 'unknown',
  detail: 'task allows no route: no CLI and no route to check',
  fix: 'name the allowed routes of the task (route config of the core)',
};

function notWired(what: string): RoadOutcome {
  return { status: 'unknown', detail: `not wired: ${what}` };
}

/** Файл на месте: `absent` — нет, исключение чтения — неизвестность (P44), не «нет». */
function fileFact(path: string): Fact<number> {
  try {
    return fileSize(path);
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

/** Задача пойдёт любой своей тройкой: дорога годна, когда годна хотя бы одна; прочие названы. */
function anyUsable(oks: string[], bad: string[], fix: string): RoadOutcome {
  if (oks.length > 0)
    return { status: 'ok', detail: [...oks, ...bad.map((b) => `unusable ${b}`)].join('; ') };
  return { status: 'fail', detail: bad.join('; '), fix };
}

export function cliProbe(input: RoadProbeInput): () => Promise<RoadOutcome> {
  return async () => {
    const cliOf = input.cliOf;
    if (!cliOf) return notWired('the conductor has no adapter registry');
    if (input.allowed.length === 0) return NO_ROUTE;
    const oks: string[] = [];
    const bad: string[] = [];
    for (const adapter of new Set(input.allowed.map((a) => a.adapter))) {
      const executable = cliOf(adapter);
      if (executable === undefined) {
        bad.push(`${adapter}: adapter not in this core build`);
        continue;
      }
      const found = locateCli({
        executable,
        commonDirs: false,
        ...(input.env ? { env: input.env } : {}),
        ...(input.os ? { os: input.os } : {}),
      });
      if (found.ok) oks.push(`${adapter}: ${found.found}`);
      else if (found.absent)
        bad.push(`${adapter}: «${executable}» not found (searched ${found.searched.length} dirs)`);
      else bad.push(`${adapter}: «${found.found}» refused: ${found.refused}`);
    }
    return anyUsable(oks, bad, 'install the CLI or put it on the PATH the core was started with');
  };
}

export function routeProbe(input: RoadProbeInput): () => Promise<RoadOutcome> {
  return async () => {
    const routes = input.routes;
    if (!routes) return notWired('the conductor has no route registry');
    if (input.allowed.length === 0) return NO_ROUTE;
    const oks: string[] = [];
    const bad: string[] = [];
    for (const a of input.allowed) {
      const route = routes.get(a.route.id);
      if (!route) bad.push(`${a.route.id}: not in the route registry`);
      else if (route.kind !== a.route.kind)
        bad.push(`${a.route.id}: registry kind ${route.kind}, task names ${a.route.kind}`);
      else oks.push(`${a.route.id} (${route.kind})`);
    }
    return anyUsable(oks, bad, 'add the route to the core route config or allow an existing one');
  };
}

export function coreMcpProbe(input: RoadProbeInput): () => Promise<RoadOutcome> {
  return async () => {
    const entry = input.coreMcp;
    if (!entry) return notWired('no core MCP server entry');
    const command = resolveExecutable(entry.command, {
      ...(input.env ? { env: input.env } : {}),
      ...(input.os ? { os: input.os } : {}),
    });
    if (!command.ok) {
      const why = command.absent ? 'not found' : `refused: ${command.refused}`;
      return {
        status: 'fail',
        detail: `core MCP command «${entry.command}» ${why}`,
        fix: 'restart the core with a node it can find',
      };
    }
    // Скрипт моста — путь среди аргументов: нет файла — сессия без инструментов ядра.
    for (const arg of entry.args.filter((a) => isAbsolutePath(a, input.os))) {
      const file = fileFact(arg);
      if ('absent' in file)
        return {
          status: 'fail',
          detail: `core MCP entry ${arg} is missing`,
          fix: 'reinstall the core (its mcp/run.ts is gone)',
        };
      if ('unknown' in file)
        return { status: 'unknown', detail: `core MCP entry ${arg} unreadable: ${file.unknown}` };
    }
    return { status: 'ok', detail: `${command.found} ${entry.args.join(' ')}` };
  };
}

export function captureProbe(input: RoadProbeInput): () => Promise<RoadOutcome> {
  return async () => {
    const capture = input.capture;
    if (!capture) return notWired('no capture preload');
    if (!capture.endpointRegistered)
      return {
        status: 'fail',
        detail: 'capture endpoints are not registered on the core API',
        fix: 'restart the core: boot registers /v1/session/capture',
      };
    const file = fileFact(capture.preload);
    if ('absent' in file)
      return {
        status: 'fail',
        detail: `capture preload ${capture.preload} is missing`,
        fix: 'reinstall the core (platform/capture-preload.cjs is gone)',
      };
    if ('unknown' in file)
      return { status: 'unknown', detail: `capture preload unreadable: ${file.unknown}` };
    return { status: 'ok', detail: `preload ${capture.preload}, endpoint registered` };
  };
}

/** Четыре дороги сессии одним набором — рядом с `machineProbes` в одном прогоне предпроверки. */
export function roadProbes(input: RoadProbeInput): PreflightProbes {
  return {
    cli: cliProbe(input),
    route: routeProbe(input),
    'core-mcp': coreMcpProbe(input),
    capture: captureProbe(input),
  };
}
