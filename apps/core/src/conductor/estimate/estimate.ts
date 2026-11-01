import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { EstimateBody, EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { ScenarioRef } from '@agentdeck/contracts/core/scenario';
import { estimateFromHistory } from '../../economy/budget/index.ts';
import { learnedCachePath, readLearned } from '../../economy/learned/index.ts';
import { linesAfter } from '../../journal/read-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createExclusive } from '../../platform/safe-io/files.ts';
import { launchLint } from '../lint/launch-lint.ts';
import { latestPresets, resolveScenario, scenarioPrecedence } from '../scenario/index.ts';
import type { TaskRegistry } from '../tasks.ts';
import { BASE_PIN_SIGNAL, basePinDetail } from './base-pin.ts';
import type {
  CreateSeed,
  EstimateOutcome,
  LaunchLayer,
  PinnedRepoView,
  PreflightRow,
  SplitEnv,
} from './estimate.types.ts';
import { grantConfirmations } from './grants.ts';
import {
  journalPreflight,
  jsonArray,
  PREFLIGHT_SIGNAL,
  publishesOf,
  rowsOfSignal,
  runTaskPreflight,
} from './preflight-run.ts';

/**
 * Оценка = создание задачи (07:7, G5, G6). Полномочия уже прошли (ручка). Порядок:
 * повтор того же `cmdId` — найденная задача, второй не создаётся; репозитории — корень, ключ и
 * приколотая база после `git fetch` (F-169); нечитаемый репозиторий — 422, задачи нет (без базы
 * задача не создаётся). Дальше задача есть всегда: запрос — артефактом (строка журнала ≤ 64 КБ),
 * сценарий с правками уровней, предпроверка дорог (P101). Сценарий или дорога негодны —
 * `fail` и `task.ended failed`, ответ `refused` с причинами. Годны — `estimate` и единица 0:
 * одна, в первом репозитории, свои пути `**`; план в ней только читает и предлагает деление.
 */

/** Файл запроса в каталоге задачи; `task.created.requirementsSource` — путь от каталога. */
export const REQUEST_ARTIFACT = 'request.md';
/** Причины отказа оценки (сценарий): строка журнала, по ней повтор отвечает тем же. */
export const ESTIMATE_REFUSED_SIGNAL = 'estimate-refused';
export { BASE_PIN_SIGNAL };

const inflight = new Map<string, Promise<EstimateOutcome>>();

/**
 * Ключ репозитория: имя папки (читаемо на экране) + 8 знаков sha256 общего каталога git —
 * копия-worktree и основная папка дают один ключ, два одноимённых репозитория — два.
 */
export function repoKeyOf(top: string, common: string): string {
  const hash = createHash('sha256').update(common.toLowerCase()).digest('hex').slice(0, 8);
  return `${basename(top)}-${hash}`;
}

function viewOf(registry: TaskRegistry, taskId: string): TaskFoldState | undefined {
  try {
    return registry.live(taskId)?.state ?? registry.view(taskId);
  } catch {
    // Нечитаемый журнал чужой задачи не мешает найти свою.
    return undefined;
  }
}

/** Задача, созданная оценкой с этим `cmdId` (G5: повтор — поиск, а не вторая задача). */
export function taskOfOrigin(registry: TaskRegistry, cmdId: string): string | undefined {
  return registry.list().find((s) => viewOf(registry, s.taskId)?.created?.origin?.cmdId === cmdId)
    ?.taskId;
}

/**
 * Числа оценки из истории (03:157, `estimateFromHistory` зоны E) — строкой журнала на создании:
 * повтор того же `cmdId` отвечает теми же числами, а не пересчётом по выросшей с тех пор истории.
 */
export const ESTIMATE_HISTORY_SIGNAL = 'estimate-history';

const NO_HISTORY: EstimateReply['estimate'] = {
  minutes: null,
  tokens: null,
  spread: null,
  basis: 'no-history',
};

/**
 * Слой человека и гранты на создании (07:23-24, 06:108-112): строкой журнала, как числа оценки, —
 * повтор того же `cmdId` отвечает тем же отчётом, а не перечитанным с тех пор слоем.
 */
export const USER_LAYER_REPORT_SIGNAL = 'user-layer-report';
/** Свои пути единицы 0 (G6): своё всё — гранты спрашиваются по всем записям её репозиториев. */
const UNIT_ZERO_OWNED: readonly string[] = ['**'];
/** Предупреждений в строке: длинный слой не раздувает журнал, остаток назван числом. */
const WARNINGS_MAX = 100;

/**
 * Отчёт слоя, пока опись не собрана: хеша нет, причина названа — экран запуска не показывает
 * «пустой слой» там, где слой не читали.
 */
function layerNotRead(reason = 'user layer inventory not built'): EstimateReply['userLayer'] {
  return {
    hash: null,
    asked: { hooks: 'on', skills: 'on' },
    ran: { hooks: 'on', skills: 'on' },
    detail: [reason],
    warnings: [],
    sources: 0,
  };
}

interface LaunchLayerRead {
  report: EstimateReply['userLayer'];
  grants: EstimateReply['grants'];
}

/**
 * Опись и линт до создания (хеш — поле `task.created`). Линт только показывается: ни одно решение
 * его не читает (P36), поэтому он не входит ни в хеш, ни в отказ. Сбой порта — слой не прочитан.
 */
async function readLaunchLayer(
  env: SplitEnv,
  repos: readonly { repoKey: string; path: string }[],
  mask: (text: string) => string,
): Promise<LaunchLayerRead> {
  const grants = grantConfirmations(env.grantRequired?.() ?? [], repos, UNIT_ZERO_OWNED);
  if (!env.userLayer) return { report: layerNotRead(), grants };
  let layer: LaunchLayer;
  try {
    layer = await env.userLayer(repos);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { report: layerNotRead(`user layer inventory failed: ${reason}`), grants };
  }
  const all = layer.inventory ? launchLint(layer.inventory, layer.texts, mask) : [];
  const warnings = all.slice(0, WARNINGS_MAX);
  const detail = [...layer.detail];
  if (!layer.inventory && detail.length === 0) detail.push('user layer inventory not read');
  if (all.length > warnings.length)
    detail.push(`launch lint: ${all.length - warnings.length} more warnings not shown`);
  return {
    report: {
      hash: layer.inventory?.hash ?? null,
      asked: layer.asked,
      ran: layer.ran,
      detail,
      warnings,
      sources: layer.inventory?.sources.length ?? 0,
    },
    grants,
  };
}

function launchLayerOfDetail(detail: string): LaunchLayerRead | null {
  try {
    const v = JSON.parse(detail) as LaunchLayerRead;
    return v && typeof v === 'object' && v.report && Array.isArray(v.grants) ? v : null;
  } catch {
    return null;
  }
}

function estimateOfDetail(detail: string): EstimateReply['estimate'] {
  try {
    const v = JSON.parse(detail) as EstimateReply['estimate'];
    return v.basis === 'history' ? v : NO_HISTORY;
  } catch {
    return NO_HISTORY;
  }
}

/** Выученное по законченным журналам дома ядра; нечитаемо — «истории нет», а не отказ оценки. */
async function historyEstimate(
  registry: TaskRegistry,
  env: SplitEnv,
  scenarioId: string,
  projects: readonly string[],
): Promise<EstimateReply['estimate']> {
  const table = env.history
    ? await env.history()
    : await readLearned({
        tasksDir: registry.tasksDir,
        cacheFile: learnedCachePath(dirname(registry.tasksDir)),
      }).then((f) => ('value' in f ? f.value : null));
  return table ? estimateFromHistory(table, { scenarioId, projects }) : NO_HISTORY;
}

/** Ответ по журналу задачи — один и для первого ответа, и для повтора. */
export function replyOfJournal(
  taskId: string,
  lines: readonly JournalLine[],
  replayed: boolean,
): EstimateReply {
  let preflight: PreflightRow[] = [];
  let problems: string[] = [];
  let rejected: EstimateReply['overlay']['rejected'] = [];
  let scenario: ScenarioRef | null = null;
  let estimate = NO_HISTORY;
  let layer: LaunchLayerRead | null = null;
  for (const l of lines) {
    if (l.kind === 'task.created') scenario = (l as JournalLine<'task.created'>).data.scenario;
    if (l.kind === 'scenario.overlay')
      rejected = (l as JournalLine<'scenario.overlay'>).data.rejected;
    if (l.kind !== 'signal') continue;
    const s = (l as JournalLine<'signal'>).data;
    if (s.signal === PREFLIGHT_SIGNAL && s.subject === 'estimate')
      preflight = rowsOfSignal(s.detail);
    if (s.signal === ESTIMATE_REFUSED_SIGNAL)
      problems = jsonArray(s.detail).filter((p): p is string => typeof p === 'string');
    if (s.signal === ESTIMATE_HISTORY_SIGNAL) estimate = estimateOfDetail(s.detail);
    if (s.signal === USER_LAYER_REPORT_SIGNAL) layer = launchLayerOfDetail(s.detail);
  }
  const refused = problems.length > 0 || preflight.some((r) => r.status === 'failed');
  return {
    taskId,
    seq: lines.at(-1)?.seq ?? 0,
    state: refused ? 'refused' : 'estimating',
    replayed,
    preflight,
    overlay: { rejected },
    scenario,
    problems,
    estimate,
    userLayer: layer?.report ?? layerNotRead(),
    grants: layer?.grants ?? [],
  };
}

function replyOf(registry: TaskRegistry, taskId: string, replayed: boolean): EstimateReply {
  return replyOfJournal(taskId, linesAfter(join(registry.tasksDir, taskId), taskId, 0), replayed);
}

/** Ссылка на сценарий из тела: пресет — его последняя версия в коде. */
export function scenarioRefOf(scenario: EstimateBody['fields']['scenario']): ScenarioRef {
  if (!('preset' in scenario)) return scenario;
  const latest = latestPresets().find((p) => p.id === scenario.preset);
  return { id: scenario.preset, version: latest?.version ?? 1 };
}

type PinnedRepo = PinnedRepoView;

/** Каждый репозиторий: корень, ключ, база. Все препятствия разом — человек правит один раз. */
export async function pinRepos(
  repos: EstimateBody['fields']['repos'],
  env: SplitEnv,
): Promise<{ pinned: PinnedRepo[]; problems: string[] }> {
  const pinned: PinnedRepo[] = [];
  const problems: string[] = [];
  for (const r of repos) {
    const tree = await env.workTreeOf(r.path);
    if (!('value' in tree)) {
      problems.push(
        `${r.path}: ${'absent' in tree ? 'not a git repository' : `unreadable: ${tree.unknown}`}`,
      );
      continue;
    }
    const repoKey = repoKeyOf(tree.value.top, tree.value.common);
    if (pinned.some((p) => p.repoKey === repoKey)) {
      problems.push(`${r.path}: same repository named twice (${repoKey})`);
      continue;
    }
    const base = await env.pinBase(tree.value.top, r.baseRef);
    if (!('value' in base)) {
      const ref = r.baseRef ?? 'default branch';
      problems.push(
        `${r.path}: base ${ref} ${'absent' in base ? 'not found' : `unreadable: ${base.unknown}`}`,
      );
      continue;
    }
    const { ref, sha, source, note } = base.value;
    pinned.push({ repoKey, path: tree.value.top, sha, pin: { ref, source, note } });
  }
  return { pinned, problems };
}

const scenarioProblems = (refusals: readonly { level: number; source: string; reason: string }[]) =>
  refusals.map((r) => `scenario level ${r.level} ${r.source}: ${r.reason}`);

/** Задача создана, но не сделана: отказ с причинами — переход в `failed` и конец задачи. */
export function refuse(task: LiveTask, problems: string[] | null, cmdId: string): void {
  if (problems)
    task.append({
      kind: 'signal',
      actor: 'core',
      cmdId,
      data: {
        signal: ESTIMATE_REFUSED_SIGNAL,
        severity: 'stop',
        subject: 'estimate',
        detail: JSON.stringify(problems),
      },
    });
  const moved = task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'fail', from: task.state.task, to: 'failed' },
  });
  task.append({
    kind: 'task.ended',
    actor: 'core',
    cmdId,
    cause: moved.seq,
    data: { outcome: 'failed' },
  });
}

