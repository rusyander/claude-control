import type { RouteDecisionRecord } from '@agentdeck/contracts/core/routes';
import {
  clearWaitDead,
  dropWait,
  markWaitDead,
  markWaitPoint,
  leasePlace,
  readWait,
  sameOwner,
  waitOwnedBy,
  waitPointTold,
  type WaitOwner,
} from '../lease-state.ts';
import { decideSlotWait } from '../slot-wait.ts';
import type { OwnContext } from './context.ts';
import { followLease } from './foreign.ts';
import { withOwnLock } from './lock.ts';
import {
  kindOf,
  NO_HOLD,
  waiterLabel,
  type LiveWaiter,
  type LivenessRead,
  type Pending,
} from './types.ts';

/**
 * Непрояснённые держатели после перезапуска (11 R:PR-04, F09): перепроверка по таймеру, окно
 * повторной выдачи места ждущего упавшего ядра (от первой смерти владельца — запись на диске),
 * срок повторов живости «неизвестно» и точка человека ждущим за застрявшим держателем. Место
 * живого чужого ядра не снимается ни в каком возрасте (F-88): дольше срока — точка человека.
 */
export interface OwnWaiters {
  /** Точка человека от застрявшего держателя — ждущему `only` (или всем за ним) один раз. */
  raise(item: Pending, only?: LiveWaiter): Promise<void>;
  /** Факт о владельце места — на диск; ответ — время первой смерти. */
  noteOwner(
    taskId: string,
    owner: WaitOwner | undefined,
    state: LivenessRead['live'],
  ): number | undefined;
  startTimer(): void;
  /**
   * Таймер остановлен и идущая перепроверка дошла до конца. Принятие аренды умершего владельца
   * идёт внутри перепроверки (запись себя владельцем → `held`): остановка ядра, не дождавшаяся
   * её, вернула бы «утечек нет», а принятая следом аренда с живым сервером осталась бы никем не
   * освобождённой (полный прогон 29.10, own.foreign-lease: `verified` пуст, сервер жив).
   */
  stop(): Promise<void>;
}

