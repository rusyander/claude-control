import type { LivePermissionAsk, LivePermissionPolicy } from './types.ts';

/**
 * Решение по просьбе CLI о разрешении — одно на все серверные режимы.
 *
 * Правки разрешены — да без вопроса. Иначе — вопрос человеку, если панель его
 * передала; ответа нет, ошибка, вопроса не передали — отказ. Молча «да» не
 * бывает никогда: отказ дешевле правки, которой человек не давал.
 */
export async function decidePermission(
  policy: LivePermissionPolicy | undefined,
  request: LivePermissionAsk,
): Promise<'allow' | 'deny'> {
  if (policy?.allowEdits) return 'allow';
  if (!policy?.ask) return 'deny';
  try {
    return (await policy.ask(request)) === 'allow' ? 'allow' : 'deny';
  } catch {
    return 'deny';
  }
}

/** Варианты ответа в форме ACP (`allow_once`/`reject_once`…) — qwen serve и goose acp. */
export interface PermissionOption {
  readonly optionId?: string;
  readonly kind?: string;
}

/**
 * Вариант под решение: «да» — разовое разрешение (не «всегда»: второе действие
 * спросит снова), «нет» — разовый отказ. Подходящего нет — `undefined`, и
 * вызывающий отвечает `cancelled` (для CLI это отказ).
 */
export function pickOption(
  options: readonly PermissionOption[],
  decision: 'allow' | 'deny',
): string | undefined {
  const matches = (pattern: RegExp): PermissionOption | undefined =>
    options.find((option) => pattern.test(`${option.kind ?? ''} ${option.optionId ?? ''}`));
  const chosen =
    decision === 'allow'
      ? (matches(/allow_once|proceed_once/i) ?? matches(/allow|proceed/i))
      : (matches(/reject_once/i) ?? matches(/reject|deny|cancel/i));
  return chosen?.optionId;
}
