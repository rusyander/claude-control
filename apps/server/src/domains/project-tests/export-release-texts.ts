import type {
  ProjectTestReleaseDocument,
  ProjectTestReleaseRequirement,
} from '@agentdeck/contracts';
import { RUN_TEXTS, type ExportLanguage } from './export-run-texts.ts';
import { releaseVerdict } from './release.ts';

/**
 * Слова документа готовности вехи на двух языках — той же парой, что отчёт по
 * прогону (`export-run-texts.ts`), и тем же выбором: язык интерфейса того, кто
 * выгружает. Раньше документ был русским при любом языке панели.
 *
 * Статусы кейсов и виды прогонов берутся из словаря отчёта по прогону: два
 * отчёта одного раздела не должны называть один провал разными словами.
 *
 * Вердикт обе половины берут у `verdictOf` (`release.ts`) — того же, что
 * пишет строку экрана, — по числам документа; русский — байт в байт прежний.
 * Оговорку трекера собирает дом (`coverage.ts`) по-русски: русская половина
 * отдаёт её как есть, английская переводит по коду; незнакомый код — русская
 * строка, чем пусто.
 */

type Totals = ProjectTestReleaseDocument['totals'];

export interface ReleaseTexts {
  /** Атрибут `lang` печатной страницы: по нему браузер переносит слова. */
  htmlLang: ExportLanguage;
  status: Record<string, string>;
  mode: Record<string, string>;
  /** Кто прогонял — словом, а не id исполнителя (`agent`/`human`/`ci`). */
  actor: Record<string, string>;
  state: Record<ProjectTestReleaseRequirement['state'], string>;
  defectState: Record<string, string>;
  priority: Record<string, string>;
  heading: (release: string) => string;
  /** `<title>` страницы — без кавычек-ёлочек, как было. */
  pageTitle: (release: string) => string;
  generated: string;
  branch: string;
  commit: string;
  runsCount: string;
  verdictLabel: string;
  verdict: (doc: ProjectTestReleaseDocument) => string;
  warning: (doc: ProjectTestReleaseDocument) => string | undefined;
  totalsLine: (totals: Totals) => string;
  blocking: string;
  untested: string;
  noUntested: string;
  defects: string;
  noDefects: string;
  red: string;
  noRed: string;
  muted: string;
  requirements: string;
  noRequirements: string;
  requirementColumns: string[];
  runs: string;
  noRuns: string;
  runColumns: string[];
}

/** Оговорки матрицы покрытия (`coverage.ts`) по коду — те же слова, что у клиента. */
const ENGLISH_WARNINGS: Record<string, (reason: string) => string> = {
  'coverage-atlassian-off': () =>
    'Atlassian is not connected: only requirements from case links are shown.',
  'coverage-jira-project-unlinked': () =>
    'No Jira project is linked to the project: only requirements from case links are shown.',
  'coverage-jira-failed': (reason) => `Jira did not answer: ${reason}`,
};

function englishWarning(doc: ProjectTestReleaseDocument): string | undefined {
  if (!doc.warning) return undefined;
  const render = doc.warningCode ? ENGLISH_WARNINGS[doc.warningCode] : undefined;
  return render ? render(String(doc.warningParams?.reason ?? '')) : doc.warning;
}

export const RELEASE_TEXTS: Record<ExportLanguage, ReleaseTexts> = {
  ru: {
    htmlLang: 'ru',
    status: RUN_TEXTS.ru.status,
    mode: RUN_TEXTS.ru.mode,
    actor: RUN_TEXTS.ru.actor,
    state: {
      uncovered: 'не покрыто',
      red: 'провал',
      partial: 'не проверено до конца',
      covered: 'закрыто',
    },
    defectState: { open: 'открыт', unknown: 'статус не спрашивали', closed: 'закрыт' },
    priority: { blocker: 'блокер', high: 'высокая', medium: 'средняя', low: 'низкая' },
    heading: (release) => `Готовность вехи «${release}»`,
    pageTitle: (release) => `Готовность вехи ${release}`,
    generated: 'Собран',
    branch: 'Ветка',
    commit: 'Коммит',
    runsCount: 'Прогонов вехи',
    verdictLabel: 'Вердикт',
    verdict: (doc) => releaseVerdict(doc, 'ru').text,
    warning: (doc) => doc.warning,
    totalsLine: (totals) =>
      `Кейсов ${totals.cases} · пройдено ${totals.passed} · провалено ${totals.failed} · ` +
      `заблокировано ${totals.blocked} · пропущено ${totals.skipped} · ` +
      `не проверено ${totals.untested} · в карантине ${totals.muted}`,
    blocking: 'Что мешает',
    untested: 'Не проверено',
    noUntested: 'Непроверенных кейсов нет.',
    defects: 'Незакрытые дефекты',
    noDefects: 'Незакрытых дефектов нет.',
    red: 'Провалы',
    noRed: 'Провалов нет.',
    muted: 'В карантине',
    requirements: 'Требования',
    noRequirements:
      'Требований в документе нет: кейсы ни на что не ссылаются, а трекер не спрошен.',
    requirementColumns: [
      'Ключ',
      'Требование',
      'Кейсов',
      'Пройдено',
      'Провалов',
      'Не проверено',
      'Состояние',
    ],
    runs: 'Прогоны вехи',
    noRuns: 'Прогонов с этой вехой в истории нет.',
    runColumns: ['Начат', 'Чем', 'Кто', 'Ветка', 'Пройдено', 'Провалено', 'Пропущено'],
  },
  en: {
    htmlLang: 'en',
    status: RUN_TEXTS.en.status,
    mode: RUN_TEXTS.en.mode,
    actor: RUN_TEXTS.en.actor,
    state: {
      uncovered: 'not covered',
      red: 'failure',
      partial: 'not fully checked',
      covered: 'covered',
    },
    defectState: { open: 'open', unknown: 'status not asked', closed: 'closed' },
    priority: { blocker: 'blocker', high: 'high', medium: 'medium', low: 'low' },
    heading: (release) => `Milestone readiness “${release}”`,
    pageTitle: (release) => `Milestone readiness ${release}`,
    generated: 'Generated',
    branch: 'Branch',
    commit: 'Commit',
    runsCount: 'Milestone runs',
    verdictLabel: 'Verdict',
    verdict: (doc) => releaseVerdict(doc, 'en').text,
    warning: englishWarning,
    totalsLine: (totals) =>
      `Cases ${totals.cases} · passed ${totals.passed} · failed ${totals.failed} · ` +
      `blocked ${totals.blocked} · skipped ${totals.skipped} · ` +
      `not checked ${totals.untested} · in quarantine ${totals.muted}`,
    blocking: 'What stands in the way',
    untested: 'Not checked',
    noUntested: 'No unchecked cases.',
    defects: 'Open defects',
    noDefects: 'No open defects.',
    red: 'Failures',
    noRed: 'No failures.',
    muted: 'In quarantine',
    requirements: 'Requirements',
    noRequirements:
      'The document has no requirements: the cases link to nothing and the tracker was not asked.',
    requirementColumns: [
      'Key',
      'Requirement',
      'Cases',
      'Passed',
      'Failures',
      'Not checked',
      'State',
    ],
    runs: 'Milestone runs',
    noRuns: 'The history has no runs with this milestone.',
    runColumns: ['Started', 'How', 'Who', 'Branch', 'Passed', 'Failed', 'Skipped'],
  },
};