/**
 * Единица 0 (G6): одна, в первом репозитории, своё всё — план читает и предлагает деление. Ветка —
 * своя `agentdeck/<id8>`, если создающий не назвал чужую (ответы ревьюерам — ветка MR, F11).
 */
export function unitZeroOf(repoKey: string, branch?: string): JournalDataV1['unit.created'] {
  const unitId = newId();
  return {
    unitId,
    name: 'estimate',
    repoKey,
    branch: branch ?? `agentdeck/${unitId.slice(-8)}`,
    ownedPaths: [...UNIT_ZERO_OWNED],
    after: [],
    contract: false,
    splitId: null,
  };
}

/**
 * Создать задачу одним путём (оценка человека и задача ответов ревьюерам, 05:77): база, запрос,
 * сценарий, предпроверка, единица 0. `seed` — только дополнения создающего: проверка приколотой
 * базы до создания, свои строки после `task.created` и после единицы 0, ветка единицы 0.
 */
export async function createTask(
  body: EstimateBody,
  registry: TaskRegistry,
  env: SplitEnv,
  seed: CreateSeed = {},
): Promise<EstimateOutcome> {
  const { fields, cmdId } = body;
  const { pinned, problems } = await pinRepos(fields.repos, env);
  if (problems.length > 0) return { status: 422, problems };
  const vetoed = seed.checkPinned ? await seed.checkPinned(pinned) : [];
  if (vetoed.length > 0) return { status: 422, problems: vetoed };
  const ref = scenarioRefOf(fields.scenario);
  const repos = pinned.map((p) => ({ repoKey: p.repoKey, path: p.path }));
  const scenario = await resolveScenario(ref, repos, { libraryDir: env.libraryDir });
  const routes = env.allowedRoutes();
  const layer = await readLaunchLayer(env, repos, (t) => registry.mask(t).text);
  // Предпроверка — до создания: её сбой (исключение) не оставляет задачу без единицы.
  const preflight = scenario.ok
    ? await runTaskPreflight(repos, routes.routes, env, publishesOf(scenario.scenario.steps))
    : null;
  if (seed.refuseBeforeCreate) {
    if (!scenario.ok) return { status: 422, problems: scenarioProblems(scenario.refusals) };
    if (preflight && !preflight.start)
      return {
        status: 422,
        problems: preflight.rows
          .filter((r) => r.status === 'failed')
          .map((r) => `preflight ${r.road}: ${r.detail}`),
      };
  }
  const task = await registry.create({
    title: fields.title,
    repos: pinned.map((p) => ({ repoKey: p.repoKey, path: p.path, baseRef: p.sha })),
    build: env.build,
    scenario: ref,
    profilePins: [],
    modelCeiling: null,
    userLayerHash: layer.report.hash,
    envPin: '',
    requirementsSource: REQUEST_ARTIFACT,
    allowedRoutes: routes.routes,
    routesSourceLevel: routes.level,
    origin: { cmdId },
    launchPolicy: fields.launchPolicy,
    ciWait: fields.ciWait,
  });
  // Запрос под маской DLP, как и журнал: секрет из запроса не ложится на диск открытым.
  createExclusive(join(task.dir, REQUEST_ARTIFACT), registry.mask(fields.request).text);
  // Причина задачи — сразу за её созданием: отказ сценария или дороги ниже её не стирает.
  seed.opened?.(task, cmdId);
  for (const p of pinned) {
    task.append({
      kind: 'signal',
      actor: 'core',
      cmdId,
      data: {
        signal: BASE_PIN_SIGNAL,
        severity: p.pin.source === 'fresh' ? 'info' : 'warn',
        subject: p.repoKey,
        detail: basePinDetail(p.pin.ref, p.sha, p.pin.note),
      },
    });
  }
  // Ни порта слоя, ни грантов — писать нечего: ответ по журналу и так «слой не читали».
  if (env.userLayer || env.grantRequired)
    task.append({
      kind: 'signal',
      actor: 'core',
      cmdId,
      data: {
        signal: USER_LAYER_REPORT_SIGNAL,
        severity: layer.report.warnings.length > 0 || layer.report.hash === null ? 'warn' : 'info',
        subject: 'estimate',
        detail: JSON.stringify(layer),
      },
    });
  if (!scenario.ok || !preflight) {
    refuse(task, scenario.ok ? null : scenarioProblems(scenario.refusals), cmdId);
    return { status: 202, reply: replyOf(registry, task.taskId, false) };
  }
  task.append({
    kind: 'scenario.overlay',
    actor: 'core',
    cmdId,
    data: { scenario: ref, applied: scenario.overlay.applied, rejected: scenario.overlay.rejected },
  });
  // Решение старшинства (G1, P80) — то же, что пишут правка сценария и запуск деления над тем же входом.
  task.append({
    kind: 'decision',
    actor: 'core',
    cmdId,
    data: { decisionId: newId(), ...scenarioPrecedence(scenario, routes) },
  });
  journalPreflight(task, 'estimate', preflight, cmdId);
  if (!preflight.start) {
    refuse(task, null, cmdId);
    return { status: 202, reply: replyOf(registry, task.taskId, false) };
  }
  const numbers = await historyEstimate(
    registry,
    env,
    ref.id,
    pinned.map((p) => p.repoKey),
  );
  task.append({
    kind: 'signal',
    actor: 'core',
    cmdId,
    data: {
      signal: ESTIMATE_HISTORY_SIGNAL,
      severity: 'info',
      subject: 'estimate',
      detail: JSON.stringify(numbers),
    },
  });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'estimate', from: 'draft', to: 'estimating' },
  });
  const zero = unitZeroOf((pinned[0] as PinnedRepo).repoKey, seed.branch);
  task.append({ kind: 'unit.created', actor: 'core', unitId: zero.unitId, cmdId, data: zero });
  seed.afterUnitZero?.(task, zero, cmdId);
  return { status: 202, reply: replyOf(registry, task.taskId, false) };
}

