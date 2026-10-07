import { blockLang } from '../brand.ts';

/** Язык блока отчёта о ситах. */
export const SIEVE_LANG = blockLang('sieves');

/**
 * Классы блокеров. Первые пять — строки таблицы владельца (28.09); дальше —
 * классы того, что доезжает до dev и prod мимо ревью: утёкший секрет
 * (`security`), миграция без отката (`data`), остатки отладки, красный CI и
 * код без теста (`hygiene`), выпуск без пути назад (`release`). `other` —
 * выученное вне них.
 */
export const SIEVE_CLASSES = [
  'contract',
  'integration',
  'isolation',
  'consumers',
  'boundary',
  'security',
  'data',
  'hygiene',
  'release',
  'other',
] as const;
export type SieveClass = (typeof SIEVE_CLASSES)[number];

/** Что затронуто диффом группы — по путям. `data` — миграции и схемы БД. */
export type TouchKind = 'ui' | 'backend' | 'contract' | 'code' | 'data';

/** Звено, в котором сито делается. Доставка — последний рубеж и судья всех. */
export type SieveStage = 'review' | 'deliver';

export const BUILTIN_SIEVE_IDS = [
  'contract-by-request',
  'consumers-repo-wide',
  'merge-tree',
  'foreign-removals',
  'browser-focus',
  'branch-backend-stand',
  'boundary-negative',
  'project-checks',
  'tests-alongside',
  'lockfile-sync',
  'secrets',
  'debug-leftovers',
  'committed-artifacts',
  'env-config',
  'migration-safety',
  'rollback-plan',
] as const;
export type BuiltinSieveId = (typeof BUILTIN_SIEVE_IDS)[number];

export interface SieveDef {
  id: BuiltinSieveId;
  class: SieveClass;
  /** Где сито делается впервые; доставка проверяет отчёт по всем. */
  stage: SieveStage;
  /** Применимо, если дифф задел хоть один из видов. Пусто — всегда. */
  when: readonly TouchKind[];
  /**
   * Панель проверяет сама (git). `merge-tree` и `foreign-removals` строки отчёта не
   * требуют — она нужна только, чтобы снять срабатывание, назвав каждый отмеченный
   * файл. `consumers-repo-wide` панель лишь перепроверяет: её поиск видит удалённые
   * имена, а не переименованный test-id, поэтому группа сдаёт свою строку, пока
   * панель ничего не отметила (`judgeSieves`).
   */
  mechanical?: true;
  /**
   * Чем снимается срабатывание механики: `names` — строкой, чьё доказательство
   * называет КАЖДЫЙ отмеченный файл или имя; `evidence` — строкой с любым
   * доказательством. Нет поля у механического сита — не снимается ничем
   * (конфликт со свежей основной — только rebase).
   */
  clears?: 'names' | 'evidence';
  /**
   * Живая проверка: в проекте с блоком «Тесты» `pass` доказывается записанным
   * прогоном блока (`run:<id>` в доказательстве), который панель находит в
   * истории и сверяет с кодом ветки, — а не словами.
   */
  proof?: 'run';
  /** Применимо только на высоком риске (`riskTier`), а не по видам путей. */
  risk?: 'high';
  /** Задание модели (английский, как все задания звеньев). */
  text: string;
}

