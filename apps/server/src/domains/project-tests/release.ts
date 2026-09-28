import type {
  ProjectTestCase,
  ProjectTestCoverage,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestReleaseCase,
  ProjectTestReleaseDefect,
  ProjectTestReleaseDocument,
  ProjectTestReleaseRequirement,
  ProjectTestReleaseRun,
  ProjectTestReleaseVerdict,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { reasonOf } from './point-reason.ts';
import type { ExportLanguage } from './export-run-texts.ts';

/**
 * Готовность вехи одним документом.
 *
 * Вопрос «отдаём или нет» задают вехой, а ответ на него сегодня собирается из
 * четырёх вкладок: покрытие в одной, красное во второй, дефекты в третьей,
 * прогоны в четвёртой. Каждый собирает его по-своему, и «мы всё проверили»
 * означает у двух людей разное. Здесь он собран один раз и в одном порядке.
 *
 * Порядок разделов — порядок чтения: сначала то, что МЕШАЕТ (непроверенное и
 * незакрытые дефекты), потом чем закрыты требования, потом чем это доказано.
 * Отчёт, начинающийся с «пройдено 240», отвечает на вопрос, которого никто не
 * задавал.
 *
 * Считается по прогонам ВЕХИ, а не по текущим статусам кейсов. Кейс мог
 * позеленеть вчера в соседней ветке, и записывать это в готовность релиза
 * значило бы отдавать по проверке, которой в релизе не было.
 *
 * Требования модуль не добывает, а принимает (`coverage`): за ними ходят в
 * Jira, а документ обязан собираться и на машине без сети — тогда он просто
 * называет, чего в нём не хватает.
 */

/** Порядок важности при показе провалов: сначала то, из-за чего не отдают. */
const PRIORITY_ORDER: Record<string, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Важность не задана — между `medium` и `low`: судить не по чему. */
const PRIORITY_UNSET = 2.5;

export interface ReleaseOptions {
  /** Момент сборки, ISO. Пусто — сейчас. */
  now?: string;
  /** Матрица покрытия: требования приходят снаружи. */
  coverage?: ProjectTestCoverage;
  branch?: string;
  commit?: string;
  /**
   * Язык панели: на нём обвязка заметки («шаг N: … (ожидалось: …)») и вердикт
   * — экран показывает их как есть, и в английском интерфейсе они были
   * русскими. Файл и печать берут тот же язык (`release-routes.ts`); пусто —
   * русский.
   */
  lang?: ExportLanguage;
}

/** Результат кейса у этой вехи: самый свежий из её прогонов. */
interface Outcome {
  status: ProjectTestStatus;
  note?: string;
}

/**
 * Что веха видела по каждому кейсу.
 *
 * Прогоны приходят от новых к старым, поэтому первый встреченный результат и
 * есть последнее слово вехи: перепрошли красный кейс — в документ идёт вторая
 * попытка, а не первая.
 */
function outcomesOf(
  runs: ProjectTestRunRecord[],
  lang: ExportLanguage = 'ru',
): Map<string, Outcome> {
  const byCase = new Map<string, Outcome>();
  for (const run of runs) {
    for (const result of run.results) {
      const key = `${result.groupId}:${result.caseId}`;
      if (byCase.has(key)) continue;
      byCase.set(key, { status: result.status, note: noteOf(result, lang) });
    }
  }
  return byCase;
}

/** Что видел исполнитель — той же строкой, что в отчёте прогона (`reasonOf`). */
function noteOf(result: ProjectTestPointResult, lang: ExportLanguage): string | undefined {
  return reasonOf(result, lang) || undefined;
}

function toReleaseCase(
  groupId: string,
  testCase: ProjectTestCase,
  outcome: Outcome | undefined,
): ProjectTestReleaseCase {
  return {
    groupId,
    caseId: testCase.id,
    title: testCase.title,
    priority: testCase.priority,
    status: outcome?.status ?? 'unknown',
    note: outcome?.note,
    muted: testCase.muted,
    muteReason: testCase.muteReason,
  };
}

function byPriority(left: ProjectTestReleaseCase, right: ProjectTestReleaseCase): number {
  const rank = (item: ProjectTestReleaseCase): number =>
    item.priority ? (PRIORITY_ORDER[item.priority] ?? PRIORITY_UNSET) : PRIORITY_UNSET;
  return rank(left) - rank(right) || left.title.localeCompare(right.title);
}

function isRed(status: ProjectTestStatus): boolean {
  return status === 'failed' || status === 'blocked';
}

/**
 * Требования вехи.
 *
 * Счёт пересобирается по результатам ВЕХИ, а не берётся из матрицы покрытия:
 * матрица знает текущий статус кейса, а вопрос здесь другой — что по этому
 * требованию видели в релизе. Требование без единого кейса остаётся в
 * документе: ради него отчёт и открывают.
 */
function requirementsOf(
  coverage: ProjectTestCoverage | undefined,
  outcomes: Map<string, Outcome>,
  muted: Set<string>,
): ProjectTestReleaseRequirement[] {
  if (!coverage) return [];

  const rows = coverage.items.map((item) => {
    let passed = 0;
    let failed = 0;
    let untested = 0;
    for (const one of item.cases) {
      const key = `${one.groupId}:${one.caseId}`;
      const outcome = outcomes.get(key);
      if (!outcome) untested += 1;
      else if (outcome.status === 'passed') passed += 1;
      else if (isRed(outcome.status) && !muted.has(key)) failed += 1;
    }
    const state: ProjectTestReleaseRequirement['state'] =
      item.cases.length === 0
        ? 'uncovered'
        : failed > 0
          ? 'red'
          : untested > 0
            ? 'partial'
            : 'covered';
    return {
      key: item.key,
      title: item.title,
      url: item.url,
      status: item.status,
      cases: item.cases.length,
      passed,
      failed,
      untested,
      state,
    };
  });

  // Тот же порядок, что в матрице: сначала непокрытое, потом красное.
  const rank: Record<ProjectTestReleaseRequirement['state'], number> = {
    uncovered: 0,
    red: 1,
    partial: 2,
    covered: 3,
  };
  return rows.sort(
    (left, right) => rank[left.state] - rank[right.state] || left.key.localeCompare(right.key),
  );
}

/**
 * Незакрытые дефекты живых кейсов.
 *
 * Незакрытым считается всё, кроме прямого `closed`: статус, которого у трекера
 * не спрашивали, — это не «дефект неважен», а «неизвестно», и прятать такой
 * дефект из документа готовности значит отвечать «отдаём» с закрытыми глазами.
 */
function openDefects(groups: ProjectTestGroup[]): ProjectTestReleaseDefect[] {
  const rows: ProjectTestReleaseDefect[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      for (const defect of testCase.defects ?? []) {
        if (defect.state === 'closed') continue;
        rows.push({
          url: defect.url,
          title: defect.title,
          key: defect.key,
          state: defect.state ?? 'unknown',
          stateLabel: defect.stateLabel,
          groupId: group.id,
          caseId: testCase.id,
          caseTitle: testCase.title,
        });
      }
    }
  }
  // Прямо открытые — наверх: про них уже известно, что они не починены.
  return rows.sort(
    (left, right) =>
      Number(right.state === 'open') - Number(left.state === 'open') ||
      left.caseTitle.localeCompare(right.caseTitle),
  );
}

