import type { ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { casesTouching } from '../impact/impact.ts';
import { CASE_STANDARD } from '../case-standard.ts';
import { isVagueCase } from '../lint/lint.ts';

/**
 * Проверка конца хода любого агента над проектом (решение владельца 15.10): правил
 * код — кейс на изменённое заведён, автоматический прогнан ПОСЛЕ правки, ручной
 * записан, красного нет. То же, что держит группу разделения перед «доставлено»
 * (`chat/tests-gate`), но на один ход: окно — от начала хода, а не от старта
 * группы, и пустой блок — тоже пробел, а не «проверять нечем»: хук ставится только
 * туда, где блок включён.
 *
 * Тексты английские: их читает модель (пропуск хука Stop), человек видит итог в
 * разделе. Каждый пробел несёт готовую команду — ход, потраченный на поиск
 * синтаксиса, стоит столько же, сколько весь контекст разговора.
 */
export interface TurnGateInput {
  groups: ProjectTestGroup[];
  runs: readonly ProjectTestRunRecord[];
  /** Файлы, изменённые за ход, — от корня проекта. */
  paths: readonly string[];
  /** Начало хода. */
  since: string;
  /** Последняя правка хода: прогон до неё не видел того, что сдаётся. */
  changedAt?: string;
  /**
   * Файлы хода, которых git не отслеживает (3.4): скрипт снимков или пробы среди
   * них — подсобка хода, не код. Нет поля — исключения нет.
   */
  untracked?: readonly string[];
  /** `node "<…>/tests-cli.mjs"` — как агенту его вызвать. */
  cli: string;
  root: string;
}

/** Не код продукта: заметки агентов, конфиги CLI, документы, замки зависимостей. */
const NOT_CODE =
  /^(\.agent|\.claude|\.git|\.vscode|\.idea|docs|changelog)\/|\.(md|mdx|txt|rst|adoc)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock)$/i;

/**
 * Скрипт снимков или пробы по имени (3.4 плана экономии, 17.10.2026): одноразовый
 * `e2e/login-shots.mjs` останавливал конец хода требованием кейса. Не код он
 * только неотслеживаемым И лежащим там, где живут подсобные скрипты, — в корне
 * или в папке скриптов, не под `src/`/`lib/`: новый `src/health/probe.ts` или
 * `shared/lib/screenshot.ts` — исходник продукта, и проверку с него не снять.
 * Отслеживаемый скрипт и тест (`.spec.`, `.test.`) — код.
 */
const SCRATCH_SCRIPT =
  /(^|\/)[^/]*(shots?|screenshots?|snapshots?|probes?|repro)[^/]*\.(mjs|cjs|js|ts|py|sh)$/i;
const SCRATCH_DIR = /(^|\/)(e2e|qa|scripts?|tools|tmp|temp|scratch)\//i;
const SOURCE_DIR = /(^|\/)(src|lib)\//i;
const TEST_FILE = /\.(spec|test)\.[^/]+$/i;

/** Сколько назвать по имени: дальше — числом. Длинный пропуск — лишние токены каждый раз. */
const NAMED = 4;

function named(items: readonly string[]): string {
  const head = items.slice(0, NAMED).join(', ');
  return items.length > NAMED ? `${head} (+${items.length - NAMED})` : head;
}

const normal = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

export function codePathsOf(paths: readonly string[], untracked: readonly string[] = []): string[] {
  const loose = new Set(untracked.map(normal));
  const scratch = (path: string) =>
    loose.has(path) &&
    SCRATCH_SCRIPT.test(path) &&
    !TEST_FILE.test(path) &&
    (!path.includes('/') || (SCRATCH_DIR.test(path) && !SOURCE_DIR.test(path)));
  return [...new Set(paths.map(normal))].filter(
    (path) => path && !path.startsWith('../') && !NOT_CODE.test(path) && !scratch(path),
  );
}

/** Группа для нового кейса: верхняя папка файла, как зона, — агенту не гадать. */
function groupHint(file: string): string {
  const parts = file.split('/');
  const top =
    parts.length > 2 && /^(apps|packages|services|src|libs|modules)$/.test(parts[0] ?? '')
      ? parts[1]
      : parts[0];
  return (
    (top ?? 'main')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '') || 'main'
  );
}

/**
 * Кейсы, написанные или правленные за ход, чьи ожидания ничего не называют
 * («прогнать тесты — все проходят»). Такой кейс зелёный при любом поведении, и
 * человек, открыв его, не узнает, что проверено. Спрашивается и в ходе без кода:
 * агент мог только писать кейсы.
 */
function weakCases(input: TurnGateInput): string[] {
  const since = Date.parse(input.since);
  const weak = input.groups
    .filter((group) => !group.error)
    .flatMap((group) =>
      group.cases
        .filter(
          (item) =>
            !item.archived &&
            item.updatedAt !== undefined &&
            Date.parse(item.updatedAt) >= since &&
            isVagueCase(item),
        )
        .map((item) => `${group.id}:${item.id}`),
    );
  if (weak.length === 0) return [];
  return [
    `Tests block: cases written this turn name nothing observable (${named(weak)}) — rewrite them (pass "id"). ${CASE_STANDARD} Check: ${input.cli} lint --project "${input.root}"`,
  ];
}

