import { GROUP_WATCH_SEVERITY, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { modelFactor } from '../../../analytics/token-audit/window-weight.ts';
import { EVENT_HOLD_MS, recent, type Rule } from './rules-util.ts';
import type { FreshCause, RuleHit, WatchContext, WatchNode, WatchState } from './watch.types.ts';

/**
 * Правила пробелов автономии 24.10: R34 — новый разговор поверх тёплого, R35 —
 * новый разговор переделывает закоммиченное на этой стадии, R36 — свой сервер
 * сессии пережил паузу группы. Чистые функции; R35 считает сторож по списку группы.
 */

/** Нужные поводы нового разговора: без него стадия не пошла бы дальше. Прочие — лишний старт. */
const REQUIRED: ReadonlySet<FreshCause> = new Set([
  'escalation',
  'deliver',
  'fix',
  'review',
  'recheck',
  'handoff',
  'stage',
]);

/** Эскалация доставки — повод нового разговора доставки, пока свежа. */
const ESCALATION_FRESH_MS = EVENT_HOLD_MS;

/**
 * Почему панель начала новый разговор группы — по ключу прогона (их заводят
 * `deliver-stage`, `split-review`, `recheck-session`, `ChatHandoff`). Ключ —
 * id прежней сессии, а не `new-…`: продолжение того же разговора пошло новым по
 * вводной (`cold-continuation`) — повод не нужный, если кэш был тёплым.
 */
export function freshCause(input: {
  key: string;
  escalatedAt?: number;
  now: number;
  prevStage?: string;
  stage?: string;
}): FreshCause {
  const { key } = input;
  if (!key.startsWith('new-')) return 'cold-brief';
  if (/-deliver\d+$/.test(key)) {
    const escalated =
      input.escalatedAt !== undefined && input.now - input.escalatedAt <= ESCALATION_FRESH_MS;
    return escalated ? 'escalation' : 'deliver';
  }
  if (/-fix\d+$/.test(key)) return 'fix';
  if (/-recheck\d+$/.test(key)) return 'recheck';
  if (/-witness$/.test(key)) return 'review';
  return input.prevStage && input.stage && input.prevStage !== input.stage ? 'stage' : 'handoff';
}

/**
 * R34: новый разговор поверх тёплого заново записал окно. Пересобрано — запись кэша
 * его первого хода, не больше окна прошлого разговора: сверх него — новая работа, а
 * не пересборка. Цена — как у R2: запись (часовой ×2, пятиминутный ×1.25) вместо
 * чтения (×0.1). Нужный повод — справка, лишний — внимание; тревогой не бывает.
 */
export const R34: Rule = (state, _node, ctx, now) => {
  const fresh = recent(state.freshRewrites, now).at(-1);
  if (!fresh) return undefined;
  const rebuilt = Math.min(fresh.prevCtx, fresh.write);
  if (!(rebuilt >= ctx.settings.freshRewriteTokens)) return undefined;
  const share1h = fresh.write > 0 ? fresh.write1h / fresh.write : 0;
  const lostTokens = rebuilt * share1h * (2 - 0.1) + rebuilt * (1 - share1h) * (1.25 - 0.1);
  const lost = (modelFactor(fresh.model) * lostTokens) / 1e6;
  return {
    ...(REQUIRED.has(fresh.cause) ? {} : { severity: 'warn' as const }),
    numbers: {
      writeK: Math.round(rebuilt / 1000),
      prevK: Math.round(fresh.prevCtx / 1000),
      lostW: Math.round(lost * 100) / 100,
    },
    params: { cause: fresh.cause },
    since: fresh.at,
  };
};

/** Переделка закоммиченного новым разговором группы (R35): когда и какой файл. */
export interface RedoPoint {
  at: number;
  /** Путь для сравнения; `shown` — как его назвал вызов, в строку сигнала. */
  path: string;
  shown: string;
}

/**
 * R35: новый разговор группы снова вносит правки, уже закоммиченные на этой стадии
 * другим её разговором. Сигнал — с `redoFiles` разных файлов: один файл бывает и
 * законной доводкой. Держится как правило-событие от последнего повтора.
 */
export function groupRedo(
  points: readonly RedoPoint[],
  settings: GroupWatch,
  now: number,
): RuleHit | undefined {
  const fresh = recent(points, now);
  const paths = [...new Set(fresh.map((point) => point.path))];
  if (paths.length < settings.redoFiles) return undefined;
  const first = fresh[0];
  if (!first) return undefined;
  return {
    rule: 'R35',
    severity: GROUP_WATCH_SEVERITY.R35,
    numbers: { files: paths.length },
    params: { path: shortPath(first.shown) },
    since: first.at,
  };
}

/** Хвост пути в строку сигнала: два последних сегмента. */
function shortPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

/** Пауза гасит процесс CLI не сразу; свой сервер, живой дольше этого, пережил паузу. */
export const ORPHAN_AFTER_MS = 2 * 60_000;

/**
 * R36: группа на паузе, а порт, который подняла её сессия (`--port N`, `PORT=N`), ещё
 * слушает: сервер разработки или фоновый процесс пережил остановку. Видны только
 * порты, названные в команде, — сервер на порту по умолчанию сторож не знает.
 */
export function orphanPorts(
  state: WatchState,
  node: WatchNode,
  ctx: WatchContext,
  now: number,
): RuleHit | undefined {
  const pausedAt = node.pausedAt;
  if (!node.paused || pausedAt === undefined || !ctx.portAlive) return undefined;
  if (now - pausedAt < ORPHAN_AFTER_MS) return undefined;
  const alive = state.ownPorts.filter((port) => ctx.portAlive?.(port) === true);
  if (alive.length === 0) return undefined;
  return {
    rule: 'R36',
    severity: GROUP_WATCH_SEVERITY.R36,
    // Без «минут с паузы»: число росло бы каждый тик и переписывало сигнал на диске.
    numbers: { ports: alive.length },
    params: { port: alive.join(', ') },
    since: pausedAt + ORPHAN_AFTER_MS,
  };
}
