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
  return (await judgePermission(policy, request)).decision;
}

/** Решение и, у отказа судьи, его причина — агенту (`opencode` кладёт её в ответ). */
export interface PermissionOutcome {
  readonly decision: 'allow' | 'deny';
  readonly message?: string;
}

/** `decidePermission` с причиной отказа судьи — для провода, который её передаёт. */
export async function judgePermission(
  policy: LivePermissionPolicy | undefined,
  request: LivePermissionAsk,
): Promise<PermissionOutcome> {
  // Команда оболочки при судье — сперва суд (P-01..P-05): переключатель правок
  // не разрешает `git branch -D` и пуш в main, как не разрешает их тумблер Claude.
  // Судья упал — вопрос человеку, а не «да».
  const shell = request.shell;
  if (shell && policy?.judge) {
    const verdict = await policy
      .judge(shell, request.pid)
      .catch(() => ({ behavior: 'human' as const }));
    if (verdict.behavior === 'allow') return { decision: 'allow' };
    if (verdict.behavior === 'deny') {
      if (verdict.message) {
        // Причина — модели ДО ответа CLI: отказ без неё модель видит лишь как
        // «rejected by user» и повторяет команду. Сбой подсказки решения не меняет.
        await Promise.resolve()
          .then(() => policy.onRefusal?.(verdict.message as string, shell))
          .catch(() => undefined);
        return { decision: 'deny', message: verdict.message };
      }
      return { decision: 'deny' };
    }
    return askHuman(policy, request);
  }
  if (policy?.allowEdits) return { decision: 'allow' };
  return askHuman(policy, request);
}

async function askHuman(
  policy: LivePermissionPolicy | undefined,
  request: LivePermissionAsk,
): Promise<PermissionOutcome> {
  if (!policy?.ask) return { decision: 'deny' };
  try {
    return { decision: (await policy.ask(request)) === 'allow' ? 'allow' : 'deny' };
  } catch {
    return { decision: 'deny' };
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
