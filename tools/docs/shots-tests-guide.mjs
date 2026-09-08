/**
 * Кадры для руководства «Тестовый контур» (.agent/tests-guide, вне git).
 *
 * Данные подменяются целиком — как в проверках `tools/qa/`: ни агента, ни
 * настоящего прогона съёмка не заводит, в кадр не попадают ни личные проекты, ни
 * пути с машины. Поэтому руководство пересобирается на любой машине и выглядит
 * одинаково, а показанный проект «Витрина» вымышлен от первого до последнего кейса.
 *
 * Порядок кадров — порядок рабочего дня: пустой проект → соглашение → пульт →
 * генерация → библиотека → план → прогон → ручной проход → дефект → история →
 * отчёт → покрытие → обмен.
 *
 * Запуск: `node tools/docs/shots-tests-guide.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bypassOnboarding } from '../qa/bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT = process.env.OUT ?? join(process.cwd(), '.agent', 'tests-guide', 'shots');

const PROJECT = { name: 'Витрина', path: 'C:/demo/shop' };

const step = (action, expected, data) => ({ action, expected, ...(data ? { data } : {}) });

const testCase = (id, title, patch = {}) => ({
  id,
  type: 'case',
  title,
  steps: [step('открыть каталог', 'список товаров показан')],
  expected: 'товар в корзине',
  priority: 'medium',
  readiness: 'ready',
  source: 'agent',
  status: 'unknown',
  tags: [],
  ...patch,
});

/** Группы = файлы в `.agent/tests/`: вкладка на файл, счётчик в названии. */
const GROUPS = [
  {
    id: 'smoke',
    title: 'Смоук',
    description: 'Пятнадцать минут перед выкладкой: без этих кейсов релиз не уезжает.',
    file: '.agent/tests/smoke.tests.json',
    cases: [
      testCase('smoke-001', 'Вход по паролю', {
        section: 'Вход',
        area: 'вход',
        priority: 'blocker',
        purpose: 'Дверь в приложение: пока она закрыта, остальные кейсы бессмысленны.',
        precondition: 'Есть учётная запись покупателя, корзина пуста.',
        steps: [
          step('открыть /login', 'форма входа показана'),
          step('ввести почту и пароль', 'кнопка «Войти» стала активной', 'demo@shop / %пароль'),
          step('нажать «Войти»', 'открылась витрина, в шапке имя покупателя'),
        ],
        expected: 'покупатель внутри, в шапке его имя',
        oracle: 'В шапке текст «Здравствуйте, Дмитрий»; в сети — 200 на POST /api/session.',
        duration: 2,
        tags: ['смоук', 'вход'],
        codePaths: ['src/features/Login/', 'server/routes/session.ts'],
        parameters: [{ name: 'пароль', values: ['верный', 'с пробелом в конце'] }],
        links: [
          {
            type: 'requirement',
            url: 'https://jira.example/browse/SHOP-14',
            title: 'Вход по паролю',
          },
        ],
        status: 'passed',
        lastRunAt: '2026-09-08T09:12:00.000Z',
        lastRunId: 'run-4',
      }),
      testCase('smoke-002', 'Товар кладётся в корзину', {
        section: 'Корзина',
        area: 'корзина',
        priority: 'high',
        steps: [
          step('открыть карточку товара', 'карточка открылась'),
          step('нажать «В корзину»', 'счётчик корзины стал 1'),
        ],
        expected: 'счётчик корзины показывает 1',
        oracle: 'Счётчик в шапке и запись в /api/cart.',
        duration: 3,
        tags: ['смоук', 'корзина'],
        codePaths: ['src/features/Cart/'],
        links: [{ type: 'requirement', url: 'https://jira.example/browse/SHOP-15' }],
        status: 'failed',
        note: 'счётчик остался нулём, в консоли 500 на POST /api/cart',
        lastRunAt: '2026-09-08T09:14:00.000Z',
        lastRunId: 'run-4',
        defects: [
          {
            url: 'https://jira.example/browse/SHOP-231',
            title: 'Корзина не принимает товар',
            state: 'open',
          },
        ],
      }),
      testCase('smoke-003', 'Оплата картой', {
        section: 'Оплата',
        area: 'оплата',
        priority: 'blocker',
        steps: [
          step('перейти к оплате', 'форма карты показана'),
          step('оплатить тестовой картой', 'заказ создан'),
        ],
        expected: 'заказ создан, письмо ушло',
        oracle: 'Номер заказа на экране и запись в /api/orders.',
        duration: 5,
        tags: ['смоук', 'оплата'],
        status: 'blocked',
        note: 'платёжная песочница не отвечает',
        muted: true,
        muteReason: 'песочница платежей лежит с 05.09, ждём ответа провайдера',
        lastRunAt: '2026-09-08T09:16:00.000Z',
      }),
      testCase('smoke-004', 'Поиск по каталогу', {
        section: 'Каталог',
        area: 'каталог',
        priority: 'medium',
        duration: 2,
        tags: ['смоук'],
        automation: {
          status: 'automated',
          file: 'e2e/catalog.spec.ts',
          testName: 'каталог: поиск по названию',
          externalId: 'shop-004',
        },
        status: 'passed',
        lastRunAt: '2026-09-08T09:18:00.000Z',
      }),
      testCase('smoke-005', 'Пустая корзина не оформляется', {
        section: 'Корзина',
        area: 'корзина',
        type: 'checklist',
        priority: 'low',
        readiness: 'draft',
        steps: [step('открыть пустую корзину'), step('проверить кнопку «Оформить»')],
        status: 'unknown',
      }),
    ],
  },
  {
    id: 'gui',
    title: 'Интерфейс',
    description: 'Экраны витрины: вёрстка, состояния, клавиатура.',
    file: '.agent/tests/gui.tests.json',
    cases: [
      testCase('gui-001', 'Карточка товара на узком экране', {
        section: 'Каталог',
        area: 'каталог',
        priority: 'medium',
        duration: 4,
        status: 'passed',
      }),
      testCase('gui-002', 'Корзина закрывается по Escape', {
        section: 'Корзина',
        area: 'корзина',
        priority: 'low',
        duration: 1,
        status: 'unknown',
      }),
    ],
  },
  {
    id: 'api',
    title: 'API',
    description: 'Контракт сервера: коды ответов, ошибки, права.',
    file: '.agent/tests/api.tests.json',
    cases: [
      testCase('api-001', 'POST /api/cart без входа отвечает 401', {
        area: 'корзина',
        priority: 'high',
        duration: 1,
        status: 'passed',
      }),
    ],
  },
];

