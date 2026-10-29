import type { RouteDecisionRecord } from '@agentdeck/contracts/core/routes';
import type { ProcessIdentity } from '../../../../platform/process-identity.ts';
import {
  leaseDirs,
  readLeaseState,
  readWaits,
  serverRef,
  sweepLeasePoints,
  type OwnLeaseState,
} from '../lease-state.ts';
import type { SlotHold } from '../slot.ts';
import { decideSlotWait } from '../slot-wait.ts';
import { attachRouter, stopLeftover } from '../server.ts';
import { UNPROVEN_START, type OwnContext } from './context.ts';
import { claimOf, dropForeign, holderOf, leaseLabel, takeOver } from './foreign.ts';
import { NO_HOLD, waiterLabel } from './types.ts';
import type { OwnWaiters } from './waiters.ts';

/**
 * Вернуть аренды прошлого ядра — один раз, до первой выдачи слота. Сервер жив по личности —
 * слот занят им; мёртв — слот свободен, а аренда остаётся, чтобы её освобождение убрало
 * каталог и сверило память; «неизвестно» держит слот: выдать его второму хуже, чем подождать.
 * Места ждущих других ядер встают в очередь по своему рангу; место живого ядра-владельца — чужое:
 * держится в очереди и не снимается (F-88). Аренда принимается, только если она этого процесса или
 * её владелец мёртв (запись прежнего вида — мёртв её сервер); аренда живого или непрояснённого
 * чужого ядра — его: слот держится за ней, сервер не трогается (`foreign.ts`).
 *
 * Слот принимается без ожидания (F-67): ждать освобождения, которое делает только release этого
 * же маршрута, а он сам ждёт возврата, — вечное зависание. Два сервера на одном слоте — факт
 * мира, не очередь: оба держат слот, решение с точкой человека уходит в журнал ядра. Сбой
 * возврата не запоминается навсегда (F-116): следующий вызов повторяет его, пропуская уже
 * возвращённое.
 */
