import type { LeadRole } from '@agentdeck/contracts/core/lead';
import type {
  SplitDemotion,
  SplitPlanContract,
  SplitProblem,
  SplitUnit,
} from './split-check.types.ts';

/**
 * Договор плана ведущего (этап 11, D6, P137) — правила сверх P39, которые судит та же проверка
 * деления: у каждого куска решаемая проверка (нет — как `fail{absent}`: кусок без проверки нечем
 * принять), годная роль куска, критерии кусков покрывают каждое открытое требование, вход куска —
 * от существующего куска-зависимости, интерфейс, который берут два куска и больше, — через
 * кусок-каркас `implement`, от которого зависят оба. Механика без полной спецификации (файлы,
 * интерфейс, проверка) не отказ, а `implement` с названной причиной.
 */

/** Роли, которые может нести кусок плана: разбор, разведка и план — шаги оценки, не куски. */
export const PIECE_ROLES: readonly LeadRole[] = ['implement', 'mechanical', 'review', 'integrate'];
const DEFAULT_PIECE_ROLE: LeadRole = 'implement';

const isPieceRole = (role: string): role is LeadRole =>
  (PIECE_ROLES as readonly string[]).includes(role);

const checkOf = (u: SplitUnit): string | undefined => u.check ?? u.spec?.check;

function checkProblems(units: readonly SplitUnit[], plan: SplitPlanContract): SplitProblem[] {
  const out: SplitProblem[] = [];
  for (const u of units) {
    const check = checkOf(u);
    if (check === undefined || check.trim() === '')
      out.push({
        code: 'no-check',
        units: [u.name],
        detail: `${u.name} names no check: a piece without a check cannot be accepted`,
      });
    else if (!plan.resolvesCheck(u.repoKey, check))
      out.push({
        code: 'unknown-check',
        units: [u.name],
        detail: `${u.name} check ${check} is not in the check registry of ${u.repoKey}`,
      });
  }
  return out;
}

function roleProblems(units: readonly SplitUnit[]): SplitProblem[] {
  return units
    .filter((u) => u.role !== undefined && !isPieceRole(u.role))
    .map((u) => ({
      code: 'bad-role' as const,
      units: [u.name],
      detail: `${u.name} role ${u.role} is not a piece role (${PIECE_ROLES.join(', ')})`,
    }));
}

function coverageProblems(units: readonly SplitUnit[], plan: SplitPlanContract): SplitProblem[] {
  const covered = new Set(units.flatMap((u) => u.acRefs ?? []));
  const missing = plan.openRequirements.filter((id) => !covered.has(id));
  if (missing.length === 0) return [];
  return [
    {
      code: 'uncovered-requirement',
      units: [],
      detail: `no piece covers open requirement ${missing.join(', ')}`,
    },
  ];
}

function inputProblems(units: readonly SplitUnit[]): SplitProblem[] {
  const names = new Set(units.map((u) => u.name));
  const out: SplitProblem[] = [];
  for (const u of units) {
    for (const input of u.inputs ?? []) {
      if (names.has(input.from) && u.deps.includes(input.from)) continue;
      out.push({
        code: 'input-not-dep',
        units: [u.name],
        detail: names.has(input.from)
          ? `${u.name} takes ${input.iface} from ${input.from}, which is not its dep`
          : `${u.name} takes ${input.iface} from unknown piece ${input.from}`,
      });
    }
  }
  return out;
}

/** Роль куска после понижения механики: её видит проверка каркаса и строка единицы. */
function effectiveRole(u: SplitUnit, demoted: readonly SplitDemotion[]): LeadRole {
  if (u.role === undefined || !isPieceRole(u.role)) return DEFAULT_PIECE_ROLE;
  return demoted.some((d) => d.unit === u.name) ? DEFAULT_PIECE_ROLE : u.role;
}

function skeletonProblems(
  units: readonly SplitUnit[],
  roles: Readonly<Record<string, LeadRole>>,
): SplitProblem[] {
  const byIface = new Map<string, SplitUnit[]>();
  for (const u of units)
    for (const input of u.inputs ?? [])
      byIface.set(input.iface, [...(byIface.get(input.iface) ?? []), u]);
  const out: SplitProblem[] = [];
  for (const [iface, consumers] of byIface) {
    const users = [...new Set(consumers)];
    if (users.length < 2) continue;
    const skeleton = units.find(
      (s) => roles[s.name] === 'implement' && users.every((c) => c.deps.includes(s.name)),
    );
    if (skeleton) continue;
    out.push({
      code: 'no-skeleton',
      units: users.map((u) => u.name),
      detail: `${users.map((u) => u.name).join(', ')} share ${iface}: they need an implement skeleton piece as their dep`,
    });
  }
  return out;
}

function demotionsOf(units: readonly SplitUnit[]): SplitDemotion[] {
  const out: SplitDemotion[] = [];
  for (const u of units) {
    if (u.role !== 'mechanical') continue;
    const missing: string[] = [];
    if (!u.spec?.files || u.spec.files.length === 0) missing.push('files');
    if (!u.spec?.interface || u.spec.interface.trim() === '') missing.push('interface');
    if (!u.spec?.check || u.spec.check.trim() === '') missing.push('check');
    if (missing.length > 0) out.push({ unit: u.name, missing });
  }
  return out;
}

export interface PlanJudgement {
  problems: SplitProblem[];
  roles: Record<string, LeadRole>;
  demoted: SplitDemotion[];
  reasons: string[];
}

export function judgePlan(units: readonly SplitUnit[], plan: SplitPlanContract): PlanJudgement {
  const demoted = demotionsOf(units);
  const roles = Object.fromEntries(units.map((u) => [u.name, effectiveRole(u, demoted)]));
  const problems = [
    ...checkProblems(units, plan),
    ...roleProblems(units),
    ...coverageProblems(units, plan),
    ...inputProblems(units),
    ...skeletonProblems(units, roles),
  ];
  const reasons = demoted.map(
    (d) => `${d.unit}: mechanical without a complete spec (${d.missing.join(', ')}) → implement`,
  );
  return { problems, roles, demoted, reasons };
}
