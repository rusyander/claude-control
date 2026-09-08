/**
 * Ключи кэша тестов.
 *
 * Всё адресуется ПУТЁМ проекта, а не его id в реестре: тесты живут в файлах
 * проверяемого проекта, и один и тот же путь может быть открыт из чата, из
 * реестра и с телефона. Путь в ключе — единственное, что делает эти три входа
 * одним кэшем.
 */
const ROOT = 'project-tests';

/** Как часто перечитывать данные, пока прогон идёт. */
export const TESTS_POLL_MS = 2000;

export const testKeys = {
  /** Всё поддерево тестов — для сброса разом. */
  root: [ROOT],
  view: (path: string | undefined) => [ROOT, 'view', path ?? ''],
  plans: (path: string | undefined) => [ROOT, 'plans', path ?? ''],
  points: (path: string | undefined, planId: string | undefined, environmentId?: string) => [
    ROOT,
    'points',
    path ?? '',
    planId ?? '',
    environmentId ?? '',
  ],
  runs: (path: string | undefined) => [ROOT, 'runs', path ?? ''],
  run: (path: string | undefined, id: string | undefined) => [ROOT, 'run', path ?? '', id ?? ''],
  report: (path: string | undefined) => [ROOT, 'report', path ?? ''],
  /** Сравнение прогонов: обе стороны в ключе — это разный вопрос к истории. */
  diff: (path: string | undefined, id: string | undefined, baseId?: string) => [
    ROOT,
    'run-diff',
    path ?? '',
    id ?? '',
    baseId ?? '',
  ],
  /** Все матрицы покрытия проекта — для сброса разом, каким бы ни был запрос. */
  coverageAll: (path: string | undefined) => [ROOT, 'coverage', path ?? ''],
  /** Матрица покрытия: запрос JQL входит в ключ — это разный вопрос к Jira. */
  coverage: (path: string | undefined, jql: string) => [ROOT, 'coverage', path ?? '', jql],
  impact: (path: string | undefined) => [ROOT, 'impact', path ?? ''],
  /** История файла группы из git — ключ по группе: у каждой свой файл. */
  history: (path: string | undefined, groupId: string | undefined) => [
    ROOT,
    'history',
    path ?? '',
    groupId ?? '',
  ],
  manual: (path: string | undefined) => [ROOT, 'manual', path ?? ''],
  /** Замечания линтера и дубликаты — считаются по всей библиотеке разом. */
  lint: (path: string | undefined) => [ROOT, 'lint', path ?? ''],
  /** Карантин и устаревание — считаются по библиотеке и истории прогонов. */
  quarantine: (path: string | undefined) => [ROOT, 'quarantine', path ?? ''],
  /** Риск кейсов: считается по всей библиотеке разом, бюджет применяется на экране. */
  risk: (path: string | undefined) => [ROOT, 'risk', path ?? ''],
  /** Готовность вехи: веха входит в ключ — это разные документы. */
  release: (path: string | undefined, release: string | undefined) => [
    ROOT,
    'release',
    path ?? '',
    release ?? '',
  ],
  /** Предложение таксономии: порог входит в ключ — это разный вопрос. */
  taxonomy: (path: string | undefined, minCases: number) => [
    ROOT,
    'taxonomy',
    path ?? '',
    String(minCases),
  ],
  /** Доступы окружения: ключ по окружению — у каждого свои переменные. */
  secrets: (path: string | undefined, environmentId: string | undefined) => [
    ROOT,
    'env-secrets',
    path ?? '',
    environmentId ?? '',
  ],
  /** Черновик генерации целиком — ключ по прогону: у каждого свой файл. */
  draft: (path: string | undefined, runId: string | undefined) => [
    ROOT,
    'draft',
    path ?? '',
    runId ?? '',
  ],
};