function runLine(run: ProjectTestRunRecord): ProjectTestReleaseRun {
  return {
    id: run.id,
    mode: run.mode,
    actor: run.actor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    branch: run.branch,
    environmentId: run.environmentId,
    summary: run.summary,
  };
}

/** Слова вердикта. Русская половина — прежняя строка байт в байт. */
interface VerdictTexts {
  noRuns: string;
  failed: (count: number) => string;
  blocked: (count: number) => string;
  untested: (count: number, cases: number) => string;
  defects: (count: number) => string;
  muted: (count: number) => string;
  early: (release: string, blockers: string) => string;
  ready: (release: string, passed: number, cases: number) => string;
}

const VERDICT_TEXTS: Record<ExportLanguage, VerdictTexts> = {
  ru: {
    noRuns: 'Прогонов вехи нет: проверять нечего.',
    failed: (count) => `Провалов: ${count}.`,
    blocked: (count) => `Заблокировано кейсов: ${count}.`,
    untested: (count, cases) => `Не проверено кейсов: ${count} из ${cases}.`,
    defects: (count) => `Незакрытых дефектов: ${count}.`,
    muted: (count) => ` В карантине ${count} — их провалы в вердикт не идут.`,
    early: (release, blockers) => `Веха «${release}»: отдавать рано. ${blockers}`,
    ready: (release, passed, cases) =>
      `Веха «${release}»: пройдено ${passed} из ${cases}, ничего из проверяемого панелью отдавать не мешает.`,
  },
  en: {
    noRuns: 'The milestone has no runs: nothing to check.',
    failed: (count) => `Failures: ${count}.`,
    blocked: (count) => `Blocked cases: ${count}.`,
    untested: (count, cases) => `Unchecked cases: ${count} of ${cases}.`,
    defects: (count) => `Open defects: ${count}.`,
    muted: (count) => ` In quarantine: ${count} — their failures do not count toward the verdict.`,
    early: (release, blockers) => `Milestone “${release}”: too early to ship. ${blockers}`,
    ready: (release, passed, cases) =>
      `Milestone “${release}”: passed ${passed} of ${cases}, nothing the panel checks stands in the way of shipping.`,
  },
};

