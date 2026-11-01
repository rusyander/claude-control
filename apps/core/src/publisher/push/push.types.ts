import type { ActionKind } from '@agentdeck/contracts/core/journal';

/**
 * Порт outbox для публикатора (01 §Outbox): `action.started` с fsync ДО эффекта, потом эффект,
 * потом `action.done` / `action.failed`. Части не импортируют дирижёра (00 §Parts) — порт даёт
 * проводка (`bootstrap/publish-wiring`) поверх `conductor/outbox.runAction`.
 */
export type ActionJson =
  string | number | boolean | null | ActionJson[] | { [k: string]: ActionJson };

export type EffectResult =
  | { ok: true; result: ActionJson }
  /** Эффект отказан сервером (не перемотка, нет доступа) — повтор возможен, сверка не нужна. */
  | { ok: false; code: string; detail: string };

export type ActionOutcome =
  | { ok: true; actionId: string; result: ActionJson }
  | { ok: false; actionId: string; code: string };

export interface OutboxPort {
  run(
    spec: { kind: ActionKind; target: string; idempotencyHint: string },
    effect: () => Promise<EffectResult>,
  ): Promise<ActionOutcome>;
}
