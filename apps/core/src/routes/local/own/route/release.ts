import type { ReleaseOutcome, RouteLease, RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { GpuMemory } from '../../../../platform/gpu.ts';
import { sleep } from '../../../../platform/os-kind.ts';
import { pathExists } from '../../../../platform/safe-io/files.ts';
import { removeVerified } from '../../../../platform/safe-io/remove.ts';
import { serverRef } from '../lease-state.ts';
import type { TreeStopReport } from '../../../../platform/tree-stop.ts';
import { stopRouter, stopStarted } from '../server.ts';
import type { OwnContext } from './context.ts';
import { gib, type Held } from './types.ts';
import type { OwnWaiters } from './waiters.ts';

/**
 * Освобождение аренды `local:own` в обратном порядке заведения: выгрузка → сервер говорит
 * «моделей нет» → остановка ДЕРЕВА → память карты прочитана обратно до исходной ± допуск →
 * `resource.verified`, иначе `resource.leak`. Чужая аренда (не держится или ссылка сервера не та)
 * ничего не останавливает — только называется. `shutdown` — то же для всех держимых.
 *
 * Слот уходит следующему только когда сервер доказанно остановлен (или его не было): остаток
 * дерева или непрочитанная таблица держат слот, запись аренды и её каталог (F-66) — иначе второй
 * сервер встал бы рядом с живым первым, а перезапущенное ядро не нашло бы первый. Бросок
 * посреди протокола не оставляет слот занятым навсегда (F-63): освобождается тем же правилом.
 */
export interface OwnRelease {
  releaseLease(lease: RouteLease, record: RouteRecorder): Promise<ReleaseOutcome>;
  shutdown(record: RouteRecorder): Promise<ReleaseOutcome>;
}

const usedOf = (memory: GpuMemory): number =>
  memory.devices.reduce((sum, device) => sum + device.usedBytes, 0);

/** Карты, где занятое выше своей базы сверх допуска (сирота одной карты не прячется за другой). */
function overDevices(
  memory: GpuMemory,
  devices: Record<string, number> | undefined,
  tolerance: number,
): string[] {
  if (!devices) return [];
  return memory.devices
    .filter((device) => device.usedBytes > (devices[device.id] ?? 0) + tolerance)
    .map(
      (device) =>
        `device ${device.id} used ${gib(device.usedBytes)} vs baseline ${gib(devices[device.id] ?? 0)}`,
    );
}

export function createRelease(
  ctx: OwnContext,
  ensureRestored: () => Promise<void>,
  waiters: OwnWaiters,
): OwnRelease {
  const { options, id, held, pending, tolerance, slots } = ctx;

  async function verifyVram(
    vram: NonNullable<Held['vram']>,
  ): Promise<{ ok: boolean; text: string }> {
    const baseline = vram.baselineUsedBytes;
    if (baseline === undefined)
      return { ok: false, text: 'vram read-back impossible: no baseline before load' };
    const deadline = Date.now() + (options.settleMs ?? 10_000);
    let last: string;
    for (;;) {
      const fact = await ctx.readGpu();
      if ('value' in fact) {
        const used = usedOf(fact.value);
        const over = overDevices(fact.value, vram.baselineDevices, tolerance);
        last = `used ${gib(used)} vs baseline ${gib(baseline)} ± ${gib(tolerance)} (${fact.value.source})${over.length > 0 ? `; ${over.join('; ')}` : ''}`;
        if (used <= baseline + tolerance && over.length === 0)
          return { ok: true, text: `vram back: ${last}` };
      } else last = `gpu memory unread: ${'unknown' in fact ? fact.unknown : 'absent'}`;
      if (Date.now() >= deadline) return { ok: false, text: `vram not back: ${last}` };
      await sleep(250);
    }
  }

  /** Аренда, которую маршрут держит И чья ссылка сервера совпадает с записью (не чужая). */
  function ownEntry(lease: RouteLease): Held | undefined {
    const entry = held.get(lease.leaseId);
    if (!entry) return undefined;
    const ref = lease.resources.find((r) => r.kind === 'model-server')?.ref;
    if (ref && (!entry.router || ref !== serverRef(entry.router.identity, entry.router.origin)))
      return undefined;
    return entry;
  }

  /** Сверка памяти карты для слота; слот отдан раньше и занят другим — память уже не наша. */
  async function slotFact(entry: Held): Promise<{ ok: boolean; text: string }> {
    // Память карты сверяется только если загрузка была; отказ подбора ничего не грузил.
    if (!entry.vram || !entry.router)
      return { ok: true, text: 'slot returned: nothing was loaded' };
    // Слот ушёл при возврате (сервер мёртв по личности), и его держит другая аренда: память
    // карты теперь её модели — сравнение с базой этой аренды назвало бы чужую модель утечкой.
    if (entry.slotReturned && slots.held(entry.hold.key))
      return {
        ok: true,
        text: `${entry.slotReturned}; vram read-back not attributable: slot ${entry.hold.key} now held by another lease`,
      };
    return verifyVram(entry.vram);
  }

  async function releaseLease(lease: RouteLease, record: RouteRecorder): Promise<ReleaseOutcome> {
    const outcome: ReleaseOutcome = { verified: [], leaks: [] };
    const ok = async (rid: string, fact: string): Promise<void> => {
      await record.verified(rid, fact);
      outcome.verified.push({ rid, fact });
    };
    const leak = async (rid: string, reason: string): Promise<void> => {
      await record.leak(rid, reason);
      outcome.leaks.push({ rid, reason });
    };
    if (!held.has(lease.leaseId)) await ensureRestored();
    const entry = ownEntry(lease);
    if (!entry) {
      // Не наша (или ссылка не та): ничего не останавливается — только называется.
      for (const resource of lease.resources)
        await leak(resource.rid, `lease ${lease.leaseId} is not held by ${id} (core restarted?)`);
      return outcome;
    }
    // Сервер есть, пока его остановка не доказана; остался — что именно (F-66).
    let serverUp = entry.router !== undefined || entry.startLeft !== undefined;
    let serverLeft: string | undefined;
    const stopServer = async (
      rid: string,
      stop: () => Promise<TreeStopReport> = () => stopRouter(entry.router!),
    ): Promise<void> => {
      const report = await stop();
      if (report.residual.length === 0 && !report.unknown) {
        serverUp = false;
        await ok(
          rid,
          `tree stopped: ${report.targeted.length} processes (${report.sweepFound.length} by marker), none alive`,
        );
        return;
      }
      serverLeft = `tree residual: ${report.residual.map((p) => p.pid).join(', ') || '-'}${report.unknown ? `; ${report.unknown}` : ''}`;
      await leak(rid, serverLeft);
    };
    const kept = (what: string): string =>
      `${what} kept: model server not proven stopped (${serverLeft ?? 'release interrupted'})`;
    try {
      // Запуск не поднялся, а его дерево не снято доказанно (F-64): снять ещё раз под его меткой.
      const left = entry.startLeft;
      if (left) {
        await stopServer(left.rid, () => stopStarted(left.root, left.rid, left.since));
        if (!serverUp) delete entry.startLeft;
      }
      // Сервер записан, а в журнал не попал (ядро упало между ними): тоже наш, его rid — метка.
      if (entry.router && !lease.resources.some((r) => r.kind === 'model-server'))
        await stopServer(entry.router.marker);
      for (const resource of [...lease.resources].reverse()) {
        if (resource.kind === 'model-load') {
          try {
            // Аренда своей модели без имени модели не выдаётся (`requireModel`); такая строка — порча.
            if (lease.model === null) throw new Error(`lease ${lease.leaseId} names no model`);
            const list = await entry.router!.client.unload(
              lease.model,
              options.unloadTimeoutMs ?? 60_000,
            );
            await ok(resource.rid, `server lists no loaded model (${list.length} listed)`);
          } catch (error) {
            await leak(resource.rid, `unload unproven: ${(error as Error).message}`);
          }
        } else if (resource.kind === 'model-server') {
          await stopServer(resource.rid);
        } else if (resource.kind === 'tmpdir') {
          // Запись аренды — единственный след живого сервера для следующего ядра: остаётся.
          if (serverUp) {
            await leak(resource.rid, kept('lease dir'));
            continue;
          }
          const removed = removeVerified(resource.ref);
          if (removed.removed && !pathExists(resource.ref))
            await ok(resource.rid, 'lease dir removed');
          else
            await leak(resource.rid, removed.removed ? 'lease dir still present' : removed.reason);
        } else if (resource.kind === 'model-slot') {
          if (serverUp) {
            await leak(resource.rid, kept(`slot ${entry.hold.key}`));
            continue;
          }
          const fact = await slotFact(entry);
          if (fact.ok) await ok(resource.rid, fact.text);
          else await leak(resource.rid, fact.text);
        }
      }
    } finally {
      // Слот и запись уходят только за доказанно остановленным сервером; иначе аренда остаётся
      // держимой — повторное освобождение (или shutdown) пройдёт протокол ещё раз.
      if (!serverUp) {
        entry.hold.release();
        held.delete(lease.leaseId);
      }
    }
    return outcome;
  }

  async function shutdown(record: RouteRecorder): Promise<ReleaseOutcome> {
    await ensureRestored();
    // Места ждущих прошлых ядер снимаются только в памяти: файлы остаются следующему ядру.
    // Идущая перепроверка (принятие аренды умершего владельца) доходит до конца прежде, чем
    // держимое перечислено: принятое ею освобождается этой же остановкой.
    await waiters.stop();
    for (const item of pending.values()) item.reservation?.cancel();
    pending.clear();
    // Аренды живых чужих ядер — их (F-88): отпускается только слот за ними, сервер и файлы — нет.
    for (const entry of ctx.foreign.values()) entry.hold.release();
    ctx.foreign.clear();
    const total: ReleaseOutcome = { verified: [], leaks: [] };
    for (const entry of [...held.values()]) {
      const one = await releaseLease(entry.lease, record);
      total.verified.push(...one.verified);
      total.leaks.push(...one.leaks);
    }
    return total;
  }

  return { releaseLease, shutdown };
}
