import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';

/**
 * Документы готовности вехи для проверки выгрузки на двух языках.
 *
 * `fullRelease` заполняет каждую ветку вёрстки: ветку и коммит, оговорку
 * трекера, карантин, все важности, дефект без заголовка и с неспрошенным статусом,
 * требования всех четырёх состояний (одно с `|` в названии) и прогоны трёх
 * видов с тремя исполнителями. `emptyRelease` — каждый пустой раздел.
 * Русский вывод обоих сверяется байт в байт с тем, что выгрузка отдавала до
 * двух языков (`release-export.ru.txt`).
 */

export const emptyRelease: ProjectTestReleaseDocument = {
  release: '1.4',
  generatedAt: '2026-09-08T12:00:00.000Z',
  verdict: {
    ready: false,
    text: 'Веха «1.4»: отдавать рано. Прогонов вехи нет: проверять нечего.',
    blockers: ['Прогонов вехи нет: проверять нечего.'],
  },
  totals: {
    cases: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    untested: 0,
    muted: 0,
    runs: 0,
  },
  requirements: [],
  red: [],
  untested: [],
  muted: [],
  defects: [],
  runs: [],
};

export const fullRelease: ProjectTestReleaseDocument = {
  release: 'Релиз 2.0',
  generatedAt: '2026-09-08T12:00:00.000Z',
  branch: 'release/2.0',
  commit: '0123456789abcdef0123',
  verdict: {
    ready: false,
    text:
      'Веха «Релиз 2.0»: отдавать рано. Провалов: 1. Заблокировано кейсов: 1. ' +
      'Не проверено кейсов: 2 из 8. Незакрытых дефектов: 2. ' +
      'В карантине 1 — их провалы в вердикт не идут.',
    blockers: [
      'Провалов: 1.',
      'Заблокировано кейсов: 1.',
      'Не проверено кейсов: 2 из 8.',
      'Незакрытых дефектов: 2.',
    ],
  },
  totals: {
    cases: 8,
    passed: 2,
    failed: 1,
    blocked: 1,
    skipped: 1,
    untested: 2,
    muted: 1,
    runs: 3,
  },
  requirements: [
    {
      key: 'QA-1',
      title: 'Вход | по паролю',
      cases: 2,
      passed: 1,
      failed: 1,
      untested: 0,
      state: 'red',
    },
    { key: 'QA-2', cases: 0, passed: 0, failed: 0, untested: 0, state: 'uncovered' },
    {
      key: 'QA-3',
      title: 'Выход',
      cases: 2,
      passed: 1,
      failed: 0,
      untested: 1,
      state: 'partial',
    },
    {
      key: 'QA-4',
      title: 'Профиль',
      cases: 1,
      passed: 1,
      failed: 0,
      untested: 0,
      state: 'covered',
    },
  ],
  red: [
    {
      groupId: 'gui',
      caseId: 'a',
      title: 'Вход',
      priority: 'blocker',
      status: 'failed',
      note: 'ошибка <b>500</b>',
    },
    { groupId: 'gui', caseId: 'b', title: 'Оплата', priority: 'high', status: 'blocked' },
  ],
  untested: [
    { groupId: 'gui', caseId: 'c', title: 'Выход', priority: 'medium', status: 'unknown' },
    { groupId: 'api', caseId: 'd', title: 'Токен', status: 'unknown' },
  ],
  muted: [
    {
      groupId: 'api',
      caseId: 'e',
      title: 'Поиск',
      priority: 'low',
      status: 'failed',
      muted: true,
      muteReason: 'флакает на CI',
    },
  ],
  defects: [
    {
      url: 'https://jira/browse/QA-7',
      title: 'Логин падает',
      state: 'open',
      groupId: 'gui',
      caseId: 'a',
      caseTitle: 'Вход',
    },
    {
      url: 'https://jira/browse/QA-8',
      key: 'QA-8',
      state: 'unknown',
      groupId: 'gui',
      caseId: 'b',
      caseTitle: 'Оплата',
    },
  ],
  runs: [
    {
      id: 'run-1',
      mode: 'run',
      actor: 'agent',
      startedAt: '2026-09-08T10:00:00.000Z',
      branch: 'release/2.0',
      summary: { total: 4, passed: 1, failed: 1, skipped: 1, blocked: 1 },
    },
    {
      id: 'run-2',
      mode: 'manual',
      actor: 'human',
      startedAt: '2026-09-07T10:00:00.000Z',
      environmentId: 'stage',
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
    },
    {
      id: 'run-3',
      mode: 'import',
      actor: 'ci',
      startedAt: '2026-09-06T10:00:00.000Z',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    },
  ],
  warning: 'Atlassian не подключён: показаны только требования из ссылок кейсов.',
  warningCode: 'coverage-atlassian-off',
};
