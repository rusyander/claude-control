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
};
