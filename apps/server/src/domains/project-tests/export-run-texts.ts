/**
 * Слова отчёта по прогону на двух языках.
 *
 * Отчёт читают там, где панели нет (приёмка, заказчик, задача в трекере), и
 * язык ему задаёт интерфейс панели того, кто выгружал. Раньше отчёт был русским
 * при любом языке, и английский интерфейс отдавал наружу «Прогон: …».
 */

export type ExportLanguage = 'ru' | 'en';

/** Язык отчёта из языка интерфейса: всё, кроме английского, — русский. */
export function exportLanguage(language: string | undefined): ExportLanguage {
  return language === 'en' ? 'en' : 'ru';
}

export interface RunTexts {
  status: Record<string, string>;
  mode: Record<string, string>;
  panelAutotests: string;
  actor: Record<string, string>;
  /** Незавершённый прогон — словом в шапке: без него прерванный читался завершённым. */
  state: Record<string, string>;
  finishedState: string;
  columns: string[];
  recordColumn: string;
  unwalked: string;
  heading: string;
  /** Заголовок страницы Confluence, куда публикуется отчёт. */
  pageTitle: string;
  started: string;
  finished: string;
  neverFinished: string;
  stateLabel: string;
  actorLabel: string;
  branch: string;
  commit: string;
  environment: string;
  plan: string;
  tokens: string;
  broke: string;
  summary: string;
  failedHeading: string;
  noFailures: string;
  unwalkedHeading: string;
  passesHeading: string;
  noResults: string;
  attachments: string;
  summaryLine: (counts: {
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
    total: number;
  }) => string;
  unwalkedTail: (open: number, planned: number) => string;
  step: (step: number) => string;
  expected: (text: string) => string;
  failure: string;
  /** Зелёный только на повторе раннера: число упавших попыток. */
  flaky: (attempts: number) => string;
}

export const RUN_TEXTS: Record<ExportLanguage, RunTexts> = {
  ru: {
    status: {
      passed: 'пройден',
      failed: 'провален',
      skipped: 'пропущен',
      blocked: 'заблокирован',
      unknown: 'не проверялся',
    },
    mode: {
      run: 'прогон агентом',
      generate: 'генерация',
      explore: 'исследование',
      automate: 'автоматизация',
      manual: 'ручной проход',
      import: 'импорт из CI',
    },
    panelAutotests: 'автотесты панели',
    actor: { agent: 'агент', human: 'человек', ci: 'CI' },
    state: { running: 'ещё идёт', stopped: 'прерван', error: 'сорвался' },
    finishedState: 'завершён',
    columns: [
      'Кейс',
      'ID',
      'Группа',
      'Статус',
      'Параметры',
      'Секунд',
      'Что увидели',
      'Вложения',
      'Дефекты',
    ],
    recordColumn: 'Запись',
    unwalked: 'не пройден',
    heading: 'Прогон',
    pageTitle: 'Прогон тестов',
    started: 'Начат',
    finished: 'Завершён',
    neverFinished: 'не завершался',
    stateLabel: 'Состояние',
    actorLabel: 'Исполнитель',
    branch: 'Ветка',
    commit: 'Коммит',
    environment: 'Окружение',
    plan: 'План',
    tokens: 'Токенов',
    broke: 'Сорвался',
    summary: 'Итог',
    failedHeading: 'Что упало',
    noFailures: 'Провалов нет.',
    unwalkedHeading: 'Не пройдены',
    passesHeading: 'Проходы',
    noResults: 'Результатов в записи нет.',
    attachments: 'вложения',
    summaryLine: ({ passed, failed, skipped, blocked, total }) =>
      `пройдено ${passed} · провалено ${failed} · пропущено ${skipped} · ` +
      `заблокировано ${blocked} (всего ${total})`,
    unwalkedTail: (open, planned) => ` · не пройдено ${open} из ${planned} задуманных`,
    step: (step) => `шаг ${step}: `,
    expected: (text) => ` (ожидалось: ${text})`,
    failure: 'провал',
    flaky: (attempts) => `прошёл только на повторе (упавших попыток: ${attempts})`,
  },
  en: {
    status: {
      passed: 'passed',
      failed: 'failed',
      skipped: 'skipped',
      blocked: 'blocked',
      unknown: 'not checked',
    },
    mode: {
      run: 'agent run',
      generate: 'generation',
      explore: 'exploration',
      automate: 'automation',
      manual: 'manual pass',
      import: 'import from CI',
    },
    panelAutotests: 'panel autotests',
    actor: { agent: 'agent', human: 'person', ci: 'CI' },
    state: { running: 'still running', stopped: 'stopped', error: 'broke down' },
    finishedState: 'finished',
    columns: [
      'Case',
      'ID',
      'Group',
      'Status',
      'Parameters',
      'Seconds',
      'What was seen',
      'Attachments',
      'Defects',
    ],
    recordColumn: 'Record',
    unwalked: 'not walked',
    heading: 'Run',
    pageTitle: 'Test run',
    started: 'Started',
    finished: 'Finished',
    neverFinished: 'never finished',
    stateLabel: 'State',
    actorLabel: 'Executor',
    branch: 'Branch',
    commit: 'Commit',
    environment: 'Environment',
    plan: 'Plan',
    tokens: 'Tokens',
    broke: 'Broke down',
    summary: 'Summary',
    failedHeading: 'What failed',
    noFailures: 'No failures.',
    unwalkedHeading: 'Not walked',
    passesHeading: 'Passes',
    noResults: 'The record has no results.',
    attachments: 'attachments',
    summaryLine: ({ passed, failed, skipped, blocked, total }) =>
      `passed ${passed} · failed ${failed} · skipped ${skipped} · ` +
      `blocked ${blocked} (total ${total})`,
    unwalkedTail: (open, planned) => ` · not walked ${open} of ${planned} planned`,
    step: (step) => `step ${step}: `,
    expected: (text) => ` (expected: ${text})`,
    failure: 'failure',
    flaky: (attempts) => `passed only on a retry (failed attempts: ${attempts})`,
  },
};