/**
 * Вердикт: что мешает отдавать.
 *
 * Панель ничего не подписывает — `ready` означает «ничего из перечисленного не
 * мешает», а решение остаётся человеку. Карантин в блокирующие не идёт: право
 * красить прогон у такого кейса снято осознанно, — но и молчать о нём нельзя,
 * поэтому он назван строкой.
 *
 * Единственный источник вердикта — и экрана, и файла (`releaseVerdict`):
 * второй набор правил рядом расходился бы с первым при новой причине.
 */
export function verdictOf(
  release: string,
  counts: ProjectTestReleaseDocument['totals'] & { defects: number },
  hasRuns: boolean,
  lang: ExportLanguage = 'ru',
): ProjectTestReleaseVerdict {
  const t = VERDICT_TEXTS[lang];
  const blockers: string[] = [];
  if (!hasRuns) blockers.push(t.noRuns);
  if (counts.failed > 0) blockers.push(t.failed(counts.failed));
  if (counts.blocked > 0) blockers.push(t.blocked(counts.blocked));
  if (counts.untested > 0) blockers.push(t.untested(counts.untested, counts.cases));
  if (counts.defects > 0) blockers.push(t.defects(counts.defects));

  const muted = counts.muted > 0 ? t.muted(counts.muted) : '';
  return {
    ready: blockers.length === 0,
    text: blockers.length
      ? `${t.early(release, blockers.join(' '))}${muted}`
      : `${t.ready(release, counts.passed, counts.cases)}${muted}`,
    blockers,
  };
}

/**
 * Вердикт готового документа на языке `lang` — по его же числам. Им пишут
 * файл и печать: правила те же, что у строки экрана.
 */
export function releaseVerdict(
  doc: ProjectTestReleaseDocument,
  lang: ExportLanguage,
): ProjectTestReleaseVerdict {
  return verdictOf(
    doc.release,
    { ...doc.totals, defects: doc.defects.length },
    doc.totals.runs > 0,
    lang,
  );
}

/**
 * Собрать документ готовности вехи.
 *
 * Архивные кейсы не участвуют нигде: архив и есть способ сказать «этот кейс
 * больше не наш», и считать его непроверенным значило бы держать релиз из-за
 * того, что сами же выбросили. Нечитаемая группа пропускается — её содержимого
 * панель не знает и врать о нём не станет.
 */
export function buildRelease(
  release: string,
  groups: ProjectTestGroup[],
  runs: ProjectTestRunRecord[],
  options: ReleaseOptions = {},
): ProjectTestReleaseDocument {
  const name = release.trim();
  const releaseRuns = runs.filter((run) => (run.release ?? '').trim() === name);
  const outcomes = outcomesOf(releaseRuns, options.lang);

  const red: ProjectTestReleaseCase[] = [];
  const untested: ProjectTestReleaseCase[] = [];
  const mutedRed: ProjectTestReleaseCase[] = [];
  const mutedKeys = new Set<string>();
  const totals = {
    cases: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    untested: 0,
    muted: 0,
    runs: releaseRuns.length,
  };

  for (const group of groups) {
    if (group.error) continue;
    for (const testCase of group.cases) {
      if (testCase.archived) continue;
      const key = `${group.id}:${testCase.id}`;
      if (testCase.muted) mutedKeys.add(key);
      totals.cases += 1;

      const outcome = outcomes.get(key);
      const view = toReleaseCase(group.id, testCase, outcome);
      if (!outcome) {
        totals.untested += 1;
        untested.push(view);
        continue;
      }
      if (outcome.status === 'passed') totals.passed += 1;
      else if (outcome.status === 'skipped') totals.skipped += 1;

      if (!isRed(outcome.status)) continue;
      if (testCase.muted) {
        totals.muted += 1;
        mutedRed.push(view);
        continue;
      }
      if (outcome.status === 'failed') totals.failed += 1;
      else totals.blocked += 1;
      red.push(view);
    }
  }

  const defects = openDefects(groups);
  const verdict = verdictOf(
    name,
    { ...totals, defects: defects.length },
    releaseRuns.length > 0,
    options.lang,
  );

  return {
    release: name,
    generatedAt: options.now ?? new Date().toISOString(),
    branch: options.branch,
    commit: options.commit,
    verdict,
    totals,
    requirements: requirementsOf(options.coverage, outcomes, mutedKeys),
    red: red.sort(byPriority),
    untested: untested.sort(byPriority),
    muted: mutedRed.sort(byPriority),
    defects,
    runs: releaseRuns.map(runLine),
    warning: options.coverage?.warning,
  };
}

/** Вехи, которые вообще встречаются в истории, — от свежей к старой. */
export function releaseNames(runs: ProjectTestRunRecord[]): string[] {
  const names: string[] = [];
  for (const run of runs) {
    const name = (run.release ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