const ENVIRONMENTS = [
  {
    id: 'local',
    title: 'Локальный стенд',
    baseUrl: 'http://localhost:3000',
    browser: 'Chromium',
    os: 'Windows 11',
    start: 'pnpm dev',
    isDefault: true,
  },
  {
    id: 'staging',
    title: 'Предпрод',
    baseUrl: 'https://staging.shop.example',
    browser: 'Chromium',
    notes: 'Данные обновляются ночью, оплата в песочнице.',
  },
];

const VIEWS = [
  {
    id: 'blockers',
    title: 'Блокеры под релиз',
    filter: { priorities: ['blocker'], statuses: ['failed', 'unknown'] },
  },
  { id: 'cart', title: 'Всё про корзину', filter: { areas: ['корзина'] } },
];

const PLANS = [
  {
    id: 'release-1-4',
    title: 'Приёмка релиза 1.4',
    product: 'Витрина',
    version: '1.4',
    description: 'Что должно быть зелёным, чтобы релиз уехал.',
    from: '2026-09-07',
    to: '2026-09-09',
    caseIds: ['smoke-001', 'smoke-002', 'smoke-003', 'gui-001'],
    environmentIds: ['local', 'staging'],
    createdAt: '2026-09-07T08:00:00.000Z',
  },
  {
    id: 'cart-regression',
    title: 'Регрессия корзины',
    description: 'Динамический набор: всё, что помечено зоной «корзина».',
    filter: { areas: ['корзина'] },
    environmentIds: ['local'],
    createdAt: '2026-09-06T08:00:00.000Z',
  },
];

const summary = (passed, failed, skipped, blocked) => ({
  total: passed + failed + skipped + blocked,
  passed,
  failed,
  skipped,
  blocked,
});

const pointResult = (caseId, status, patch = {}) => ({
  pointId: `smoke:${caseId}:local`,
  groupId: 'smoke',
  caseId,
  environmentId: 'local',
  status,
  ...patch,
});

const RUNS = [
  {
    id: 'run-4',
    mode: 'run',
    actor: 'agent',
    groupId: 'smoke',
    environmentId: 'local',
    branch: 'release/1.4',
    commit: '9c1f4ab2d0e7',
    release: 'v1.4',
    status: 'done',
    startedAt: '2026-09-08T09:10:00.000Z',
    finishedAt: '2026-09-08T09:19:00.000Z',
    tokens: 84_000,
    costUsd: 0.62,
    sessionId: 'session-demo',
    results: [
      pointResult('smoke-001', 'passed', { startedAt: '2026-09-08T09:12:00.000Z' }),
      pointResult('smoke-002', 'failed', {
        note: 'счётчик остался нулём, в консоли 500 на POST /api/cart',
        attachments: ['.agent/tests/attachments/smoke-002/cart-500.png'],
      }),
      pointResult('smoke-003', 'blocked', { note: 'песочница платежей не отвечает' }),
      pointResult('smoke-004', 'passed'),
    ],
    summary: summary(2, 1, 0, 1),
  },
  {
    id: 'run-3',
    mode: 'manual',
    actor: 'human',
    groupId: 'smoke',
    environmentId: 'staging',
    branch: 'release/1.4',
    release: 'v1.4',
    status: 'done',
    startedAt: '2026-09-07T15:00:00.000Z',
    finishedAt: '2026-09-07T15:38:00.000Z',
    results: [],
    summary: summary(4, 1, 0, 0),
  },
  {
    id: 'run-2',
    mode: 'import',
    actor: 'ci',
    branch: 'main',
    status: 'done',
    startedAt: '2026-09-07T04:12:00.000Z',
    finishedAt: '2026-09-07T04:13:00.000Z',
    results: [],
    summary: summary(38, 2, 1, 0),
  },
  {
    id: 'run-1',
    mode: 'generate',
    actor: 'agent',
    groupId: 'smoke',
    branch: 'main',
    status: 'done',
    startedAt: '2026-09-06T11:00:00.000Z',
    finishedAt: '2026-09-06T11:07:00.000Z',
    tokens: 51_000,
    costUsd: 0.38,
    results: [],
    summary: summary(0, 0, 0, 0),
  },
];

const REPORT = {
  runs: RUNS,
  areas: [
    { area: 'корзина', total: 9, passed: 6, failed: 2, unknown: 1 },
    { area: 'оплата', total: 6, passed: 4, failed: 0, unknown: 2 },
    { area: 'каталог', total: 7, passed: 7, failed: 0, unknown: 0 },
    { area: 'вход', total: 4, passed: 4, failed: 0, unknown: 0 },
  ],
  automation: { manual: 14, toAutomate: 5, automated: 7 },
  flaky: [
    {
      caseId: 'smoke-002',
      groupId: 'smoke',
      title: 'Товар кладётся в корзину',
      stability: 45,
      runs: 11,
      flips: 6,
    },
    {
      caseId: 'gui-002',
      groupId: 'gui',
      title: 'Корзина закрывается по Escape',
      stability: 72,
      runs: 8,
      flips: 2,
    },
  ],
  failures: [
    {
      reason: '500 на POST /api/cart',
      count: 3,
      cases: [
        { groupId: 'smoke', caseId: 'smoke-002', title: 'Товар кладётся в корзину' },
        { groupId: 'gui', caseId: 'gui-002', title: 'Корзина закрывается по Escape' },
      ],
      lastSeenAt: '2026-09-08T09:14:00.000Z',
    },
    {
      reason: 'песочница платежей не отвечает',
      count: 1,
      cases: [{ groupId: 'smoke', caseId: 'smoke-003', title: 'Оплата картой' }],
      lastSeenAt: '2026-09-08T09:16:00.000Z',
    },
  ],
  releases: [
    {
      release: 'v1.4',
      runs: 2,
      passed: 6,
      failed: 2,
      untested: 3,
      lastRunAt: '2026-09-08T09:19:00.000Z',
    },
    {
      release: 'v1.3',
      runs: 5,
      passed: 21,
      failed: 0,
      untested: 0,
      lastRunAt: '2026-08-28T16:40:00.000Z',
    },
  ],
  totals: {
    runs: 4,
    tokens: 135_000,
    costUsd: 1.0,
    durationMs: 3_360_000,
    lastRunAt: '2026-09-08T09:19:00.000Z',
    muted: 1,
  },
};

