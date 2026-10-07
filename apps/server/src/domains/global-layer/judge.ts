import type {
  GlobalLayerCaseResult,
  GlobalLayerMiss,
  GlobalLayerOutcome,
  GlobalLayerRow,
  GlobalLayerVerdict,
} from '@agentdeck/contracts';
import type { CorpusCase } from './case-repo.ts';
import type { SideFindings } from './runners.ts';

/**
 * Судья сверки — чистая функция над ответами сторон и ожиданиями корпуса.
 *
 * Сторона права на случае по сите, когда отметила РОВНО то, что корпус
 * требует: пропуск — непойманное настоящее, лишнее — ложное срабатывание, и то
 * и другое ошибка. Случай судится только по ситам из своего `expect`: правка
 * кода без теста задевает «тесты рядом» почти в каждом случае, и без этого
 * ограничения шум одной ситы решал бы вердикт другой.
 *
 * «Лучше» — та сторона, что права на большем числе случаев ситы; поровну —
 * равны. Так «ловит больше настоящего» и «без лишних срабатываний» считаются
 * одной мерой, а не двумя, которые пришлось бы взвешивать.
 */

export interface SideRun {
  results: Record<string, SideFindings>;
  errors: Record<string, string>;
}

function miss(found: readonly string[], expected: readonly string[]): GlobalLayerMiss | undefined {
  const want = new Set(expected);
  const got = new Set(found);
  const missed = expected.filter((item) => !got.has(item));
  const extra = found.filter((item) => !want.has(item));
  return missed.length > 0 || extra.length > 0 ? { missed, extra } : undefined;
}

/** Ошибка прогона на случае — сторона не права по всем его ситам. */
function sideMiss(run: SideRun, item: CorpusCase, sieve: string): GlobalLayerMiss | undefined {
  const error = run.errors[item.id] ?? run.errors['*'];
  if (error) return { missed: [`error: ${error}`], extra: [] };
  return miss(run.results[item.id]?.[sieve] ?? [], item.expect[sieve] ?? []);
}

function outcomeOf(panelRight: boolean, globalRight: boolean): GlobalLayerOutcome {
  if (panelRight && globalRight) return 'both';
  if (panelRight) return 'panel';
  if (globalRight) return 'global';
  return 'neither';
}

function verdictOf(row: Omit<GlobalLayerRow, 'verdict' | 'cases'>): GlobalLayerVerdict {
  if (row.panelOnly > row.globalOnly) return 'panel';
  if (row.globalOnly > row.panelOnly) return 'global';
  return 'equal';
}

export function judge(
  cases: readonly CorpusCase[],
  panel: SideRun,
  global: SideRun,
): GlobalLayerRow[] {
  const sieves = [...new Set(cases.flatMap((item) => Object.keys(item.expect)))];
  return sieves.map((sieve) => {
    const counts = { sieve, both: 0, panelOnly: 0, globalOnly: 0, neither: 0 };
    const results: GlobalLayerCaseResult[] = [];
    for (const item of cases) {
      if (!(sieve in item.expect)) continue;
      const panelMiss = sideMiss(panel, item, sieve);
      const globalMiss = sideMiss(global, item, sieve);
      const outcome = outcomeOf(!panelMiss, !globalMiss);
      if (outcome === 'both') counts.both += 1;
      else if (outcome === 'panel') counts.panelOnly += 1;
      else if (outcome === 'global') counts.globalOnly += 1;
      else counts.neither += 1;
      results.push({
        caseId: item.id,
        title: item.title,
        outcome,
        ...(panelMiss ? { panel: panelMiss } : {}),
        ...(globalMiss ? { global: globalMiss } : {}),
      });
    }
    return { ...counts, verdict: verdictOf(counts), cases: results };
  });
}

/** Случаев, где сторона ошиблась хоть по одной сите: «корпус зелёный» = ноль. */
export function failingCases(rows: readonly GlobalLayerRow[], side: 'panel' | 'global'): number {
  const failing = new Set<string>();
  for (const row of rows) {
    for (const item of row.cases) if (item[side]) failing.add(item.caseId);
  }
  return failing.size;
}