export const BUILTIN_SIEVES: readonly SieveDef[] = [
  {
    id: 'contract-by-request',
    class: 'contract',
    stage: 'review',
    when: ['contract', 'backend'],
    proof: 'run',
    text:
      'Second entry, from the contract, not from the diff: list every claim that docs, API ' +
      'contracts, OpenAPI/proto/schema files, README or help make about the changed behaviour ' +
      '(status codes, field names, error shapes, limits, defaults). Check EACH by a real request ' +
      'to a stand running THIS branch (curl, or the route integration test through the real ' +
      'route) and compare with the actual response. A claim checked only by reading code is not ' +
      'checked. Evidence: the request and the observed status/body line.',
  },
  {
    id: 'consumers-repo-wide',
    class: 'consumers',
    stage: 'review',
    when: ['code'],
    mechanical: true,
    clears: 'names',
    text:
      'Consumers outside the diff: for every changed or removed string, role, test id, route, ' +
      'i18n key and exported name, search the WHOLE repository (git grep), including e2e, QA and ' +
      'autotest folders and other packages, and fix or name each consumer. Evidence: the search ' +
      'commands and what they found.',
  },
  {
    id: 'merge-tree',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    text:
      'Integration with fresh main: after `git fetch`, `git merge-tree --write-tree ' +
      'origin/<main> HEAD` must report no conflicts. The panel runs it itself; a conflict is ' +
      'cleared only by rebasing onto fresh main.',
  },
  {
    id: 'foreign-removals',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'No foreign "−": the diff against main must not delete lines that landed in main after the ' +
      "group started (someone else's work lost in a rebase or an overwritten file). The panel " +
      'checks it itself; an intended removal is reported with EVERY such file named and why.',
  },
  {
    id: 'browser-focus',
    class: 'isolation',
    stage: 'deliver',
    when: ['ui'],
    proof: 'run',
    text:
      'UI changed: run a browser test (Playwright or the project e2e) over the changed screens — ' +
      'Tab order, visible focus, Escape/Enter, and layout at a narrow and a wide width. A unit ' +
      'test of the component does not count. Evidence: the command and its pass line.',
  },
  {
    id: 'branch-backend-stand',
    class: 'isolation',
    stage: 'deliver',
    when: ['backend'],
    text:
      'Backend changed: live checks run against a stand whose backend is built from THIS branch, ' +
      'not from main or a shared dev stand. Evidence: which process/port and the commit it runs.',
  },
  {
    id: 'boundary-negative',
    class: 'boundary',
    stage: 'deliver',
    when: ['code'],
    proof: 'run',
    text:
      'In the live run add one negative at a type or limit boundary of the changed input (empty, ' +
      'max+1, wrong type, missing field) and check the refusal is the documented one. Evidence: ' +
      'the input and the observed response.',
  },
  {
    id: 'project-checks',
    class: 'hygiene',
    stage: 'review',
    when: ['code'],
    text:
      "Run the project's own checks the way its CI does, from the repository root, on the final " +
      'commit — the panel lists the commands it found below. Each must pass; a check you could ' +
      'not run is a fail with the reason, not an n/a. Evidence: every command and its ' +
      'pass/summary line.',
  },
  {
    id: 'tests-alongside',
    class: 'hygiene',
    stage: 'review',
    when: ['code'],
    mechanical: true,
    clears: 'evidence',
    text:
      'Changed behaviour ships with an automated test in this branch — a new or updated unit, ' +
      'integration or e2e test that fails without the change. The panel flags code changed with ' +
      'no test file changed; clear it with the test file, test name and the command that ran it, ' +
      'or n/a with why no behaviour changed (pure refactor, rename, comment).',
  },
  {
    id: 'lockfile-sync',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'A changed dependency manifest ships with its lockfile: package.json with its ' +
      'package-lock/pnpm-lock/yarn.lock/bun.lock, pyproject.toml with poetry.lock/uv.lock, go.mod ' +
      'with go.sum, Cargo.toml with Cargo.lock, Gemfile with Gemfile.lock, composer.json with ' +
      "composer.lock. The panel checks it; regenerate the lock with the project's own package " +
      'manager, or name each manifest with why its lock is unaffected.',
  },
  {
    id: 'secrets',
    class: 'security',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'No secrets in the diff: the panel scans added lines for vendor-shaped keys and tokens, ' +
      'JWTs, credentials inside URLs and private keys. A real secret is removed AND rotated — ' +
      'deleting it from the branch does not un-leak it; a fake fixture is named file by file ' +
      'with why it is fake.',
  },
  {
    id: 'debug-leftovers',
    class: 'hygiene',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'No debug leftovers: the panel scans added lines for focused tests (.only, fit, fdescribe) ' +
      'that silently skip the rest of the suite in CI, debugger/breakpoint()/pdb statements and ' +
      'merge-conflict markers. Remove them, or name each file with why it is intended.',
  },
  {
    id: 'committed-artifacts',
    class: 'hygiene',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'No build output or local files in git: the panel flags added files that .gitignore ' +
      'excludes (force-added), .env files, private keys and files over 5 MB. Remove them from ' +
      'the branch, or name each file with why it belongs in git.',
  },
  {
    id: 'env-config',
    class: 'integration',
    stage: 'deliver',
    when: [],
    mechanical: true,
    clears: 'names',
    text:
      'Every environment variable the diff starts reading is declared where the project keeps ' +
      'its configuration (.env.example, docker-compose, Helm/k8s values, settings docs) with a ' +
      'safe default or a documented required value — otherwise the first deploy fails or runs ' +
      'on an undefined value. The panel lists new names it found declared nowhere; declare them, ' +
      'or name each with why no declaration is needed.',
  },
  {
    id: 'migration-safety',
    class: 'data',
    stage: 'review',
    when: ['data'],
    proof: 'run',
    text:
      'Schema or data migration changed: it stays compatible with the code still running ' +
      '(expand → migrate → contract; nothing the old code reads is renamed or dropped in the same ' +
      'release), it has a working rollback (down migration or documented revert), and it was ' +
      'applied on a fresh database AND on a copy of the current schema. A destructive statement ' +
      '(DROP, TRUNCATE, DELETE without WHERE, narrowing a column type) needs a data-preserving ' +
      'plan; the panel names files with such statements and the row must name each. Evidence: ' +
      'the apply and rollback commands and their output.',
  },
  {
    id: 'rollback-plan',
    class: 'release',
    stage: 'deliver',
    when: [],
    risk: 'high',
    text:
      'High-risk change (auth, payments, security, data or a very large diff — the panel says ' +
      'why): state how it is rolled back without data loss (revert commit, feature flag or config ' +
      'switch), which production signal shows it is broken (log line, metric, alert), and that ' +
      'the default keeps the old behaviour until switched on where that is possible. Evidence: ' +
      'the rollback step and the signal.',
  },
];

