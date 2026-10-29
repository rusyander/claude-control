import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { RouteLease, RouteResource } from '@agentdeck/contracts/core/routes';
import { z } from 'zod';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { journalRecorder } from './recorder.ts';
import type { TaskRelease } from './road.types.ts';

/**
 * Аренды маршрутов, взятые дорогой сессии, в конце задачи (01 §Resources, P40): снимает их сам
 * маршрут (`route.release` — остановка сервера, чтение назад, `resource.verified`/`leak`), а не
 * поиск ресурсов сессии. Аренда известна из журнала (строка `route-lease` при взятии и
 * `session.started.lease` — переживают перезапуск ядра) и из памяти дороги.
 * Подтверждённое снятым не трогается; утечка прошлого прохода пробуется снова.
 */

export interface TakenLease {
  routeId: string;
  lease: RouteLease;
}

/** Аренды задачи, взятые ЭТИМ ядром (память дороги): ключ — leaseId. */
export function createLeaseBook(): {
  remember(taskId: string, taken: TakenLease): void;
  forget(taskId: string, leaseId: string): void;
  of(taskId: string): TakenLease[];
} {
  const book = new Map<string, Map<string, TakenLease>>();
  return {
    remember(taskId, taken) {
      const leases = book.get(taskId) ?? new Map<string, TakenLease>();
      leases.set(taken.lease.leaseId, taken);
      book.set(taskId, leases);
    },
    forget(taskId, leaseId) {
      book.get(taskId)?.delete(leaseId);
    },
    of: (taskId) => [...(book.get(taskId)?.values() ?? [])],
  };
}

/** Сигнал взятой аренды: пишется сразу при `acquire`, до любого отказа подготовки. */
export const LEASE_SIGNAL = 'route-lease';

const leaseDetail = z.strictObject({
  routeId: z.string().min(1),
  model: z.string(),
  rids: z.array(z.string().min(1)),
});

/**
 * Взятая аренда — строкой журнала в момент взятия (ревью B2r4-F06): иначе аренда, чей запуск не
 * состоялся, известна только памяти дороги, и после перезапуска ядра сервер маршрута живёт до
 * ручной уборки, а отчёт конца задачи о нём молчит.
 */
export function journalLease(task: LiveTask, sessionId: string, taken: TakenLease): void {
  task.append({
    kind: 'signal',
    actor: 'core',
    sessionId,
    data: {
      signal: LEASE_SIGNAL,
      severity: 'info',
      subject: taken.lease.leaseId,
      detail: JSON.stringify({
        routeId: taken.routeId,
        model: taken.lease.model,
        rids: taken.lease.resources.map((r) => r.rid),
      }),
    },
  });
}

/**
 * Аренды, названные журналом задачи: строки `route-lease` (взятие) и `session.started.lease`
 * (запуск, журналы до этой строки); ресурсы — из их `resource.created` ядра.
 */
function journaledLeases(lines: JournalLine[]): TakenLease[] {
  const created = new Map<string, RouteResource>();
  for (const line of lines) {
    if (line.kind !== 'resource.created') continue;
    const data = (line as JournalLine<'resource.created'>).data;
    if (data.owner !== 'core') continue;
    created.set(data.rid, { rid: data.rid, kind: data.kind, ref: data.ref, release: data.release });
  }
  const resourcesOf = (rids: readonly string[]): RouteResource[] =>
    rids.map((rid) => created.get(rid)).filter((r): r is RouteResource => r !== undefined);
  const out: TakenLease[] = [];
  for (const line of lines) {
    if (line.kind === 'signal') {
      const data = (line as JournalLine<'signal'>).data;
      if (data.signal !== LEASE_SIGNAL) continue;
      let parsed: z.infer<typeof leaseDetail> | undefined;
      try {
        const got = leaseDetail.safeParse(JSON.parse(data.detail));
        parsed = got.success ? got.data : undefined;
      } catch {
        parsed = undefined;
      }
      if (!parsed) continue;
      out.push({
        routeId: parsed.routeId,
        lease: {
          leaseId: data.subject,
          routeId: parsed.routeId,
          model: parsed.model,
          resources: resourcesOf(parsed.rids),
        },
      });
      continue;
    }
    if (line.kind !== 'session.started') continue;
    const data = (line as JournalLine<'session.started'>).data;
    if (!data.lease) continue;
    const resources = resourcesOf(data.lease.rids);
    out.push({
      routeId: data.route.id,
      lease: {
        leaseId: data.lease.leaseId,
        routeId: data.route.id,
        model: data.modelAsked,
        resources,
      },
    });
  }
  return out;
}

const kept = (resource: RouteResource): boolean => typeof resource.release === 'object';

export async function releaseTaskLeases(
  task: LiveTask,
  routes: RouteRegistry,
  remembered: readonly TakenLease[],
): Promise<TaskRelease> {
  const out: TaskRelease = { verified: [], leaks: [], unread: [] };
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const byId = new Map<string, TakenLease>();
  for (const taken of [...journaledLeases(lines), ...remembered]) {
    if (!byId.has(taken.lease.leaseId)) byId.set(taken.lease.leaseId, taken);
  }
  const recorder = journalRecorder(task);
  const leak = (rid: string, reason: string): void => {
    task.append({ kind: 'resource.leak', actor: 'core', data: { rid, reason } });
    out.leaks.push({ rid, reason });
  };
  for (const { routeId, lease } of byId.values()) {
    const pending = lease.resources.filter((r) => {
      const status = task.state.resources[r.rid]?.status;
      return !kept(r) && status !== undefined && status !== 'verified';
    });
    if (pending.length === 0) continue;
    for (const r of pending) {
      if (task.state.resources[r.rid]?.status === 'live') {
        task.append({ kind: 'resource.released', actor: 'core', data: { rid: r.rid } });
      }
    }
    const route = routes.get(routeId);
    if (!route) {
      for (const r of pending) leak(r.rid, `route ${routeId} not registered: lease not released`);
      continue;
    }
    let outcome;
    try {
      outcome = await route.release(lease, recorder);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      for (const r of pending) leak(r.rid, `route ${routeId} release failed: ${why}`);
      continue;
    }
    out.verified.push(...outcome.verified);
    out.leaks.push(...outcome.leaks);
    // Маршрут промолчал о ресурсе своей аренды — не «снят»: утечка с причиной.
    const told = new Set([...outcome.verified, ...outcome.leaks].map((x) => x.rid));
    for (const r of pending) {
      if (!told.has(r.rid)) leak(r.rid, `route ${routeId} reported nothing for it on release`);
    }
  }
  return out;
}
