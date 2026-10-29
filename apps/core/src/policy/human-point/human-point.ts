import type { AskActionKind } from '@agentdeck/contracts/core/model-tools';
import { matchesAny } from '../../lib/glob/glob.ts';
import type {
  HumanPointDecision,
  HumanPointInput,
  HumanPointItem,
  HumanPointPolicy,
} from './human-point.types.ts';

/**
 * Нужен ли человек (06 §Human points, F10, P20 P96). Закрытый список решает по ТИПУ действия;
 * текст вопроса ядро не читает (R:S3-12). Пункты 6, 7, 8 и 10 поднимает само ядро (круги,
 * бюджет, шаг сценария, одобрение запуска) — модель их не заявит никаким действием.
 *
 * Всё вне списка — не вопрос человеку, а развилка в итоговый отчёт: шаг продолжает с
 * рекомендацией модели, даже если модель просила остановиться (блокирующий вопрос вне
 * списка становится неблокирующим). Правка под `grantRequired` при этом не проходит: её
 * держит `policy/permit` до самого действия (06, R:S1-07).
 */

const FIXED: Partial<Record<AskActionKind, HumanPointItem>> = {
  merge: 1,
  'remote-delete': 2,
  'foreign-copy-delete': 2,
  'db-write': 3,
  'service-endpoint': 3,
  credential: 4,
  'access-grant': 4,
  integration: 4,
};

/** Своя доставка задачи — пуш, MR, ответы в обсуждения — человека не ждёт никогда (владелец). */
const OWN_DELIVERY: ReadonlySet<string> = new Set([
  'push',
  'mr-create',
  'mr-update',
  'thread-reply',
]);

/** Пункты 1–4 блокируют всегда: `blocking:false` модели их не снимает (F-46). */
const ALWAYS_BLOCKING: ReadonlySet<HumanPointItem> = new Set([1, 2, 3, 4]);

/**
 * Цели пути для сверки с масками от корня копии. Абсолютная цель или `./`, `../` — копию
 * отсюда не видно, поэтому сверяется каждый хвост пути (`C:/x/copy/migrations/1.sql` →
 * `migrations/1.sql`): лишний вопрос дешевле пропущенного.
 */
function pathCandidates(target: string): string[] {
  const slashed = target.replace(/\\/g, '/');
  const relative = !/^([A-Za-z]:)?\//.test(slashed) && !/^\.{1,2}\//.test(slashed);
  if (relative) return [slashed];
  const parts = slashed.split('/').filter((p) => p !== '' && p !== '.' && p !== '..');
  return parts.map((_, i) => parts.slice(i).join('/'));
}

function matchesPath(target: string, globs: readonly string[]): boolean {
  return pathCandidates(target).some((c) => matchesAny(c, globs, true));
}

function listItem(
  action: NonNullable<HumanPointInput['action']>,
  policy: HumanPointPolicy,
): { item: HumanPointItem; why: string } | { off: string } {
  const fixed = FIXED[action.kind];
  if (fixed) return { item: fixed, why: `${action.kind} is item ${fixed}` };
  switch (action.kind) {
    case 'path': {
      if (matchesPath(action.target, policy.pathGlobs)) {
        return { item: 5, why: 'path class marked by the user' };
      }
      const granted = policy.grantRequired.some(
        (g) => g.ops.includes('edit') && matchesPath(action.target, g.globs),
      );
      if (granted) return { item: 5, why: 'path under grantRequired' };
      return { off: 'path is in no class the user marked' };
    }
    case 'action-class':
      return policy.actionClasses.includes(action.target)
        ? { item: 5, why: 'action class marked by the user' }
        : { off: 'action class not in the user list' };
    case 'tracker-write':
      return policy.trackerWrites === 'ask'
        ? { item: 9, why: 'tracker writes kept on ask' }
        : { off: 'tracker writes are not on ask' };
    case 'forge-write':
      if (OWN_DELIVERY.has(action.target)) return { off: 'own push / MR / replies never ask' };
      return policy.forgeWrites === 'ask'
        ? { item: 9, why: 'forge writes kept on ask' }
        : { off: 'forge writes are not on ask' };
    default:
      return { off: `${action.kind} is not on the list` };
  }
}

export function decideHumanPoint(
  input: HumanPointInput,
  policy: HumanPointPolicy,
): HumanPointDecision {
  if (input.action) {
    const hit = listItem(input.action, policy);
    if ('item' in hit) {
      const blocking = ALWAYS_BLOCKING.has(hit.item) || input.blocking;
      return { point: hit.item, blocking, reason: hit.why };
    }
    return offList(input, hit.off);
  }
  return offList(input, 'no typed action: prose is never a human point');
}

function offList(input: HumanPointInput, why: string): HumanPointDecision {
  return {
    point: null,
    blocking: false,
    fork: {
      question: input.question,
      options: input.options,
      recommendation: input.recommendation,
    },
    reason: input.blocking ? `${why}; blocking ask turned non-blocking` : why,
  };
}