const coverageCase = (caseId, title, status, patch = {}) => ({
  groupId: 'smoke',
  caseId,
  title,
  status,
  lastRunAt: '2026-09-08T09:19:00.000Z',
  ...patch,
});

const COVERAGE = {
  source: 'jira',
  jql: 'project = SHOP AND fixVersion = 1.4',
  items: [
    {
      key: 'SHOP-14',
      url: 'https://jira.example/browse/SHOP-14',
      title: 'Вход по паролю',
      status: 'Готово',
      cases: [coverageCase('smoke-001', 'Вход по паролю', 'passed')],
      counts: { passed: 1, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
    },
    {
      key: 'SHOP-15',
      url: 'https://jira.example/browse/SHOP-15',
      title: 'Корзина: добавление товара',
      status: 'В работе',
      cases: [coverageCase('smoke-002', 'Товар кладётся в корзину', 'failed')],
      counts: { passed: 0, failed: 1, blocked: 0, skipped: 0, unknown: 0 },
    },
    {
      key: 'SHOP-19',
      url: 'https://jira.example/browse/SHOP-19',
      title: 'Промокод на первый заказ',
      status: 'В работе',
      cases: [],
      counts: { passed: 0, failed: 0, blocked: 0, skipped: 0, unknown: 0 },
    },
  ],
  orphans: [
    coverageCase('smoke-004', 'Поиск по каталогу', 'passed'),
    coverageCase('gui-001', 'Карточка товара на узком экране', 'passed', { groupId: 'gui' }),
  ],
};

const IMPACT = {
  files: ['src/features/Cart/CartButton.tsx', 'server/routes/cart.ts'],
  cases: [
    {
      groupId: 'smoke',
      caseId: 'smoke-002',
      title: 'Товар кладётся в корзину',
      reason: 'codePaths: src/features/Cart/',
    },
  ],
};

const LINKS = {
  project: {
    jiraProjectKey: 'SHOP',
    jiraIssueKey: 'SHOP-12',
    jiraIssueTitle: 'Релиз 1.4',
    confluencePageTitle: 'Витрина · отчёты о тестировании',
    confluencePageId: '11223344',
  },
  groups: {},
};

/** Здоровье набора: замечания линтера и похожие кейсы. */
const LINT = {
  findings: [
    {
      rule: 'no-oracle',
      severity: 'warning',
      groupId: 'smoke',
      caseId: 'smoke-004',
      title: 'Оплата картой проходит',
      message: 'Нет оракула: по чему судить о результате, кроме слова «получилось».',
    },
    {
      rule: 'step-without-expected',
      severity: 'warning',
      groupId: 'gui',
      caseId: 'gui-002',
      title: 'Поиск по каталогу',
      message: 'Шаг 2 без ожидания: пройти по нему можно как угодно.',
    },
    {
      rule: 'not-run',
      severity: 'info',
      groupId: 'gui',
      caseId: 'gui-003',
      title: 'Фильтр по цене',
      message: 'Не гонялся 96 дней: показанный статус давно ничего не доказывает.',
    },
  ],
  byRule: [
    { rule: 'no-oracle', severity: 'warning', title: 'Нет оракула', count: 1 },
    { rule: 'step-without-expected', severity: 'warning', title: 'Шаг без ожидания', count: 1 },
    { rule: 'not-run', severity: 'info', title: 'Давно не гонялся', count: 1 },
  ],
  duplicates: [
    {
      groupId: 'gui',
      caseId: 'gui-004',
      title: 'Товар добавляется в корзину со страницы каталога',
      similar: [
        {
          groupId: 'smoke',
          caseId: 'smoke-002',
          title: 'Товар кладётся в корзину',
          score: 0.86,
        },
      ],
    },
  ],
  checked: 12,
  checkedAt: '2026-09-08T10:20:00.000Z',
};

/** Карантин: кого пора выпускать, кого пора прятать, что устарело. */
const QUARANTINE = {
  lift: [
    {
      kind: 'lift',
      groupId: 'smoke',
      caseId: 'smoke-003',
      title: 'Оформление заказа',
      message: 'Зелёных подряд: 5 при пороге 5. Поломка больше не воспроизводится.',
      muteReason: 'ждём починки песочницы платежей',
      stability: 100,
      runs: 7,
      greenStreak: 5,
    },
  ],
  quarantine: [
    {
      kind: 'quarantine',
      groupId: 'gui',
      caseId: 'gui-002',
      title: 'Поиск по каталогу',
      message: 'Стабильность 40% на 5 результатах при пороге 70%.',
      reason: 'Нестабилен: стабильность 40% на 5 результатах.',
      stability: 40,
      runs: 5,
      greenStreak: 0,
    },
  ],
  stale: [
    {
      groupId: 'smoke',
      caseId: 'smoke-001',
      title: 'Вход по паролю',
      key: 'SHOP-14',
      url: 'https://jira.example/browse/SHOP-14',
      requirementUpdatedAt: '2026-09-05T00:00:00.000Z',
      caseUpdatedAt: '2026-08-12T00:00:00.000Z',
      days: 24,
    },
  ],
  thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
  checkedAt: '2026-09-08T10:20:00.000Z',
};

/** Риск и время: чем гонять первым, когда времени час. */
const RISK = {
  items: [
    {
      groupId: 'smoke',
      caseId: 'smoke-002',
      key: 'smoke:smoke-002',
      title: 'Товар кладётся в корзину',
      score: 78,
      factors: [
        { key: 'priority', value: 0.8, note: 'важность high' },
        { key: 'outcome', value: 1, note: 'последний прогон красный' },
        { key: 'instability', value: 0.8, note: 'стабильность 60% на 5' },
        { key: 'age', value: 0.5, note: 'не гоняли 1 дн.' },
        { key: 'impact', value: 1, note: 'задет правками: изменён src/features/Cart/' },
      ],
      reason: 'последний прогон красный; задет правками: изменён src/features/Cart/',
      duration: 3,
      hasDuration: true,
      priority: 'high',
      status: 'failed',
    },
    {
      groupId: 'smoke',
      caseId: 'smoke-004',
      key: 'smoke:smoke-004',
      title: 'Оплата картой проходит',
      score: 64,
      factors: [
        { key: 'priority', value: 1, note: 'важность blocker' },
        { key: 'outcome', value: 0.8, note: 'ещё не проверялся' },
        { key: 'instability', value: 0.8, note: 'истории прогонов нет' },
        { key: 'age', value: 1, note: 'не гоняли ни разу' },
        { key: 'impact', value: 0.8, note: 'правки не задели' },
      ],
      reason: 'ещё не проверялся; истории прогонов нет',
      duration: 5,
      hasDuration: false,
      priority: 'blocker',
      status: 'unknown',
    },
    {
      groupId: 'smoke',
      caseId: 'smoke-001',
      key: 'smoke:smoke-001',
      title: 'Вход по паролю',
      score: 41,
      factors: [
        { key: 'priority', value: 1, note: 'важность blocker' },
        { key: 'outcome', value: 0.4, note: 'последний прогон зелёный' },
        { key: 'instability', value: 0.4, note: 'стабильность 100% на 6' },
        { key: 'age', value: 0.4, note: 'гоняли сегодня' },
        { key: 'impact', value: 0.8, note: 'правки не задели' },
      ],
      reason: 'важность blocker; стабильность 100% на 6',
      duration: 2,
      hasDuration: true,
      priority: 'blocker',
      status: 'passed',
    },
  ],
  checkedAt: '2026-09-08T10:20:00.000Z',
};

/** Документ готовности вехи: сначала вердикт, потом чем он доказан. */
const RELEASE_DOCUMENT = {
  release: 'v1.4',
  generatedAt: '2026-09-08T10:20:00.000Z',
  branch: 'release/1.4',
  commit: '9c1f4ab2d0e7',
  verdict: {
    ready: false,
    text: 'Веха «v1.4»: отдавать рано. Провалов: 1. Не проверено кейсов: 1 из 12. Незакрытых дефектов: 1.',
    blockers: ['Провалов: 1.', 'Не проверено кейсов: 1 из 12.', 'Незакрытых дефектов: 1.'],
  },
  totals: {
    cases: 12,
    passed: 9,
    failed: 1,
    blocked: 1,
    skipped: 0,
    untested: 1,
    muted: 1,
    runs: 3,
  },
  requirements: [
    {
      key: 'SHOP-15',
      title: 'Корзина',
      url: 'https://jira.example/browse/SHOP-15',
      cases: 3,
      passed: 2,
      failed: 1,
      untested: 0,
      state: 'red',
    },
    {
      key: 'SHOP-14',
      title: 'Вход по паролю',
      url: 'https://jira.example/browse/SHOP-14',
      cases: 2,
      passed: 2,
      failed: 0,
      untested: 0,
      state: 'green',
    },
  ],
  red: [
    {
      groupId: 'smoke',
      caseId: 'smoke-002',
      title: 'Товар кладётся в корзину',
      priority: 'high',
      status: 'failed',
      note: 'счётчик остался нулём, в консоли 500 на POST /api/cart',
    },
    {
      groupId: 'smoke',
      caseId: 'smoke-003',
      title: 'Оформление заказа',
      priority: 'blocker',
      status: 'blocked',
      note: 'песочница платежей не отвечает',
    },
  ],
  untested: [
    {
      groupId: 'gui',
      caseId: 'gui-003',
      title: 'Фильтр по цене',
      status: 'unknown',
    },
  ],
  muted: [
    {
      groupId: 'gui',
      caseId: 'gui-002',
      title: 'Поиск по каталогу',
      status: 'failed',
      muteReason: 'нестабилен, ждём починки индексации',
    },
  ],
  defects: [
    {
      url: 'https://jira.example/browse/SHOP-91',
      title: 'Корзина не принимает товар: 500 на POST /api/cart',
      key: 'SHOP-91',
      state: 'open',
      groupId: 'smoke',
      caseId: 'smoke-002',
      caseTitle: 'Товар кладётся в корзину',
    },
  ],
  runs: [
    {
      id: 'run-4',
      mode: 'run',
      actor: 'agent',
      startedAt: '2026-09-08T09:10:00.000Z',
      branch: 'release/1.4',
      commit: '9c1f4ab2d0e7',
      summary: summary(2, 1, 0, 1),
    },
  ],
};

/** Сравнение двух прогонов: пять непересекающихся списков. */
const runSide = (record) => ({
  id: record.id,
  startedAt: record.startedAt,
  mode: record.mode,
  environmentId: record.environmentId,
  summary: record.summary,
});

const diffCase = (caseId, title, from, to, note) => ({
  groupId: 'smoke',
  caseId,
  title,
  from,
  to,
  ...(note ? { note } : {}),
});

const RUN_DIFF = {
  from: runSide(RUNS[1]),
  to: runSide(RUNS[0]),
  newFailures: [
    diffCase(
      'smoke-002',
      'Товар кладётся в корзину',
      'passed',
      'failed',
      'счётчик остался нулём, 500 на POST /api/cart',
    ),
  ],
  fixed: [diffCase('smoke-005', 'Купон применяется к заказу', 'failed', 'passed')],
  stillFailing: [
    diffCase('smoke-003', 'Оформление заказа', 'blocked', 'blocked', 'песочница платежей молчит'),
  ],
  untouched: [diffCase('smoke-001', 'Вход по паролю', 'passed', 'passed')],
  added: [diffCase('gui-004', 'Товар добавляется со страницы каталога', undefined, 'passed')],
  removed: [diffCase('gui-005', 'Смена языка витрины', 'passed', undefined)],
  comparable: true,
};

/** Черновик генерации: кейсы предложены, но в файлы ещё не попали. */
const DRAFT_ITEMS = [
  {
    op: 'add',
    groupId: 'smoke',
    caseId: 'smoke-101',
    testCase: {
      id: 'smoke-101',
      type: 'case',
      title: 'Корзина переживает перезагрузку страницы',
      steps: [
        step('положить товар в корзину', 'счётчик показывает 1'),
        step('перезагрузить страницу', 'счётчик по-прежнему 1'),
      ],
      expected: 'товар остался в корзине',
      oracle: 'Счётчик в шапке и GET /api/cart после перезагрузки.',
      priority: 'high',
      status: 'unknown',
      source: 'agent',
    },
    reason: 'требование SHOP-15 говорит о сохранении корзины, кейса на это нет',
    state: 'pending',
  },
  {
    op: 'add',
    groupId: 'smoke',
    caseId: 'smoke-102',
    testCase: {
      id: 'smoke-102',
      type: 'case',
      title: 'Товар кладётся в корзину из карточки',
      steps: [step('нажать «В корзину» в карточке', 'счётчик стал 1')],
      expected: 'счётчик корзины показывает 1',
      priority: 'medium',
      status: 'unknown',
      source: 'agent',
    },
    reason: 'негативных проверок корзины меньше, чем положительных',
    similarTo: [
      {
        groupId: 'smoke',
        caseId: 'smoke-002',
        title: 'Товар кладётся в корзину',
        score: 0.84,
      },
    ],
    state: 'pending',
  },
];

const DRAFT = {
  version: 1,
  runId: 'run-5',
  source: 'requirement',
  createdAt: '2026-09-08T10:05:00.000Z',
  file: '.agent/tests/drafts/run-5.draft.json',
  status: 'pending',
  items: DRAFT_ITEMS,
};

const DRAFT_SUMMARY = {
  runId: DRAFT.runId,
  createdAt: DRAFT.createdAt,
  source: DRAFT.source,
  status: DRAFT.status,
  file: DRAFT.file,
  total: DRAFT.items.length,
  pending: DRAFT.items.length,
  accepted: 0,
  rejected: 0,
};

/** Ручной проход: те же кейсы, развёрнутые до проходов на выбранном окружении. */
const MANUAL_POINTS = GROUPS[0].cases.slice(0, 4).map((item) => ({
  id: `smoke:${item.id}:local`,
  groupId: 'smoke',
  caseId: item.id,
  title: item.title,
  environmentId: 'local',
  priority: item.priority,
  duration: item.duration,
  status: 'unknown',
}));

const DEFECT_DRAFT = {
  title: 'Товар не кладётся в корзину: 500 на POST /api/cart',
  body: [
    '**Кейс:** smoke-002 «Товар кладётся в корзину» (группа «Смоук»)',
    '**Окружение:** Локальный стенд · http://localhost:3000',
    '**Ветка:** release/1.4 · 9c1f4ab',
    '',
    '**Шаги**',
    '1. открыть карточку товара — карточка открылась',
    '2. нажать «В корзину» — счётчик корзины стал 1',
    '',
    '**Ожидалось:** счётчик корзины показывает 1',
    '**Получилось:** счётчик остался нулём, в консоли 500 на POST /api/cart',
    '',
    '**Доказательство:** .agent/tests/attachments/smoke-002/cart-500.png',
  ].join('\n'),
  targets: ['github', 'gitlab'],
  hint: 'gh 2.55.0 в PATH',
};

/** Снимок раздела: он же ответ `GET /api/project-tests`. Меняется по ходу съёмки. */
let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: false,
  groups: [],
  sharedSteps: [
    {
      id: 'login',
      title: 'Войти покупателем',
      steps: [
        step('открыть /login', 'форма входа показана'),
        step('ввести почту и пароль', 'кнопка «Войти» активна'),
        step('нажать «Войти»', 'открылась витрина'),
      ],
      description: 'Начало почти каждого кейса витрины.',
    },
  ],
  environments: ENVIRONMENTS,
  schema: {
    attributes: [
      { key: 'layer', title: 'Слой', type: 'select', options: ['витрина', 'сервер', 'оплата'] },
    ],
    statuses: [],
  },
  views: VIEWS,
  plans: PLANS,
  branch: 'release/1.4',
  commit: '9c1f4ab2d0e7',
};

