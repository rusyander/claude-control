import { join } from 'node:path';
import type {
  RouteAcquireSpec,
  RouteLease,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { newId } from '../../../../lib/ids/uuidv7.ts';
import { ensureDir, pathExists } from '../../../../platform/safe-io/files.ts';
import {
  createResource,
  releaseOf,
  requireModel,
  RouteRefused,
  throwIfAborted,
} from '../../../lease.ts';
import { decideFit, pinDeviceEnv } from '../fit.ts';
import { dropWait, serverRef, waitRank, writeLeaseState } from '../lease-state.ts';
import type { SlotHold } from '../slot.ts';
import { startRouter } from '../server.ts';
import type { OwnContext } from './context.ts';
import { withOwnLock } from './lock.ts';
import type { OwnRelease } from './release.ts';
import { factKind, MIB, OWN_CAPS, type Held, type LiveWaiter } from './types.ts';
import type { OwnWaiters } from './waiters.ts';

/**
 * Выдача аренды `local:own`: слот карты (вернувшийся ждущий прошлого ядра — на своё место) →
 * память карты ДО загрузки → решение `fit` → каталог → сервер-маршрутизатор → загрузка. Запись
 * аренды на диск — на каждом шаге; сбой на полпути освобождает заведённое тем же протоколом.
 */
export function createAcquire(
  ctx: OwnContext,
  ensureRestored: () => Promise<void>,
  waiters: OwnWaiters,
  release: OwnRelease,
): (spec: RouteAcquireSpec, record: RouteRecorder) => Promise<RouteLease> {
  const { options, id, slots, slotKey, held, pending, live } = ctx;

  /**
   * Место ждущего пишется под замком каталога (F-88): другое ядро, снимающее место мёртвого
   * владельца, не впишется между своей проверкой владельца и удалением. Замок не дался за срок
   * (держатель жив или непрояснён) — место пишется без него: задача не падает из-за чужого замка.
   */
  async function placeRank(place: Parameters<typeof waitRank>[1]): Promise<number> {
    const locked = await withOwnLock(ctx, () => waitRank(options.workRoot, place, Date.now()));
    return locked.done ? locked.value : waitRank(options.workRoot, place, Date.now());
  }

  async function takeSlot(spec: RouteAcquireSpec, record: RouteRecorder): Promise<SlotHold> {
    await ensureRestored();
    const owner = ctx.self;
    if (!owner) throw new Error(`${id}: restore did not record this core`);
    const place = {
      slotKey,
      taskId: spec.taskId,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      owner,
    };
    // Вернулся ждущий прошлого ядра — на своё место (слот мог уже ждать его).
    const reserved = pending.get(`waiter:${spec.taskId}`);
    if (reserved?.reservation) pending.delete(`waiter:${spec.taskId}`);
    // Ждать придётся — место пишется файлом (или берётся записанное прошлым ядром). Держимое
    // место прошлого ядра всегда значит «слот занят» (им самим или теми, кто впереди).
    const rank = slots.held(slotKey) ? await placeRank(place) : undefined;
    const waiter: LiveWaiter | undefined =
      rank === undefined ? undefined : { taskId: spec.taskId, rank, record };
    if (waiter) {
      live.add(waiter);
      for (const item of [...pending.values()]) await waiters.raise(item, waiter);
    }
    try {
      return reserved?.reservation
        ? await reserved.reservation.claim(spec.signal)
        : await slots.acquire(slotKey, spec.signal, rank);
    } finally {
      if (waiter) live.delete(waiter);
      if (rank !== undefined) dropWait(options.workRoot, slotKey, spec.taskId);
    }
  }

  return async function acquire(
    spec: RouteAcquireSpec,
    record: RouteRecorder,
  ): Promise<RouteLease> {
    // Модель по умолчанию CLI своей модели не бывает: серверу нужно имя загружаемой модели.
    const asked = requireModel({ id, caps: OWN_CAPS }, spec);
    const model = options.models.find((item) => item.id === asked);
    if (!model) throw new RouteRefused('model_absent', `${asked} is not in the own model set`);
    // Та же проверка, что у `read.models()` (F-70): нет файла — нет модели, слот не занимается.
    if (!pathExists(model.path))
      throw new RouteRefused('model_absent', `${asked}: model file ${model.path} not found`);
    const releaseSpec = releaseOf(spec);
    const hold = await takeSlot(spec, record);
    const resources: RouteResource[] = [];
    const leaseId = newId();
    const lease: RouteLease = { leaseId, routeId: id, model: model.id, resources };
    // Запись держателя — сразу со слотом: любой сбой дальше освобождается тем же путём.
    const entry: Held = {
      lease,
      hold,
      dialect: spec.dialect ?? OWN_CAPS.dialects[0] ?? 'openai-chat',
      workDir: join(options.workRoot, leaseId),
    };
    held.set(leaseId, entry);
    const persist = (): void =>
      writeLeaseState(entry.workDir, {
        v: 1,
        leaseId,
        routeId: id,
        // Чья аренда (F-88): другое ядро, пока это живо, её сервер не тронет.
        ...(ctx.self ? { owner: ctx.self } : {}),
        model: model.id,
        dialect: entry.dialect,
        slotKey,
        resources,
        ...(entry.vram?.baselineUsedBytes === undefined
          ? {}
          : { baselineUsedBytes: entry.vram.baselineUsedBytes }),
        ...(entry.vram?.baselineDevices ? { baselineDevices: entry.vram.baselineDevices } : {}),
        ...(entry.router
          ? {
              server: {
                identity: entry.router.identity,
                origin: entry.router.origin,
                port: entry.router.port,
                marker: entry.router.marker,
              },
            }
          : {}),
        ...(entry.startLeft ? { startLeft: entry.startLeft } : {}),
      });
    try {
      resources.push(await createResource(record, 'model-slot', `slot:${slotKey}`, releaseSpec));
      const memory = await ctx.readGpu();
      const fit = decideFit({
        model: {
          id: model.id,
          sizeBytes: model.sizeBytes,
          ...(model.needBytes === undefined ? {} : { needBytes: model.needBytes }),
        },
        gpu: memory,
        ram: ctx.ram(),
        overheadBytes: options.overheadBytes ?? 1024 * MIB,
      });
      await record.decision({
        class: 'fit',
        facts: [{ readClass: 'gpu.memory', kind: factKind(memory) }],
        numbers: {
          sizeBytes: model.sizeBytes,
          needBytes: fit.needBytes,
          ...(fit.freeBytes === undefined ? {} : { freeBytes: fit.freeBytes }),
          ...(fit.kind === 'fits' && fit.baselineUsedBytes !== undefined
            ? { baselineUsedBytes: fit.baselineUsedBytes }
            : {}),
        },
        reasons: fit.reasons,
        output: fit,
      });
      if (fit.kind === 'short') throw new RouteRefused('route_unavailable', fit.reasons.join('; '));
      throwIfAborted(spec, 'model server start');
      ensureDir(entry.workDir);
      resources.push(await createResource(record, 'tmpdir', entry.workDir, releaseSpec));
      persist();
      const serverRid = newId();
      const env = { ...pinDeviceEnv(fit, memory, options.server.env), ...options.server.env };
      entry.router = await startRouter({
        command: options.server.command,
        ...(options.server.leadArgs ? { leadArgs: options.server.leadArgs } : {}),
        ...(options.server.extraArgs ? { extraArgs: options.server.extraArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        workDir: entry.workDir,
        models: [{ id: model.id, path: model.path, ...(model.args ? { args: model.args } : {}) }],
        marker: serverRid,
        ...(options.startTimeoutMs ? { startTimeoutMs: options.startTimeoutMs } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
        // Неудачный запуск снят не доказанно — освобождение не отдаст слот (F-64); запись на
        // диск сразу: перезапущенное ядро иначе сочло бы слот свободным рядом с живым остатком.
        onLeftover: (text, root) => {
          entry.startLeft = { rid: serverRid, text, root };
          persist();
        },
      });
      entry.vram = {
        baselineUsedBytes: fit.baselineUsedBytes,
        ...('value' in memory
          ? {
              baselineDevices: Object.fromEntries(
                memory.value.devices.map((device) => [device.id, device.usedBytes]),
              ),
            }
          : {}),
      };
      // Запись — до журнала: упавшее между ними ядро всё равно найдёт свой сервер (метка = rid).
      persist();
      const { identity, origin } = entry.router;
      resources.push(
        await createResource(
          record,
          'model-server',
          serverRef(identity, origin),
          releaseSpec,
          serverRid,
        ),
      );
      throwIfAborted(spec, 'model load');
      // Ресурс загрузки — до запроса: упавшая на полпути загрузка тоже освобождается и сверяется.
      resources.push(
        await createResource(record, 'model-load', `${model.id}@${origin}`, releaseSpec),
      );
      persist();
      // Снятая задача не держит слот до конца срока загрузки (F-65).
      await entry.router.client.load(model.id, options.loadTimeoutMs ?? 180_000, spec.signal);
      return lease;
    } catch (error) {
      // Отказ или сбой на полпути — всё уже заведённое освобождается тем же протоколом.
      await release.releaseLease(lease, record);
      throw error;
    }
  };
}
