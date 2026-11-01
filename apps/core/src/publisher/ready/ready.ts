import { sha256OfText } from '../../journal/line.ts';
import type {
  PublishReadyInput,
  PublishReadyDecision,
  ReadyNext,
  ReadyUnmet,
} from './ready.types.ts';

/**
 * Готовность к публикации (05 §Readiness, F01 F08): одна функция, один отказ. Отказ перечисляет
 * КАЖДОЕ несбывшееся условие (P03) — шаг правки чинит всё за один круг, а не по одному отказу на
 * круг. Чистая: тот же вход — то же решение, поэтому повтор с тем же хешем входа не считается
 * заново (`readyJudge`).
 */

/** Ключи по порядку, массивы как есть: хеш входа не зависит от порядка полей объекта. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const obj = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function readyInputsHash(input: PublishReadyInput): string {
  return sha256OfText(stableJson(input));
}

/**
 * Что дальше, если условий несколько: открытая точка человека держит всё; потом нечитаемый форж
 * (факты неполны); потом дерево ушло от состава (остальные вердикты устарели — проверка заново);
 * потом конфликт с базой; остальное чинит шаг правки.
 */
const NEXT_ORDER: readonly ReadyNext[] = [
  'ask',
  'wait-forge',
  'regate',
  'resolve-conflict',
  'fix-step',
];

function unmetOf(input: PublishReadyInput): { unmet: ReadyUnmet; next: ReadyNext }[] {
  const out: { unmet: ReadyUnmet; next: ReadyNext }[] = [];
  const add = (next: ReadyNext, code: ReadyUnmet['code'], subject: string, what: string): void => {
    out.push({ unmet: { code, subject, next: what }, next });
  };
  if (input.compositionTreeFp !== input.outgoingTreeFp) {
    add(
      'regate',
      'composition-mismatch',
      input.compositionId,
      'the outgoing tree is not the tree the final gate composed: gate again',
    );
  }
  if ('unknown' in input.baseOnServer) {
    add('wait-forge', 'forge-unknown', 'base', `base on the server: ${input.baseOnServer.unknown}`);
  }
  if (input.mergeTree === 'conflict') {
    add('resolve-conflict', 'base-conflict', 'merge-tree', 'merge the base in a fix step');
  } else if (typeof input.mergeTree === 'object') {
    add('wait-forge', 'forge-unknown', 'merge-tree', input.mergeTree.unknown);
  }
  if (input.requirements !== 'met') {
    for (const r of input.requirements.unmet) {
      add('fix-step', 'requirements', r, 'the requirement has no proven change');
    }
  }
  const gaps = input.coverage.gaps;
  if (input.coverage.policy === 'refuse') {
    if (!Array.isArray(gaps)) add('fix-step', 'coverage-gap', 'coverage', gaps.unknown);
    else for (const g of gaps) add('fix-step', 'coverage-gap', g, 'changed code without a test');
  }
  for (const f of input.sieves) add('fix-step', 'sieve', `${f.sieve}:${f.file}`, f.detail);
  for (const t of input.texts) {
    if (t.verdict === 'refused') add('fix-step', 'text', t.kind, 'outgoing text refused');
  }
  for (const p of input.openHumanPoints) {
    add('ask', 'human-point', `point ${p}`, 'a human point is still open');
  }
  return out;
}

export function decideReady(input: PublishReadyInput): PublishReadyDecision {
  const inputsHash = readyInputsHash(input);
  const found = unmetOf(input);
  if (found.length === 0) return { kind: 'allow', inputsHash };
  const next = NEXT_ORDER.find((n) => found.some((f) => f.next === n)) ?? 'fix-step';
  return { kind: 'refuse', unmet: found.map((f) => f.unmet), next, inputsHash };
}

/**
 * Память решений по хешу входа: повтор с неизменным входом отдаёт то же решение без пересчёта
 * (05:58). `computed` — сколько раз решение считалось на самом деле (его видит тест памяти).
 */
export interface ReadyJudge {
  decide(input: PublishReadyInput): PublishReadyDecision;
  readonly computed: number;
}

export function readyJudge(
  compute: (i: PublishReadyInput) => PublishReadyDecision = decideReady,
): ReadyJudge {
  const memo = new Map<string, PublishReadyDecision>();
  let computed = 0;
  return {
    decide(input) {
      const hash = readyInputsHash(input);
      const hit = memo.get(hash);
      if (hit) return hit;
      computed += 1;
      const got = compute(input);
      memo.set(hash, got);
      return got;
    },
    get computed() {
      return computed;
    },
  };
}

/** Строка причины отказа шага публикации: `<next>: <код субъект — что делать>; …`. */
export function refusalUnmet(
  decision: Extract<PublishReadyDecision, { kind: 'refuse' }>,
): string[] {
  return decision.unmet.map((u) => `${u.code} ${u.subject} — ${u.next}`);
}