export function createWaiters(ctx: OwnContext): OwnWaiters {
  const { options, slotKey, pending, held, live, reissueWindowMs, retryUntilMs } = ctx;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Идущая перепроверка: такт во время неё не начинает вторую, остановка ждёт её конца. */
  let checking: Promise<void> | undefined;

  /** Место ждущего, как его знает очередь: слот, задача, владелец. */
  const placeOf = (item: Pending) => ({
    slotKey,
    taskId: item.taskId ?? '',
    ...(item.owner ? { owner: item.owner } : {}),
  });

  /** Решение о держателе — тем ждущим этого ядра, что стоят за ним (и журналу ядра, если есть). */
  async function tell(rec: RouteDecisionRecord, rank: number, to?: LiveWaiter): Promise<void> {
    const targets = to ? [to] : [...live].filter((waiter) => waiter.rank > rank);
    for (const waiter of targets) await waiter.record.decision(rec);
    if (!to && options.journal) await options.journal.decision(rec);
  }

  /**
   * Точка человека ждущему за застрявшим держателем. О месте ждущего — одна на (место, владелец,
   * ждущая задача) по записи на диске (F-88): ни следующий такт, ни перезапуск этого ядра, ни
   * вторая дорога точки («неизвестно» → жив) её не повторяют.
   */
  async function raise(item: Pending, only?: LiveWaiter): Promise<void> {
    const stuck = item.stuck;
    if (!stuck) return;
    const place =
      item.subject === 'waiter'
        ? placeOf(item)
        : item.subject === 'lease'
          ? leasePlace(slotKey, item.leaseId ?? '', item.owner)
          : undefined;
    for (const waiter of only ? [only] : [...live]) {
      if (waiter.rank <= item.rank || item.told.has(waiter)) continue;
      item.told.add(waiter);
      if (place && waitPointTold(options.workRoot, place, waiter.taskId)) continue;
      await tell(
        {
          class: 'slot-wait',
          facts: [{ readClass: 'process.alive', kind: kindOf(stuck.live) }],
          numbers: {
            elapsedMs: stuck.elapsedMs,
            retryUntilMs,
            ...(item.subject === 'waiter' ? { rank: item.rank } : {}),
          },
          reasons: [...stuck.decision.reasons, `${waiter.taskId} waits behind ${item.label}`],
          output: {
            subject: item.subject,
            action: stuck.decision.action,
            label: item.label,
            ...(item.subject === 'waiter'
              ? { place: { slotKey, taskId: item.taskId, rank: item.rank } }
              : {}),
            ...(item.subject === 'lease' ? { lease: { slotKey, leaseId: item.leaseId } } : {}),
            ...(place && item.owner ? { owner: item.owner } : {}),
          },
          humanPoint: { subject: item.label, reason: stuck.reason, readClass: 'process.alive' },
        },
        item.rank,
        waiter,
      );
      if (place) markWaitPoint(options.workRoot, place, waiter.taskId);
    }
  }

  /**
   * Факт о ядре-владельце места — на диск. Смерть (или владелец не записан) начинает окно
   * повторной выдачи одно на все ядра: ответ — время первого такого факта. Жизнь по личности
   * опровергает прежний «мёртв» (pid с тем же стартом не воскресает — ошибся тот, кто прочитал),
   * счёт снимается: снять место живого ядра хуже, чем ждать лишнее окно. «Неизвестно» не пишет.
   */
  function noteOwner(
    taskId: string,
    owner: WaitOwner | undefined,
    state: LivenessRead['live'],
  ): number | undefined {
    if (state === 'alive') clearWaitDead(options.workRoot, slotKey, taskId);
    if (state !== 'dead' && state !== 'absent') return undefined;
    const place = { slotKey, taskId, ...(owner ? { owner } : {}) };
    // Место уже выдано заново другому ядру (или снято): смерть прежнего владельца к нему не относится.
    if (!waitOwnedBy(options.workRoot, place)) return undefined;
    return markWaitDead(options.workRoot, place, Date.now());
  }

  /**
   * Место на диске сейчас — правда для брони (F-88). Нет файла — его задача получила слот или
   * ушла, или место сняли: бронь больше не нужна (ложь). Выдано заново другому ядру — бронь та же
   * (ранг тот же), но судится новый владелец со своим сроком, точки о прежнем больше нет; выдано
   * этому ядру — его задача стоит в очереди сама (ложь). Нечитаемо — до следующего такта.
   */
  function follow(item: Pending): boolean {
    const now = readWait(options.workRoot, slotKey, item.taskId ?? '');
    if ('absent' in now) return false;
    if (!('value' in now)) return true;
    const owner = now.value.owner;
    if (sameOwner(owner, item.owner)) return true;
    if (owner && ctx.self && owner.pid === ctx.self.pid && owner.start === ctx.self.start)
      return false;
    if (owner) {
      item.owner = owner;
      item.identity = { pid: owner.pid, start: owner.start };
    } else {
      delete item.owner;
      delete item.identity;
    }
    delete item.settled;
    delete item.stuck;
    item.label = waiterLabel(slotKey, item.taskId ?? '', owner);
    item.since = Date.now();
    item.told = new Set();
    return true;
  }

  /** Почему точка: живое чужое ядро держит место — называется оно; иначе — причина «неизвестно». */
  function stuckReason(item: Pending, read: LivenessRead): string {
    if (read.live !== 'alive') return read.reason ?? 'unknown';
    const what = item.subject === 'lease' ? 'lease' : 'place';
    return item.owner
      ? `core pid ${item.owner.pid} start ${item.owner.start} boot ${item.owner.bootId} is alive and keeps its ${what}; no takeover`
      : `${item.label}: alive by identity, owner core not recorded; no takeover`;
  }

  /** Перечитать непрояснённое и исполнить решение; пусто — таймер останавливается. */
  function recheck(): Promise<void> {
    checking ??= recheckAll().finally(() => {
      checking = undefined;
      if (pending.size === 0) stopTimer();
    });
    return checking;
  }

  async function recheckAll(): Promise<void> {
    for (const [key, item] of [...pending]) {
      if (!pending.has(key)) continue;
      if (item.subject === 'server' && !held.has(item.leaseId ?? '')) {
        pending.delete(key);
        continue;
      }
      if (item.subject === 'waiter' && !follow(item)) {
        pending.delete(key);
        item.reservation?.cancel();
        continue;
      }
      // Чужая аренда ушла (слот за ней отпущен) — держать нечего.
      if (item.subject === 'lease' && !followLease(ctx, item)) {
        pending.delete(key);
        continue;
      }
      const read: LivenessRead = item.settled
        ? { live: item.settled }
        : await ctx.liveness(item.identity);
      // Задача места вернулась к этому ядру, пока читалась живость: место уже её.
      if (!pending.has(key)) continue;
      // Счёт окна — с диска на каждой перепроверке: запись общая для всех ядер (другое ядро
      // могло её снять — прочитало владельца живым, — или выдать место заново).
      const deadSince =
        item.subject === 'waiter' ? noteOwner(item.taskId ?? '', item.owner, read.live) : undefined;
      // Окно ждущего — от первой смерти владельца (запись на диске), иначе — от возврата / новой выдачи.
      const elapsedMs = Date.now() - (deadSince ?? item.since);
      const decision = decideSlotWait({
        subject: item.subject,
        liveness: read.live,
        elapsedMs,
        reissueWindowMs,
        retryUntilMs,
      });
      if (read.live === 'dead' || read.live === 'absent') item.settled = read.live;
      if (decision.action === 'human-point') {
        item.stuck = { reason: stuckReason(item, read), decision, elapsedMs, live: read.live };
        await raise(item);
        continue;
      }
      // Точка больше не про этого держателя: пришедшие позже её не получат.
      delete item.stuck;
      if (decision.action === 'retry') continue;
      if (item.subject === 'lease') {
        // Владелец умер: аренда принимается под замком; не вышло — следующий такт.
        if (decision.action === 'adopt' && (await ctx.adoptForeign?.(item))) pending.delete(key);
        continue;
      }
      if (item.subject === 'server') {
        pending.delete(key);
        const entry = held.get(item.leaseId ?? '');
        // Мёртв по личности — слот свободен; аренда остаётся для своего освобождения.
        if (decision.action === 'release' && entry) {
          entry.hold.release();
          entry.hold = NO_HOLD(entry.hold.key);
          entry.slotReturned = `slot returned on recheck: model server ${read.live} by identity`;
        }
        continue;
      }
      // Место живого чужого ядра (и окно мёртвого) держится: бронь не снимается.
      if (decision.action !== 'release') continue;
      const place = placeOf(item);
      // Проверка владельца и снятие — под замком каталога: другое ядро не выдаст место себе между
      // ними; выдало раньше (или задача вернулась к этому ядру) — следующий такт это увидит.
      const reaped = await withOwnLock(ctx, () => {
        if (!pending.has(key) || !waitOwnedBy(options.workRoot, place)) return false;
        // Не вернулся за окно, ядро-владелец мертво: место снимается и называется в журнале.
        dropWait(options.workRoot, slotKey, item.taskId ?? '');
        return true;
      });
      if (!reaped.done || !reaped.value || !pending.has(key)) continue;
      pending.delete(key);
      item.reservation?.cancel();
      await tell(
        {
          class: 'slot-wait',
          facts: [{ readClass: 'process.alive', kind: kindOf(read.live) }],
          numbers: { rank: item.rank, elapsedMs, reissueWindowMs },
          reasons: [...decision.reasons, item.label],
          output: { subject: 'waiter', action: decision.action, taskId: item.taskId },
        },
        item.rank,
      );
    }
  }

  function startTimer(): void {
    if (timer || pending.size === 0) return;
    timer = setInterval(() => void recheck().catch(() => undefined), ctx.recheckMs);
    timer.unref?.();
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  async function stop(): Promise<void> {
    stopTimer();
    while (checking) await checking.catch(() => undefined);
    // Идущая перепроверка могла завести таймер заново (принятая аренда с «неизвестно»).
    stopTimer();
  }

  return { raise, noteOwner, startTimer, stop };
}
