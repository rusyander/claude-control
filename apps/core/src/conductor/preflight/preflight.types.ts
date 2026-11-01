/** Предполётная проверка дорог (04:105-112, R:S2-30, P101). */

export const ROADS = [
  'cli',
  'route',
  'core-mcp',
  'capture',
  'push-closure',
  'ls-remote',
  'forge-read',
  'container-engine',
  'disk',
  'ram',
  'ports',
  'repo-access',
  /** git ≥ 2.38 (`merge-tree --write-tree`) — только когда сценарий публикует (05 §Push and MR). */
  'git-version',
] as const;

export type Road = (typeof ROADS)[number];

/**
 * Ответ одной пробы. `fail` — дорога сломана; `unknown` — проба не смогла ответить; `low` —
 * ресурса мало (диск — запрет новых копий, память — сниженные слоты).
 */
export type RoadOutcome =
  | { status: 'ok'; detail?: string }
  | { status: 'fail'; detail: string; fix: string }
  | { status: 'unknown'; detail: string; fix?: string }
  | { status: 'low'; detail: string; fix?: string };

export type RoadProbe = () => Promise<RoadOutcome>;

export type RoadResult =
  | ({ road: Road } & RoadOutcome)
  | { road: Road; status: 'not-checked-until-phase'; phase: 6; detail: string }
  | { road: Road; status: 'skipped'; detail: string };

export interface PreflightInput {
  /** Профиль требует сервисов (рецепты или `needs` у проверок); профиль неизвестен — `'unknown'`. */
  needsServices: boolean | 'unknown';
  /** Сценарий задачи публикует; `false` — дорога `git-version` пропущена, не задано — проверяется. */
  publishes?: boolean;
}

export type PreflightProbes = Partial<Record<Road, RoadProbe>>;

export interface PreflightOptions {
  /** Потолок одной пробы; висящая проба — `unknown(timeout)`, не вечное ожидание. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

/**
 * Итог проверки. `start: false` — задача не запускается, `blocking` называет дороги и исправления
 * для экрана запуска. `noNewCopies` — диска мало: ни копий, ни контейнеров. `slotsLowered` —
 * памяти мало: слоты новых запусков снижены (запуск разрешён).
 */
export interface PreflightVerdict {
  start: boolean;
  roads: RoadResult[];
  blocking: RoadResult[];
  noNewCopies: boolean;
  slotsLowered: boolean;
  /** Сомнения, не блокирующие запуск (диск/память `unknown`) — названы, не скрыты. */
  doubts: RoadResult[];
}
