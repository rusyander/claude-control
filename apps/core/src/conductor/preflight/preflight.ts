import type {
  PreflightInput,
  PreflightOptions,
  PreflightProbes,
  PreflightVerdict,
  Road,
  RoadOutcome,
  RoadProbe,
  RoadResult,
} from './preflight.types.ts';
import { ROADS } from './preflight.types.ts';

/**
 * Предполётная проверка (04:105-112, P101): каждая дорога, нужная задаче, проверяется до запуска,
 * без вызова модели. Правило одно: `fail` и `unknown` любой дороги не дают задаче стартовать, и
 * экран запуска называет дорогу и исправление. Исключения — только ресурсы: `unknown` диска или
 * памяти — запуск с названным сомнением (класс `machine.disk`: «сомнение — прогон»); `low` диска —
 * запрет (новая копия — первое, что делает задача), `low` памяти — сниженные слоты. Проба,
 * которой нет в сборке, — `unknown('not wired')`, никогда не молчаливое `ok`. Замыкание push и
 * чтение форжа появятся в фазе 6 — до неё `not-checked-until-phase`, никогда не `ok`.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const LATER_PHASE: ReadonlySet<Road> = new Set<Road>(['push-closure', 'forge-read']);
const RESOURCE_DOUBT_ADMITS: ReadonlySet<Road> = new Set<Road>(['disk', 'ram']);

function realTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

async function guarded(probe: RoadProbe, options: PreflightOptions): Promise<RoadOutcome> {
  const ms = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let timer: { cancel(): void } | undefined;
  const timeout = new Promise<RoadOutcome>((resolve) => {
    timer = (options.setTimer ?? realTimer)(
      () => resolve({ status: 'unknown', detail: `probe timeout after ${ms} ms` }),
      ms,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch((error: unknown): RoadOutcome => ({
          status: 'unknown',
          detail: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
        })),
      timeout,
    ]);
  } finally {
    timer?.cancel();
  }
}

async function checkRoad(
  road: Road,
  input: PreflightInput,
  probes: PreflightProbes,
  options: PreflightOptions,
): Promise<RoadResult> {
  if (LATER_PHASE.has(road))
    return {
      road,
      status: 'not-checked-until-phase',
      phase: 6,
      detail: 'arrives with publish (05)',
    };
  if (road === 'container-engine' && input.needsServices === false)
    return { road, status: 'skipped', detail: 'profile needs no services' };
  const probe = probes[road];
  if (!probe)
    return { road, status: 'unknown', detail: 'not wired: no probe for this road in this build' };
  return { road, ...shapeOf(road, await guarded(probe, options)) };
}

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * Ответ пробы — данные чужой зоны: форма проверяется, а не принимается на веру (B2r7-F05).
 * `skipped` и `not-checked-until-phase` ставит только сама проверка, `low` — только у ресурсов;
 * любой другой ответ (null, `{}`, `{status:'OK'}`, `low` у CLI) — `unknown`, дорога не цела.
 */
function shapeOf(road: Road, raw: unknown): RoadOutcome {
  const garbage = (): RoadOutcome => ({
    status: 'unknown',
    detail: `garbage probe answer: ${JSON.stringify(raw) ?? String(raw)}`,
  });
  if (typeof raw !== 'object' || raw === null) return garbage();
  const r = raw as Record<string, unknown>;
  const detail = r.detail;
  const fix = r.fix;
  if (fix !== undefined && !str(fix)) return garbage();
  switch (r.status) {
    case 'ok':
      return detail === undefined || str(detail)
        ? { status: 'ok', ...(str(detail) ? { detail } : {}) }
        : garbage();
    case 'fail':
      return str(detail) ? { status: 'fail', detail, fix: str(fix) ? fix : '' } : garbage();
    case 'unknown':
      return str(detail) ? { status: 'unknown', detail, ...(str(fix) ? { fix } : {}) } : garbage();
    case 'low':
      return str(detail) && RESOURCE_DOUBT_ADMITS.has(road)
        ? { status: 'low', detail, ...(str(fix) ? { fix } : {}) }
        : garbage();
    default:
      return garbage();
  }
}

/** Список допуска: стартуют только перечисленные ответы, всё прочее блокирует. */
function admits(r: RoadResult): boolean {
  switch (r.status) {
    case 'ok':
    case 'skipped':
    case 'not-checked-until-phase':
      return true;
    case 'low':
      return r.road === 'ram';
    case 'unknown':
      return RESOURCE_DOUBT_ADMITS.has(r.road);
    default:
      return false;
  }
}

const blocks = (r: RoadResult): boolean => !admits(r);

export async function runPreflight(
  input: PreflightInput,
  probes: PreflightProbes,
  options: PreflightOptions = {},
): Promise<PreflightVerdict> {
  // Пробы независимы — параллельно: самая медленная задаёт время, а не их сумма.
  const roads = await Promise.all(ROADS.map((road) => checkRoad(road, input, probes, options)));
  const blocking = roads.filter(blocks);
  return {
    start: blocking.length === 0,
    roads,
    blocking,
    noNewCopies: roads.some((r) => r.road === 'disk' && r.status === 'low'),
    slotsLowered: roads.some((r) => r.road === 'ram' && r.status === 'low'),
    doubts: roads.filter((r) => r.status === 'unknown' && RESOURCE_DOUBT_ADMITS.has(r.road)),
  };
}