const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const BACKEND_EXT = /\.(go|py|java|kt|kts|rb|php|rs|cs|ex|exs|scala|sql)$/i;
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s)$/i;
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const CONTRACT_NAME = /(^|\/)[^/]*(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const CONTRACT_EXT = /\.(proto|graphql|gql)$/i;
const CONTRACT_DIR = /(^|\/)(contracts?|docs?|api-docs)\//i;
/**
 * Тест — по ИМЕНИ файла (Ф3): `*.test.*`, `*.spec.*`, `*.stories.*`, `*.cy.*`,
 * `*_test.go`, `test_*.py`, `*_spec.rb`, `FooTest.java`. Папка сама файл тестом
 * не делает: `tests/` и `qa/` — частые имена кода (`apps/mobile/src/entities/tests`,
 * скрипты `tools/qa`), и их правка без теста иначе сходила бы за «тест рядом».
 * Исключение — `__tests__/`: так код не называют, это корень тестов Jest.
 */
const TEST_PATH =
  /(^|\/)__tests__\/|\.(test|spec|stories|cy|e2e)\.[^/]+$|_(test|spec)\.(go|py|rb|exs?|rs|php|[cm]?[jt]sx?)$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+Tests?\.(java|kt|kts|cs|scala|php)$/;
/** Служебные каталоги агентов и инструментов — не доки продукта. */
const DOT_DIR = /(^|\/)\.[^/]+\//;
/** Миграции и схемы БД — у любого стека: каталоги, SQL и файлы схем ORM. */
const DATA_PATH =
  /(^|\/)(migrations?|migrate|alembic|flyway|liquibase)\/|(^|\/)db\/(changelog\/|(schema|structure)\.)|\.sql$|(^|\/)schema\.prisma$|(^|\/)[^/]*migration[^/]*\.(sql|py|rb|go|java|kt|m?[jt]s|c[jt]s|php|cs|exs?|ya?ml|xml|json)$/i;

/** Виды затронутого по списку путей диффа (прямые слэши, от корня репозитория). */
export function touchKinds(paths: readonly string[]): Set<TouchKind> {
  const kinds = new Set<TouchKind>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/');
    if (DOT_DIR.test(path)) continue;
    const test = TEST_PATH.test(path);
    if (
      CONTRACT_NAME.test(path) ||
      CONTRACT_EXT.test(path) ||
      (DOC_EXT.test(path) && !test) ||
      (CONTRACT_DIR.test(path) && !test && (CODE_EXT.test(path) || /\.(ya?ml|json)$/i.test(path)))
    ) {
      kinds.add('contract');
    }
    if (test) continue;
    if (DATA_PATH.test(path)) kinds.add('data');
    if (UI_EXT.test(path)) kinds.add('ui');
    // Вид решает расширение (Ф3): TS в `apps/web/**/api/` — клиент, а не бэкенд.
    if (BACKEND_EXT.test(path)) kinds.add('backend');
    if (UI_EXT.test(path) || BACKEND_EXT.test(path) || CODE_EXT.test(path)) kinds.add('code');
  }
  return kinds;
}