let manualSession;

// Каталог кадров пересоздаётся: кадр, выпавший из руководства, иначе остаётся
// лежать под старым именем и однажды попадает в вёрстку вместо нового.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
/** Одно окно на все кадры: по нему же считаются клипы, чтобы кадр не выходил за край. */
const VIEWPORT = { width: 1500, height: 950 };

const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await bypassOnboarding(page);

// Ошибка страницы посреди съёмки даёт пустой кадр вместо экрана — и молча.
page.on('pageerror', (error) => console.log(`ОШИБКА СТРАНИЦЫ: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`ОШИБКА В КОНСОЛИ: ${message.text()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) console.log(`${response.status()} ← ${response.url()}`);
});

const taken = [];
const shot = async (name, target, clip) => {
  const file = join(OUT, `${name}.png`);
  await (target ?? page).screenshot({ path: file, ...(clip ? { clip } : {}) });
  taken.push(name);
  console.log(`снят ${name}`);
};

/** Кадр по видимой рамке блока с полями: целый экран показал бы половину пустоты. */
const shotAround = async (
  locator,
  { padX = 24, padTop = 28, height, width, wide = true, left, toTop = false } = {},
) => {
  // Прокрутка ждёт «устойчивости» элемента, а раздел живой: список перерисовывается
  // по опросу. Не доехали — снимаем как есть, кадр от этого не пропадает.
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  // Длинный блок надо ставить к верхнему краю: «доведён до видимости» у него значит
  // «виден нижней строкой», и высокий кадр уехал бы вверх, к соседней карточке.
  if (toTop) {
    await locator
      .evaluate((node) => {
        node.scrollIntoView({ block: 'start' });
        // «В начало» ставит блок вплотную к краю, и подпись над ним срезается
        // пополам. Отматываем тот контейнер, который на странице и прокручивается.
        let box = node.parentElement;
        while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
        if (box) box.scrollTop = Math.max(0, box.scrollTop - 60);
      })
      .catch(() => undefined);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(400);
  const box = await locator.boundingBox();
  const x = Math.max(0, left ?? box.x - padX);
  let frameHeight = height ?? box.height + padTop + 16;
  // Клип у обычного снимка считается от окна, а не от страницы: липкая полоса
  // стоит у нижнего края, и кадр «вниз от неё» Playwright обрезал бы до полоски.
  let y = Math.max(0, box.y - padTop);
  if (y + frameHeight > VIEWPORT.height) y = Math.max(0, VIEWPORT.height - frameHeight);
  frameHeight = Math.min(frameHeight, VIEWPORT.height - y);
  return {
    x,
    y,
    // По умолчанию кадр берётся до правого края: якорь у полосы — поле ввода, и
    // по его ширине обрезалась бы ровно та половина, ради которой кадр и нужен.
    width:
      width ??
      (wide ? VIEWPORT.width - x - 16 : Math.min(VIEWPORT.width - x, box.width + padX * 2)),
    height: frameHeight,
  };
};

/**
 * Кадр окна по содержимому: у модалок высота фиксированная, и снятое «как есть»
 * окно на треть состоит из пустоты — в PDF это полупустая страница.
 */
const shotDialog = async (name, dialog, tail) => {
  const box = await dialog.boundingBox();
  const last = tail ? await tail.boundingBox().catch(() => undefined) : undefined;
  const height = last ? Math.min(last.y + last.height + 28 - box.y, box.height) : box.height;
  await shot(name, undefined, { x: box.x, y: box.y, width: box.width, height });
};

// --- Подмена API целиком. Общее регистрируется раньше частного: Playwright
// отдаёт запрос ПОСЛЕДНЕМУ подходящему обработчику. ------------------------
await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: {
      isRepo: true,
      detached: false,
      unborn: false,
      branch: 'release/1.4',
      branches: [],
      changes: [],
    },
  }),
);

