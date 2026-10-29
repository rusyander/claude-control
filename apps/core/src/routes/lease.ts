import type {
  RefusalCode,
  ResourceKind,
  ResourceRelease,
  RouteAcquireSpec,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { newId } from '../lib/ids/uuidv7.ts';

/**
 * Общие куски аренды маршрута: ресурс заводится ДО того, как им пользуются (01 §Resources —
 * порядок в журнале совпадает с порядком в мире), а отказ маршрута несёт код из закрытого
 * списка 11 R:PR-05 и причину, а не голое исключение.
 */

export function releaseOf(spec: RouteAcquireSpec): ResourceRelease {
  return spec.release ?? 'task-end';
}

export async function createResource(
  record: RouteRecorder,
  kind: ResourceKind,
  ref: string,
  release: ResourceRelease,
  /** Свой rid, если он нужен до записи (метка дерева процесса — rid его ресурса). */
  rid: string = newId(),
): Promise<RouteResource> {
  const resource: RouteResource = { rid, kind, ref, release };
  await record.created(resource);
  return resource;
}

/** Отказ маршрута при аренде: код — из списка совместимости, причина — для человека и журнала. */
export class RouteRefused extends Error {
  readonly code: RefusalCode;
  readonly reason: string;
  constructor(code: RefusalCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'RouteRefused';
    this.code = code;
    this.reason = reason;
  }
}

/** Прерывание ожидания и запуска (`AbortSignal` вызывающего). */
export class RouteAborted extends Error {
  constructor(stage: string) {
    super(`route acquire aborted during ${stage}`);
    this.name = 'RouteAborted';
  }
}

export function throwIfAborted(spec: RouteAcquireSpec, stage: string): void {
  if (spec.signal?.aborted) throw new RouteAborted(stage);
}
