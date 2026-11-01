import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { sha256OfText } from '../../journal/line.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext, PermitDecision } from '../../policy/permit/permit.types.ts';
import type { HumanLedger, RaiseOutcome } from './human.types.ts';
import { readHumanLedger } from './ledger.ts';
import { raiseHumanPoint } from './raise.ts';

/**
 * Отказ права с пунктом человека (06 §Session permissions, P130): хук и сервер права зовут одно и
 * то же — живые гранты этой задачи, затем подъём пункта 3/5 один раз на ждущий запрос.
 */

interface Where {
  stepId: string;
  sessionId: string;
  unitId: string;
}

/**
 * Гранты задачи из журнала (`grant.given`): контекст права собран при запуске сессии, а грант
 * человек даёт посреди шага. Проект гранта — ключ репозитория единицы; другой проект не открывает.
 */
export function liveGrants(ledger: HumanLedger, unitId: string): PermitContext['grants'] {
  const repoKey = ledger.units[unitId]?.repoKey;
  if (!repoKey) return [];
  return ledger.grants
    .filter((g) => g.project === repoKey)
    .map((g) => ({ globs: g.globs, ops: g.ops }));
}

/**
 * Суд права с живыми грантами. Журнал читается только на отказе `grant-required` — каждый вызов
 * инструмента читать журнал не должен, а иной отказ грант не снимает.
 */
export function judgeWithGrants(
  task: Pick<LiveTask, 'dir' | 'taskId'>,
  w: Pick<Where, 'unitId'>,
  ctx: PermitContext,
  judge: (ctx: PermitContext) => PermitDecision,
): { decision: PermitDecision; ledger: HumanLedger | null; regranted: boolean } {
  const first = judge(ctx);
  if (first.allow || first.code !== 'grant-required') {
    return { decision: first, ledger: null, regranted: false };
  }
  const ledger = readHumanLedger(task);
  const grants = liveGrants(ledger, w.unitId);
  if (grants.length === 0) return { decision: first, ledger, regranted: false };
  return {
    decision: judge({ ...ctx, grants: [...ctx.grants, ...grants] }),
    ledger,
    regranted: true,
  };
}

/**
 * Ключ ждущего запроса: шаг + пункт + вид + цель. Хук не знает номера вызова, сервер права знает,
 * но оба судят одно действие — ключ у обеих дорог один, и повтор того же действия (модель
 * пробует снова, пока человек не ответил) вопроса не множит.
 */
export function permitDedupe(
  w: Pick<Where, 'stepId'>,
  point: 3 | 5,
  ask: PermissionAsk,
  copyRoot: string,
): string {
  const target = sameTarget(ask.target, copyRoot);
  return `permit:${w.stepId}:${point}:${ask.action}:${sha256OfText(target).slice(0, 32)}`;
}

/**
 * Одна цель в разных записях (`x`, `./x`, `<копия>/x`, обратные косые) — один ключ. Полную
 * канонизацию (8.3, регистр, потоки) делает судья права; ключу хватает частых форм: промах —
 * лишняя карточка человеку, не пропущенная.
 */
function sameTarget(target: string, copyRoot: string): string {
  const root = copyRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  let t = target.replace(/\\/g, '/');
  if (root && t.toLowerCase().startsWith(`${root.toLowerCase()}/`)) t = t.slice(root.length + 1);
  while (t.startsWith('./')) t = t.slice(2);
  return t;
}

const QUESTION: Record<3 | 5, (ask: PermissionAsk) => string> = {
  3: (ask) => `The step needs a non-ephemeral service endpoint: ${ask.tool} ${ask.target}`,
  5: (ask) => `The step needs a grant to edit ${ask.target} (${ask.tool})`,
};

/** Отказ без пункта — ничего; с пунктом — подъём (решение права уже в журнале, `cause` на него). */
export function raisePermitPoint(
  task: LiveTask,
  w: Where,
  ask: PermissionAsk,
  decision: PermitDecision,
  ledger: HumanLedger | null,
  copyRoot: string,
): RaiseOutcome | null {
  if (decision.allow || decision.humanPoint === null) return null;
  const point = decision.humanPoint;
  const known = ledger ?? undefined;
  return raiseHumanPoint(
    task,
    {
      source: 'permit',
      stepId: w.stepId,
      sessionId: w.sessionId,
      action: { kind: point === 3 ? 'service-endpoint' : 'path', target: ask.target },
      point,
      dedupe: permitDedupe(w, point, ask, copyRoot),
      question: QUESTION[point](ask),
      options: point === 5 ? ['grant', 'refuse'] : ['allow', 'refuse'],
      recommendation: 'refuse',
      blocking: true,
    },
    undefined,
    known ? () => known : undefined,
  );
}