export function judgeTurn(input: TurnGateInput): string[] {
  const weak = weakCases(input);
  const code = codePathsOf(input.paths, input.untracked);
  if (code.length === 0) return weak;
  const project = `--project "${input.root}"`;
  const caseCmd = (file: string) =>
    `${input.cli} case ${project} --group ${groupHint(file)} --json '{"title":"…","steps":["…"],"expected":"…","codePaths":["${file}"]}'`;
  const live = input.groups.filter((group) => !group.error);
  const hasCases = live.some((group) => group.cases.some((item) => !item.archived));
  if (!hasCases) {
    return [
      `Tests block: code changed (${named(code)}) but the project has no test case yet — add one for the change: ${caseCmd(code[0] ?? '')}. An existing test file → add "automation":{"status":"automated","file":"<path>"} and run it: ${input.cli} run ${project} --case <group>:<id>.`,
    ];
  }

  const since = Date.parse(input.since);
  const changed = input.changedAt ? Date.parse(input.changedAt) : since;
  const done = input.runs.filter((run) => run.status !== 'running');
  const inTurn = done.filter((run) => Date.parse(run.startedAt) >= since);
  const executedFresh = inTurn.filter(
    (run) => !run.attested && Date.parse(run.startedAt) >= changed,
  );
  const latest = (runs: readonly ProjectTestRunRecord[]) => {
    const map = new Map<string, string>();
    for (const run of [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))) {
      for (const result of run.results) {
        const key = `${result.groupId}:${result.caseId}`;
        if (!map.has(key)) map.set(key, result.status);
      }
    }
    return map;
  };
  const anyResult = latest(inTurn);
  const executed = latest(executedFresh);

  const touched = casesTouching(code, live).cases;
  const byKey = new Map<string, ProjectTestGroup['cases'][number]>(
    live.flatMap((group) => group.cases.map((item) => [`${group.id}:${item.id}`, item] as const)),
  );
  const gaps: string[] = [];
  const covered = new Set<string>();
  for (const item of touched) {
    const testCase = byKey.get(`${item.groupId}:${item.caseId}`);
    // Папку пишут и как `src/help/` — без среза черты `startsWith('src/help//')` не
    // совпадал ни с одним файлом, и покрытый файл звался непокрытым.
    for (const path of testCase?.codePaths ?? []) {
      covered.add(path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
    }
  }
  const uncovered = code.filter(
    (file) => ![...covered].some((path) => file === path || file.startsWith(`${path}/`)),
  );
  if (touched.length === 0 || (uncovered.length > 0 && covered.size > 0)) {
    const files = touched.length === 0 ? code : uncovered;
    gaps.push(
      `Tests block: no case covers ${named(files)} — add or extend one (codePaths = the changed files): ${caseCmd(files[0] ?? '')}`,
    );
  }

  const unrunKeys: string[] = [];
  const unrun: string[] = [];
  const unrecorded: string[] = [];
  for (const item of touched) {
    const key = `${item.groupId}:${item.caseId}`;
    const testCase = byKey.get(key);
    if (!testCase || testCase.muted) continue;
    if (testCase.automation?.status === 'automated') {
      const status = executed.get(key);
      if (!status || status === 'skipped' || status === 'unknown') {
        unrun.push(item.caseId);
        unrunKeys.push(key);
      }
    } else if (!anyResult.has(key)) {
      unrecorded.push(key);
    }
  }
  if (unrun.length > 0) {
    // Ровно эти кейсы, не их группа: группа `chat` смешивает юнит-кейсы с живыми
    // QA на стенде, и прогон «всей группы» по подсказке грузил стенд посреди
    // работы групп (журнал 19.10, L6.2).
    const command = `${input.cli} run ${project} --case ${unrunKeys.join(',')}`;
    gaps.push(
      `Tests block: automated cases for the changed code were not run after the last edit (${named(unrun)}) — run: ${command}`,
    );
  }
  if (unrecorded.length > 0) {
    gaps.push(
      `Tests block: manual cases for the changed code have no result this turn (${named(unrecorded)}) — check them and record: ${input.cli} record ${project} ${unrecorded
        .slice(0, NAMED)
        .map((key) => `${key}=passed`)
        .join(' ')} --note "<how you checked>"`,
    );
  }
  const red = [...anyResult]
    .filter(
      ([key, status]) => (status === 'failed' || status === 'blocked') && !byKey.get(key)?.muted,
    )
    .map(([key]) => key);
  if (red.length > 0) {
    gaps.push(
      `Tests block: red this turn (${named(red)}) — fix and run again; a red test is never weakened to pass.`,
    );
  }
  return [...weak, ...gaps];
}