/** Уровень риска правки и почему — по путям, без модели. */
export type RiskTier = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  tier: RiskTier;
  /** Причины высокого риска — для задания: `data`, `sensitive: <путь>`, `size: <N>`. */
  reasons: string[];
}

/** Пути, где ошибка стоит дороже всего: вход, права, деньги, криптография. */
const SENSITIVE_PATH =
  /(^|[/_.-])(auth\w*|login|logout|oauth|sso|saml|passw\w*|credential\w*|secrets?|crypt\w*|permission\w*|rbac|acl|polic(y|ies)|payments?|billing|invoices?|checkout|wallets?|security)([/_.-]|$)/i;
/** С этого числа изменённых файлов кода правка — крупная, и откат обязателен. */
export const LARGE_DIFF_FILES = 40;

/**
 * Риск правки. Высокий — миграции и схемы, пути входа, прав, денег и
 * криптографии, или дифф от `LARGE_DIFF_FILES` файлов кода: там нужен план
 * отката (`rollback-plan`). Низкий — ни кода, ни данных (доки, тесты, конфиг
 * агентов). Остальное — средний.
 */
export function riskTier(paths: readonly string[]): RiskAssessment {
  const kinds = touchKinds(paths);
  const reasons: string[] = [];
  if (kinds.has('data')) reasons.push('data');
  const product = paths
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => !DOT_DIR.test(path) && !TEST_PATH.test(path));
  const sensitive = product.find((path) => SENSITIVE_PATH.test(path));
  if (sensitive) reasons.push(`sensitive: ${sensitive}`);
  const code = product.filter((path) => touchKinds([path]).has('code')).length;
  if (code >= LARGE_DIFF_FILES) reasons.push(`size: ${code}`);
  if (reasons.length > 0) return { tier: 'high', reasons };
  return { tier: kinds.has('code') ? 'medium' : 'low', reasons };
}

/** Путь — тест (по нему судится «тесты рядом с кодом»). */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, '/'));
}

/** Путь — код продукта (не тест и не служебный каталог). */
export function isProductCode(path: string): boolean {
  const clean = path.replace(/\\/g, '/');
  return !DOT_DIR.test(clean) && !TEST_PATH.test(clean) && touchKinds([clean]).has('code');
}

/**
 * Встроенные сита, применимые к диффу с этими путями. Пустой дифф — ни одного.
 * Сито высокого риска (`rollback-plan`) — только когда `riskTier` высокий.
 */
export function applicableSieves(paths: readonly string[]): SieveDef[] {
  if (paths.length === 0) return [];
  const kinds = touchKinds(paths);
  const high = riskTier(paths).tier === 'high';
  return BUILTIN_SIEVES.filter((sieve) => {
    if (sieve.risk === 'high') return high;
    return sieve.when.length === 0 || sieve.when.some((kind) => kinds.has(kind));
  });
}

/** Касается ли набор путей этого сита — по видам (пусто у сита — любой код). */
export function touchesSieve(sieve: SieveDef, paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const kinds = touchKinds([path]);
    if (sieve.when.length === 0) return kinds.has('code') || kinds.has('data');
    return sieve.when.some((kind) => kinds.has(kind));
  });
}