await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-08T09:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/integrations/links*', (route) => route.fulfill({ json: LINKS }));
await page.route('**/api/integrations', (route) => route.fulfill({ json: [] }));

await page.route('**/api/project-tests/run**', (route) => {
  const request = route.request();
  if (request.method() !== 'POST') {
    const id = new URL(request.url()).searchParams.get('id');
    return route.fulfill({ json: { run: RUNS.find((item) => item.id === id) } });
  }
  const body = request.postDataJSON();
  view = {
    ...view,
    run: {
      id: 'run-5',
      projectPath: PROJECT.path,
      mode: body.mode,
      actor: 'agent',
      groupId: body.groupId,
      environmentId: body.environmentId,
      scope: body.scope,
      release: body.release,
      branch: 'release/1.4',
      commit: '9c1f4ab2d0e7',
      status: 'running',
      startedAt: '2026-09-08T10:00:00.000Z',
      tokens: 12_400,
      costUsd: 0.09,
      log:
        'читаю CLAUDE.md проекта\n' +
        'смотрю src/features/Cart — кнопка «В корзину», счётчик в шапке\n' +
        'смотрю server/routes/cart.ts — POST /api/cart, 401 без сессии\n' +
        'пишу группу «Смоук»: 5 кейсов\n' +
        'кейс smoke-002: шаги, ожидание, зона «корзина», codePaths',
    },
  };
  return route.fulfill({ json: view });
});
await page.route('**/api/project-tests/runs*', (route) => route.fulfill({ json: { runs: RUNS } }));

