import type {
  RefusalCode,
  ResourceKind,
  ResourceRelease,
  RouteAcquireSpec,
  RouteBinding,
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

/**
 * Модель по умолчанию CLI (`model: null`) годится только входу самого CLI: маршруту с адресом нужна
 * модель в адресе, угадывать её никто не будет. Отказ называет маршрут; `null` — модель годится.
 */
export function modelRequired(
  route: { id: string; caps: { binding: RouteBinding } },
  model: string | null,
): string | null {
  if (model !== null || route.caps.binding.via === 'cli-login') return null;
  return `route ${route.id} needs a concrete model; the tier picked the CLI default (set a task model ceiling or a step model)`;
}

/** Модель аренды маршрута с адресом: `null` — отказ `model_absent` тем же текстом `modelRequired`. */
export function requireModel(
  route: { id: string; caps: { binding: RouteBinding } },
  spec: RouteAcquireSpec,
): string {
  if (spec.model !== null) return spec.model;
  throw new RouteRefused(
    'model_absent',
    modelRequired(route, null) ?? `route ${route.id} needs a concrete model`,
  );
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
