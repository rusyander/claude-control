import type { ProcessIdentity } from '../../../../platform/process-identity.ts';
import { pathExists } from '../../../../platform/safe-io/files.ts';
import {
  dropLeasePoints,
  readLeaseState,
  sameOwner,
  serverRef,
  writeLeaseState,
  type OwnLeaseState,
  type WaitOwner,
} from '../lease-state.ts';
import { UNPROVEN_START, type OwnContext } from './context.ts';
import { withOwnLock } from './lock.ts';
import type { Pending } from './types.ts';

/**
 * Аренда другого ядра на диске (F-88): живое (или непрояснённое) ядро-владелец держит её само —
 * этот маршрут её сервер не принимает, не освобождает и не останавливает, только держит слот за
 * ней (вторая модель рядом не встанет) и следит: каталог ушёл — слот отпущен; владелец умер —
 * аренда принимается обычным путём, под замком каталога. Запись прежнего вида (владелец не
 * записан) принимается, только если её сервер (или остаток запуска) доказанно мёртв по личности:
 * иначе живое ядро могло её держать — руки прочь.
 */

export type LeaseClaim =
  | { kind: 'mine' }
  | { kind: 'free'; reason: string }
  | { kind: 'foreign'; identity: ProcessIdentity; live: 'alive' | 'unknown'; reason?: string };

const sameProcess = (a: WaitOwner, b: WaitOwner | undefined): boolean =>
  b !== undefined && a.pid === b.pid && a.start === b.start;

/** По чьей личности судится аренда: ядро-владелец; у записи прежнего вида — её сервер. */
export function holderOf(state: OwnLeaseState): ProcessIdentity | undefined {
  if (state.owner) return { pid: state.owner.pid, start: state.owner.start };
  if (state.server) return state.server.identity;
  const root = state.startLeft?.root;
  if (root === undefined) return undefined;
  // Корень остатка без старта: живой номер — «неизвестно», нет номера — мёртв.
  return typeof root === 'number' ? { pid: root, start: `${UNPROVEN_START}legacy` } : root;
}

/** Как чужая аренда названа в точке человека: аренда, слот, ядро-владелец (или чем судится). */
export function leaseLabel(state: OwnLeaseState): string {
  const head = `lease ${state.leaseId} on slot ${state.slotKey}`;
  if (state.owner)
    return `${head} of core pid ${state.owner.pid} start ${state.owner.start} boot ${state.owner.bootId}`;
  const by = state.server
    ? `model server ${serverRef(state.server.identity, state.server.origin)}`
    : 'its start leftover';
  return `${head} (owner core not recorded; judged by ${by})`;
}

export async function claimOf(ctx: OwnContext, state: OwnLeaseState): Promise<LeaseClaim> {
  if (state.owner && sameProcess(state.owner, ctx.self)) return { kind: 'mine' };
  const identity = holderOf(state);
  if (!identity)
    return { kind: 'free', reason: 'owner not recorded; no model server or leftover to hold' };
  const read = await ctx.liveness(identity);
  if (read.live === 'alive' || read.live === 'unknown')
    return {
      kind: 'foreign',
      identity,
      live: read.live,
      ...(read.reason ? { reason: read.reason } : {}),
    };
  return {
    kind: 'free',
    reason: state.owner
      ? `lease owner core ${read.live} by identity`
      : `owner not recorded; its holder ${read.live} by identity`,
  };
}

export type TakeOver =
  { state: OwnLeaseState } | { skip: 'gone' | 'changed' | 'locked'; reason: string };

/**
 * Принять аренду мёртвого владельца: под замком запись перечитывается — владелец всё тот же, что
 * судился мёртвым (личность не воскресает), — пишется это ядро. Другое ядро успело раньше —
 * `changed`: его аренда судится заново, не перехватывается.
 */
export async function takeOver(
  ctx: OwnContext,
  workDir: string,
  judged: WaitOwner | undefined,
): Promise<TakeOver> {
  const self = ctx.self;
  if (!self) return { skip: 'locked', reason: 'this core not restored yet' };
  const locked = await withOwnLock(ctx, (): TakeOver => {
    const now = readLeaseState(workDir);
    if (!now) return { skip: 'gone', reason: `${workDir}: lease record gone` };
    if (!sameOwner(now.owner, judged))
      return { skip: 'changed', reason: `${workDir}: lease owner changed` };
    const next: OwnLeaseState = { ...now, owner: self };
    writeLeaseState(workDir, next);
    return { state: next };
  });
  return locked.done ? locked.value : { skip: 'locked', reason: locked.reason };
}

/** Слот за чужой арендой отпущен, точки о ней убраны (каталог ушёл или аренда принята). */
export function dropForeign(ctx: OwnContext, leaseId: string): void {
  const entry = ctx.foreign.get(leaseId);
  ctx.foreign.delete(leaseId);
  entry?.hold.release();
  dropLeasePoints(ctx.options.workRoot, ctx.slotKey, leaseId);
}

/**
 * Чужая аренда на диске сейчас — правда для слота. Каталога нет — ядро-владелец её освободило:
 * слот отпускается (ложь). Владелец сменился (другое ядро приняло её у мёртвого) — судится новый,
 * со своим сроком; точки о прежнем владельце больше не про неё. Нечитаемо — до следующего такта.
 */
export function followLease(ctx: OwnContext, item: Pending): boolean {
  const workDir = item.workDir ?? '';
  if (!pathExists(workDir)) {
    dropForeign(ctx, item.leaseId ?? '');
    return false;
  }
  const state = readLeaseState(workDir);
  if (!state || sameOwner(state.owner, item.owner)) return true;
  if (state.owner) item.owner = state.owner;
  else delete item.owner;
  const identity = holderOf(state);
  if (identity) item.identity = identity;
  else delete item.identity;
  delete item.settled;
  delete item.stuck;
  item.label = leaseLabel(state);
  item.since = Date.now();
  item.told = new Set();
  return true;
}