await page.route('**/api/project-tests/plan**', (route) =>
  route.fulfill({ json: { plan: PLANS[0], points: MANUAL_POINTS } }),
);
await page.route('**/api/project-tests/plans*', (route) =>
  route.fulfill({ json: { plans: PLANS } }),
);

await page.route('**/api/project-tests/report*', (route) => route.fulfill({ json: REPORT }));
await page.route('**/api/project-tests/coverage*', (route) => route.fulfill({ json: COVERAGE }));
await page.route('**/api/project-tests/defects/refresh**', (route) =>
  route.fulfill({ json: { checked: 2, closed: 1, recheck: [] } }),
);
await page.route('**/api/project-tests/impact*', (route) => route.fulfill({ json: IMPACT }));
await page.route('**/api/project-tests/defect', (route) =>
  route.fulfill({ json: { draft: DEFECT_DRAFT } }),
);

await page.route('**/api/project-tests/convention*', (route) => {
  view = { ...view, hasConvention: true };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/manual**', (route) => {
  const request = route.request();
  const url = request.url();
  if (request.method() === 'GET') return route.fulfill({ json: { session: manualSession } });
  if (url.includes('/manual/start')) {
    manualSession = {
      runId: 'manual-1',
      environmentId: 'local',
      points: MANUAL_POINTS,
      index: 1,
      results: [{ ...pointResult('smoke-001', 'passed'), finishedAt: '2026-09-08T10:04:00.000Z' }],
      startedAt: '2026-09-08T10:02:00.000Z',
    };
    return route.fulfill({ json: { session: manualSession } });
  }
  if (url.includes('/manual/result')) {
    const body = request.postDataJSON();
    manualSession = {
      ...manualSession,
      index: Math.min(manualSession.index + 1, manualSession.points.length - 1),
      results: [
        ...manualSession.results,
        { ...pointResult(body.pointId.split(':')[1], body.status), note: body.note },
      ],
    };
    return route.fulfill({ json: { session: manualSession } });
  }
  return route.fulfill({ json: {} });
});

// Экраны второй волны. Регистрируются ПОСЛЕ общих: Playwright отдаёт запрос
// последнему подходящему обработчику, и `/run/diff` иначе съедает `/run**`.
// Звёздочка в шаблоне НЕ переходит через «/» — подпуть ловится только «**»,
// иначе `/manual/start` уходит на настоящий сервер и отвечает 400.
await page.route('**/api/project-tests/lint*', (route) => route.fulfill({ json: LINT }));
await page.route('**/api/project-tests/quarantine*', (route) =>
  route.fulfill({ json: QUARANTINE }),
);
await page.route('**/api/project-tests/risk*', (route) => route.fulfill({ json: RISK }));
await page.route('**/api/project-tests/release**', (route) => {
  const release = new URL(route.request().url()).searchParams.get('release') ?? '';
  return route.fulfill({
    json: {
      releases: ['v1.4', 'v1.3'],
      document: release ? { ...RELEASE_DOCUMENT, release } : RELEASE_DOCUMENT,
    },
  });
});
await page.route('**/api/project-tests/run/diff**', (route) => route.fulfill({ json: RUN_DIFF }));
await page.route('**/api/project-tests/draft**', (route) =>
  route.fulfill({ json: { drafts: [DRAFT], autoAccept: false } }),
);
await page.route('**/api/project-tests/env-secrets*', (route) =>
  route.fulfill({
    json: {
      secrets: [
        { name: 'SHOP_PASSWORD', title: 'Пароль покупателя', hasValue: true, mask: '••••ka' },
        { name: 'SHOP_TOKEN', title: 'Токен песочницы платежей', hasValue: false },
      ],
    },
  }),
);
await page.route('**/api/project-tests/taxonomy*', (route) =>
  route.fulfill({
    json: {
      areas: [
        { area: 'корзина', cases: 9, covered: 6 },
        { area: 'оплата', cases: 6, covered: 4 },
        { area: 'каталог', cases: 7, covered: 7 },
      ],
      tags: [
        { tag: 'смоук', cases: 5 },
        { tag: 'регресс', cases: 12 },
      ],
    },
  }),
);

