import { createHash } from 'node:crypto';
import { hookSubject } from './hook-block.ts';
import type { SignalDecision } from './observer.types.ts';

/**
 * Петля хука человека (06:122, G-e): тот же хук отказал тому же действию (инструмент + отпечаток
 * цели) `HOOK_LOOP_THRESHOLD` раз за ОДИН шаг → сигнал `hook-loop` (stop, `stop-step`): шаг
 * останавливается и называет хук, а не жжёт ходы о стену. Счёт — только в пределах шага: прошлый
 * шаг с тем же отказом сюда не входит. Срабатывает ровно на пороге — один сигнал на петлю.
 */

export const HOOK_LOOP_SIGNAL = 'hook-loop';
export const HOOK_LOOP_THRESHOLD = 3;

export interface HookRefusalKey {
  stepId: string;
  hook: string | null;
  tool: string | null;
  /** Отпечаток цели вызова (`targetDigest`); отказ не о вызове — `''`. */
  target: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Отпечаток входа вызова: порядок ключей не меняет действие. */
export const targetDigest = (input: unknown): string =>
  createHash('sha256').update(canonical(input), 'utf8').digest('hex');

const same = (a: HookRefusalKey, b: HookRefusalKey): boolean =>
  a.stepId === b.stepId && a.hook === b.hook && a.tool === b.tool && a.target === b.target;

/** Решение класса `hook-loop`: сигнал наблюдателя со своим классом — один судья на класс (P01). */
export type HookLoopDecision = SignalDecision & { signal: typeof HOOK_LOOP_SIGNAL };

/** `seen` — отказы задачи до текущего (любые шаги); `current` — только что пришедший. */
export function judgeHookLoop(
  seen: readonly HookRefusalKey[],
  current: HookRefusalKey,
): HookLoopDecision {
  const count = seen.filter((k) => same(k, current)).length + 1;
  const base = {
    signal: HOOK_LOOP_SIGNAL as typeof HOOK_LOOP_SIGNAL,
    severity: 'stop' as const,
    action: 'stop-step' as const,
    subject: hookSubject(current.hook),
  };
  if (count !== HOOK_LOOP_THRESHOLD)
    return {
      ...base,
      fired: false,
      detail: '',
      reasons: [
        `same refusal ${count}× in step ${current.stepId} (loop at ${HOOK_LOOP_THRESHOLD})`,
      ],
    };
  return {
    ...base,
    fired: true,
    detail: `${current.tool ?? 'no tool call'} refused ${count}× by the same hook in this step`,
    reasons: [
      `${hookSubject(current.hook)} refused the same action ${count}× in step ${current.stepId}: the step stops instead of retrying`,
    ],
  };
}