/**
 * Повтор оценки, уже создавшей задачу: ответ по журналу, без суда полномочий — как известный исход
 * команды (`refuseBeforeOpen`): одноразовое число первого звонка уже сгорело, и повтор после
 * потерянного ответа иначе получил бы 403 вместо своей задачи.
 */
export function replayEstimate(registry: TaskRegistry, cmdId: string): EstimateReply | undefined {
  if (inflight.has(cmdId)) return undefined;
  const known = taskOfOrigin(registry, cmdId);
  return known ? replyOf(registry, known, true) : undefined;
}

/** Сценарий задачи ответов ревьюерам: её открывает только опрос форжа (`openAnswerTask`). */
export const ANSWER_REVIEWERS_PRESET = 'answer-reviewers';

/**
 * Отказ оценки человека: `answer-reviewers` без личности MR не к чему привязать — публикатор
 * открыл бы новый MR вместо ответа в старом. Эту задачу открывает только опрос форжа, по MR
 * законченной задачи (05:77).
 */
export const ANSWER_PRESET_PROBLEM =
  `scenario ${ANSWER_REVIEWERS_PRESET}: opened only by the forge poller for the MR of a finished ` +
  'task (it needs the MR identity); pick another scenario';

export async function estimateTask(
  body: EstimateBody,
  registry: TaskRegistry,
  env: SplitEnv,
): Promise<EstimateOutcome> {
  // Тот же `cmdId` ещё создаётся — дождаться и ответить повтором, а не создать вторую задачу.
  const running = inflight.get(body.cmdId);
  if (running) await running.catch(() => undefined);
  const known = taskOfOrigin(registry, body.cmdId);
  if (known) return { status: 200, reply: replyOf(registry, known, true) };
  if (scenarioRefOf(body.fields.scenario).id === ANSWER_REVIEWERS_PRESET)
    return { status: 422, problems: [ANSWER_PRESET_PROBLEM] };
  const work = createTask(body, registry, env);
  inflight.set(body.cmdId, work);
  try {
    return await work;
  } finally {
    inflight.delete(body.cmdId);
  }
}