await page.route('**/api/project-tests?*', (route) => route.fulfill({ json: view }));

// Проект берётся из ленты рабочих пространств — тем же способом, каким его
// подставляет `panel-pages.mjs`: съёмка не зависит ни от какой истории и не
// открывает ни одного настоящего проекта.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (project) =>
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    ),
  PROJECT,
);

const openTests = async (tab) => {
  await page.goto(`${BASE}/tests${tab ? `?tab=${tab}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1600);
};

const main = () => page.getByRole('main').or(page.locator('body')).first();

// --- 01. Пустой проект: кейсов нет, соглашение не вписано -----------------
await openTests();
await shot('01-empty');

// --- 02. Соглашение в CLAUDE.md: до и после нажатия ------------------------
// Левый край обоих кадров берётся у колонки, а не у самой кнопки: кнопка стоит в
// середине строки, и кадр от неё начинался бы с середины слова.
const conventionButton = page.getByRole('button', { name: /CLAUDE\.md/ }).first();
const columnLeft = Math.max(
  0,
  (await page.getByRole('button', { name: 'Новая группа' }).first().boundingBox()).x - 16,
);
await shot(
  '02-convention-off',
  undefined,
  await shotAround(conventionButton, { height: 130, left: columnLeft }),
);
await conventionButton.click();
await page.waitForTimeout(900);
await shot(
  '03-convention-on',
  undefined,
  await shotAround(page.getByText(/из чата/i).first(), { height: 120, left: columnLeft }),
);

// --- 04-06. Настройки набора: окружения, общие шаги, свои поля ------------
const openSettings = async () => {
  await page.getByRole('button', { name: 'Настройки набора' }).first().click();
  await page.waitForTimeout(900);
  return page.getByRole('dialog').first();
};

let settings = await openSettings();
await shot('04-settings-env', settings);
await settings.getByText('Общие шаги', { exact: true }).click();
await page.waitForTimeout(500);
await shot('05-settings-steps', settings);
await settings.getByText('Свои поля', { exact: true }).click();
await page.waitForTimeout(500);
await shot('06-settings-fields', settings);

// --- 07. Доступы стенда: имена в проекте, значения в панели ---------------
await settings.getByText('Окружения', { exact: true }).click();
await page.waitForTimeout(400);
await settings.getByRole('button', { name: 'Доступы' }).first().click();
await page.waitForTimeout(1100);
const secretsDialog = page.getByRole('dialog').last();
await shotDialog('07-secrets', secretsDialog, secretsDialog.locator('button').last());
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// --- 08. Пульт прогона целиком -------------------------------------------
const runBar = page.getByPlaceholder(/только чат/i).first();
await shot('08-run-bar', undefined, await shotAround(runBar, { padTop: 40, height: 300 }));

// --- 09. Идёт генерация: бейдж состояния и лог ----------------------------
await page
  .getByRole('button', { name: /Сгенерировать кейсы/ })
  .first()
  .click();
await page.waitForTimeout(1500);
await shot('09-generating', undefined, await shotAround(runBar, { padTop: 40, height: 430 }));

// Генерация «закончилась» черновиком: кейсы предложены, файлы не тронуты.
view = {
  ...view,
  run: { ...view.run, status: 'done' },
  drafts: [DRAFT_SUMMARY],
};

// --- 10. Приёмка черновика: панель пишет файлы, а не агент ----------------
await openTests();
const draftOpen = page.getByRole('button', { name: /Посмотреть/ }).first();
await draftOpen.click();
await page.waitForTimeout(1300);
const draftDialog = page.getByRole('dialog').first();
await shotDialog('10-draft', draftDialog, draftDialog.getByRole('button', { name: /Отклонить/ }));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// Черновик принят: дальше библиотека показывается с кейсами.
view = { ...view, groups: GROUPS, drafts: [] };

// --- 11. Библиотека: вкладки-группы, дерево секций, таблица ---------------
await openTests();
await shot('11-library');

// --- 12. Строка отбора и сохранённые наборы -------------------------------
const filterBar = page.getByLabel('Поиск по кейсам').first();
// Высота кадра кончается ровно на строке «Порядок»: обрезанная пополам кнопка
// следующей строки в печати читается как брак вёрстки, а не как продолжение.
await shot('12-filters', undefined, await shotAround(filterBar, { padTop: 24, height: 148 }));

// --- 13. Риск и время: порядок по риску и набор под бюджет ----------------
const order = page.getByLabel(/Порядок/).first();
if (await order.count()) {
  await order.selectOption({ label: 'по риску' }).catch(() => undefined);
  await page.waitForTimeout(900);
}
const budget = page.getByRole('button', { name: /^Набрать$/ }).first();
if (await budget.count()) {
  await budget.click();
  await page.waitForTimeout(900);
}
// Кадр риска — про бюджет, а не про фильтры: якорь у кнопки «Набрать», сверху
// захватывается подпись поля, снизу — строка сохранённых наборов.
await shot(
  '13-risk',
  undefined,
  await shotAround(budget, {
    padTop: 60,
    height: 148,
    left: Math.max(0, (await filterBar.boundingBox()).x - 24),
  }),
);

// --- 14. Массовые действия и карантин -------------------------------------
const boxes = main().locator('input[type="checkbox"]');
if ((await boxes.count()) > 1) {
  await boxes.nth(1).check({ force: true });
  await boxes.nth(2).check({ force: true });
  await page.waitForTimeout(500);
  const bulk = page.getByText(/Отмечено:/).first();
  // Полоса липкая и стоит у нижнего края окна: пока список не домотан до конца,
  // её нижняя граница уходит за кадр. Домотали — полоса встаёт на своё место.
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(600);
  await shot('14-bulk', undefined, await shotAround(bulk, { padTop: 40, height: 200 }));
  // Отметки снимаются именно кнопкой: панель массовых действий липкая и,
  // оставшись на экране, перехватывает клики по кейсам под ней.
  await page
    .getByRole('button', { name: /Снять выбор|Снять отметки/ })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(600);
}