export function createRestore(ctx: OwnContext, waiters: OwnWaiters): () => Promise<void> {
  const { options, id, slots, slotKey, held, pending, reissueWindowMs, retryUntilMs } = ctx;
  const { liveness } = ctx;
  const { noteOwner } = waiters;
  let restored: Promise<void> | undefined;

  /** Второй живой (или непрояснённый) сервер на уже занятом слоте — человеку, не молча. */
  async function conflict(slot: string, labels: string[]): Promise<void> {
    const rec: RouteDecisionRecord = {
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'value' }],
      numbers: { servers: labels.length },
      reasons: [
        `${labels.length} model servers of a previous core hold slot ${slot}: ${labels.join('; ')}`,
        'all kept: stopping one is a human call; the slot frees only after every one is released',
      ],
      output: { subject: 'server', action: 'human-point', slotKey: slot },
      humanPoint: {
        subject: `slot ${slot}: ${labels.join('; ')}`,
        reason: 'more than one model server on one card after a core restart',
        readClass: 'process.alive',
      },
    };
    if (options.journal) await options.journal.decision(rec);
  }

  /**
   * Остаток неудачного запуска прошлого ядра (F-64): снять его под меткой. Снят доказанно —
   * слот свободен, аренда остаётся для уборки каталога; иначе слот занят им, точка человека.
   */
  async function restoreLeftover(state: OwnLeaseState, workDir: string): Promise<void> {
    const start = state.startLeft;
    if (!start) return;
    const left = await stopLeftover(start.root, start.rid);
    const label = `failed model server start ${start.rid} (lease ${state.leaseId})`;
    held.set(state.leaseId, {
      lease: {
        leaseId: state.leaseId,
        routeId: id,
        model: state.model,
        resources: state.resources,
      },
      hold: left ? slots.adopt(state.slotKey) : NO_HOLD(state.slotKey),
      ...(left ? { startLeft: { ...start, text: left } } : {}),
      dialect: state.dialect,
      workDir,
    });
    if (!left || !options.journal) return;
    await options.journal.decision({
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'value' }],
      numbers: typeof start.root === 'number' ? { pid: start.root } : { pid: start.root.pid },
      reasons: [
        `${label}: not proven stopped after a core restart (${left})`,
        `slot ${state.slotKey} stays held: a second model must not load beside it`,
      ],
      output: { subject: 'server', action: 'human-point', slotKey: state.slotKey },
      humanPoint: { subject: label, reason: left, readClass: 'process.alive' },
    });
  }

  /**
   * Аренда живого (или непрояснённого) чужого ядра (F-88): слот держится за ней, сервер — его.
   * Следит перепроверка (`foreign.ts`): каталог ушёл — слот отпущен; владелец умер — принятие.
   */
  function holdForeign(state: OwnLeaseState, workDir: string, identity?: ProcessIdentity): string {
    const label = leaseLabel(state);
    ctx.foreign.set(state.leaseId, { hold: slots.adopt(state.slotKey), workDir });
    const holder = identity ?? holderOf(state);
    pending.set(`lease:${state.leaseId}`, {
      subject: 'lease',
      ...(holder ? { identity: holder } : {}),
      ...(state.owner ? { owner: state.owner } : {}),
      label,
      rank: Number.NEGATIVE_INFINITY,
      leaseId: state.leaseId,
      workDir,
      since: ctx.restoredAt,
      told: new Set(),
    });
    waiters.startTimer();
    return label;
  }

  /**
   * Чья аренда: своя (этот процесс) — принимается; владелец мёртв (у записи прежнего вида —
   * доказанно мёртв её сервер) — принимается под замком с записью себя владельцем; иначе чужая.
   */
  async function claimLease(state: OwnLeaseState, workDir: string): Promise<string | undefined> {
    const claim = await claimOf(ctx, state);
    if (claim.kind === 'foreign') return holdForeign(state, workDir, claim.identity);
    if (claim.kind === 'mine') return adoptLease(state, workDir);
    const taken = await takeOver(ctx, workDir, state.owner);
    if ('state' in taken) return adoptLease(taken.state, workDir);
    // Другое ядро приняло её раньше (или замок не дался) — судится перепроверкой, руки прочь.
    return taken.skip === 'gone' ? undefined : holdForeign(state, workDir);
  }

  ctx.adoptForeign = async (item) => {
    const leaseId = item.leaseId ?? '';
    const taken = await takeOver(ctx, item.workDir ?? '', item.owner);
    if (!('state' in taken)) {
      if (taken.skip !== 'gone') return false;
      dropForeign(ctx, leaseId);
      return true;
    }
    // Слот принятой аренды берётся до отпускания чужого: между ними он не свободен ни мига.
    await adoptLease(taken.state, item.workDir ?? '');
    dropForeign(ctx, leaseId);
    return true;
  };

  async function restoreLeases(): Promise<void> {
    const adopted = new Map<string, string[]>();
    for (const workDir of leaseDirs(options.workRoot)) {
      const state = readLeaseState(workDir);
      if (!state || state.routeId !== id) continue;
      if (held.has(state.leaseId) || ctx.foreign.has(state.leaseId)) continue;
      const label = await claimLease(state, workDir);
      if (label) adopted.set(state.slotKey, [...(adopted.get(state.slotKey) ?? []), label]);
    }
    sweepLeasePoints(options.workRoot);
    for (const [slot, labels] of adopted) if (labels.length > 1) await conflict(slot, labels);
  }

  /** Принять аренду: ответ — как она названа, если держит слот (для конфликта двух серверов). */
  async function adoptLease(state: OwnLeaseState, workDir: string): Promise<string | undefined> {
    if (state.startLeft && !state.server) {
      await restoreLeftover(state, workDir);
      return undefined;
    }
    const read = state.server ? await liveness(state.server.identity) : { live: 'dead' as const };
    const decision = decideSlotWait({
      subject: 'server',
      liveness: read.live,
      elapsedMs: 0,
      reissueWindowMs,
      retryUntilMs,
    });
    const released = decision.action === 'release';
    const hold: SlotHold = released ? NO_HOLD(state.slotKey) : slots.adopt(state.slotKey);
    const label = state.server
      ? `model server ${serverRef(state.server.identity, state.server.origin)} (lease ${state.leaseId})`
      : `lease ${state.leaseId}`;
    held.set(state.leaseId, {
      lease: {
        leaseId: state.leaseId,
        routeId: id,
        model: state.model,
        resources: state.resources,
      },
      hold,
      ...(state.server
        ? {
            router: attachRouter(state.server),
            vram: {
              baselineUsedBytes: state.baselineUsedBytes,
              ...(state.baselineDevices ? { baselineDevices: state.baselineDevices } : {}),
            },
          }
        : {}),
      ...(released && state.server
        ? { slotReturned: `slot returned at restore: model server ${read.live} by identity` }
        : {}),
      dialect: state.dialect,
      workDir,
    });
    // «Неизвестно» перечитывается; срок уже вышел (`livenessRetryMs` 0) — точка человека на
    // первой перепроверке, а не молчаливое вечное держание слота (F-116).
    if (read.live === 'unknown' && state.server) {
      pending.set(`server:${state.leaseId}`, {
        subject: 'server',
        identity: state.server.identity,
        label,
        rank: Number.NEGATIVE_INFINITY,
        leaseId: state.leaseId,
        since: ctx.restoredAt,
        told: new Set(),
      });
      // Таймер — с первым непрояснённым, не после всего цикла (F-67).
      waiters.startTimer();
    }
    return released ? undefined : label;
  }

  async function restoreWaits(self: { pid: number; start: string }): Promise<void> {
    // Места ждущих других ядер — по порядку мест: свободный слот достаётся первому из них. Место
    // живого чужого ядра тоже встаёт в очередь (F-88): наши задачи ждут за ним, а не обгоняют его.
    const places = readWaits(options.workRoot, slotKey).sort((a, b) => a.rank - b.rank);
    for (const place of places) {
      const owner = place.owner;
      if (owner && owner.pid === self.pid && owner.start === self.start) continue;
      // Повтор после сбоя: место уже стоит в очереди.
      if (pending.has(`waiter:${place.taskId}`)) continue;
      const identity = owner ? { pid: owner.pid, start: owner.start } : undefined;
      const read = await liveness(identity);
      // Факт — на диск сразу (первая перепроверка прочитает время назад).
      noteOwner(place.taskId, owner, read.live);
      pending.set(`waiter:${place.taskId}`, {
        subject: 'waiter',
        ...(identity ? { identity } : {}),
        ...(owner ? { owner } : {}),
        ...(read.live === 'dead' || read.live === 'absent' ? { settled: read.live } : {}),
        label: waiterLabel(slotKey, place.taskId, owner),
        rank: place.rank,
        taskId: place.taskId,
        reservation: slots.reserve(slotKey, place.rank),
        since: ctx.restoredAt,
        told: new Set(),
      });
      waiters.startTimer();
    }
  }

  async function restore(): Promise<void> {
    ctx.restoredAt ||= Date.now();
    if (!ctx.self) {
      const me = await ctx.probe.identityOf(process.pid);
      ctx.self = {
        pid: process.pid,
        // Снимок о самом себе не ответил: старт недоказан, другие ядра читают его по номеру.
        start: 'value' in me ? me.value.start : `${UNPROVEN_START}${ctx.restoredAt}`,
        bootId: ctx.bootId,
      };
    }
    await restoreLeases();
    await restoreWaits(ctx.self);
  }

  return function ensureRestored(): Promise<void> {
    restored ??= restore().catch((error: unknown) => {
      // Сбой не мемоизируется: следующая выдача или освобождение повторят возврат.
      restored = undefined;
      throw error;
    });
    return restored;
  };
}