// --- 15. Редактор кейса: шаги с ожиданием и оракул ------------------------
// Второго кадра того же окна нет: параметры, ссылки и автоматизация — тот же
// экран ниже по прокрутке, и в печати он читался бы как повтор.
await page.getByText('Вход по паролю').first().click();
await page.waitForTimeout(1200);
const editor = page.getByRole('dialog').first();
await shot('15-case-editor', editor);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// --- 17. Исследование и автоматизация: две кнопки того же пульта ----------
await shot(
  '17-explore',
  undefined,
  await shotAround(page.getByRole('button', { name: /Исследовать/ }).first(), {
    padTop: 120,
    height: 260,
    left: Math.max(0, (await filterBar.boundingBox()).x - 24),
  }),
);

// --- 18-19. Планы: список и форма ----------------------------------------
await openTests('plans');
await shot('18-plans');
const editPlan = page.getByRole('button', { name: /Править/ }).first();
if (await editPlan.count()) {
  await editPlan.click();
  await page.waitForTimeout(1000);
  await shot('19-plan-editor', page.getByRole('dialog').first());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// --- 20. План правилом: набор собирается счётом, а не агентом -------------
const recipe = page.getByRole('button', { name: /Собрать правилом/ }).first();
if (await recipe.count()) {
  await recipe.click();
  await page.waitForTimeout(1100);
  const recipeDialog = page.getByRole('dialog').first();
  await shotDialog('20-plan-recipe', recipeDialog, recipeDialog.locator('button').last());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}

// --- 21-22. Ручной проход и черновик дефекта ------------------------------
await openTests();
await page
  .getByRole('button', { name: /Пройти руками/ })
  .first()
  .click();
await page.waitForTimeout(1600);
const runner = page.getByRole('dialog').first();
await shot('21-manual-runner', runner);

const defectButton = runner.getByRole('button', { name: /Завести дефект/ }).first();
if (await defectButton.count()) {
  await defectButton.click();
  await page.waitForTimeout(1400);
  await shot('22-defect', page.getByRole('dialog').last());
}
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
// Незакрытый ручной проход оставляет на всех следующих кадрах плашку
// «Вернуться к проходу» — сессия гасится там же, где она и живёт.
manualSession = undefined;

// --- 24. История прогонов: раскрытая запись -------------------------------
// Отдельного кадра со свёрнутым списком нет: раскрытая запись показывает и список,
// и её содержимое, а два одинаковых экрана подряд в печати — пустая страница.
await openTests('runs');
// Запись раскрывается своим заголовком-кнопкой: тело с результатами, публикацией
// и сравнением рисуется только для раскрытой.
await page.locator('button[aria-controls^="run-body-"]').first().click();
await page.waitForTimeout(1400);
await shot('24-run-record');

// --- 25. Сравнение с предыдущим прогоном ----------------------------------
const compare = page.getByRole('button', { name: /Сравнить с предыдущим/ }).first();
await compare.click({ force: true });
await page.waitForTimeout(1800);
// Кнопка исчезает вместе с раскрытием: дальше на экране сам блок сравнения,
// и якорем берётся первый его список — «Сломалось».
await shot(
  '25-run-diff',
  undefined,
  await shotAround(page.getByText('Сломалось', { exact: true }).first(), {
    padTop: 90,
    height: 640,
    // Якорь стоит внутри карточки с отступом: левый край берётся у самой карточки,
    // иначе кадр срезает начало каждой строки.
    left: Math.max(
      0,
      (await page.locator('button[aria-controls^="run-body-"]').first().boundingBox()).x - 16,
    ),
  }),
);

// --- 26-27. Отчёт: верх и одинаковые падения ------------------------------
await openTests('report');
await shot('26-report');
// Карточки отчёта снимаются самой карточкой, а не экраном целиком: в печати
// кадр во весь экран ужимается втрое, и текст замечаний перестаёт читаться.
const failures = page.getByText('Одинаковые падения').first();
if (await failures.count()) {
  await shot(
    '27-report-failures',
    undefined,
    await shotAround(failures, { padTop: 34, height: 262, width: 1010, toTop: true }),
  );
}

// --- 28. Здоровье набора: замечания линтера и похожие кейсы ---------------
const health = page.getByText(/Здоровье набора|Замечания/).first();
if (await health.count()) {
  await shot(
    '28-lint',
    undefined,
    await shotAround(health, { padTop: 34, height: 436, width: 1010, toTop: true }),
  );
}

// --- 29. Карантин: кого выпускать, кого прятать ---------------------------
const quarantine = page.getByText(/Карантин/).first();
if (await quarantine.count()) {
  await shot(
    '29-quarantine',
    undefined,
    await shotAround(quarantine, { padTop: 34, height: 560, width: 1010, toTop: true }),
  );
}

// --- 30. Готовность релиза: сначала вердикт, потом доказательства ---------
const release = page.getByText('Готовность релиза', { exact: true }).first();
await page.waitForTimeout(1100);
await shot(
  '30-release',
  undefined,
  await shotAround(release, { padTop: 30, height: 700, toTop: true }),
);

// --- 31. Покрытие требований ----------------------------------------------
await openTests('coverage');
// Якорем берётся кнопка внутри карточки, а левым краем — полоса вкладок: слово
// «Требования» есть и во внешних привязках наверху, и кадр от него срезал бы
// каждую строку матрицы по середине.
const coverage = page.getByRole('button', { name: /Обновить статусы дефектов/ }).first();
if (await coverage.count()) {
  await shot(
    '31-coverage',
    undefined,
    await shotAround(coverage, {
      padTop: 90,
      height: 600,
      toTop: true,
      left: Math.max(
        0,
        (await page.getByText('Библиотека', { exact: true }).first().boundingBox()).x - 16,
      ),
    }),
  );
} else {
  await shot('31-coverage');
}

// --- 32. Обмен: импорт результатов CI и выгрузка --------------------------
await openTests();
const exchange = page.getByRole('button', { name: /^Обмен$/ }).first();
if (await exchange.count()) {
  await exchange.click();
  await page.waitForTimeout(1200);
  const exchangeDialog = page.getByRole('dialog').first();
  await shotDialog('32-exchange', exchangeDialog);
  await page.keyboard.press('Escape');
}

await browser.close();
console.log(`\nКадров снято: ${taken.length} → ${OUT}`);
