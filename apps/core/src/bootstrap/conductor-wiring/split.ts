import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { CORE_MCP_SERVER } from '@agentdeck/contracts/core/model-tools';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { SplitEnv } from '../../conductor/estimate/index.ts';
import { raiseHumanPoint } from '../../conductor/human/raise.ts';
import { createAdapterRegistry, type AdapterRegistry } from '../../adapters/index.ts';
import { needsServicesOf, roadProbes } from '../../conductor/preflight/index.ts';
import type { AllowedRoute } from '../../conductor/preflight/road-probes.ts';
import { cliLoginRouteId } from '../../routes/cli-login/cli-login.ts';
import type {
  BriefSection,
  ConductorHooks,
  HookVerdict,
  StepCtx,
  UnitCtx,
} from '../../conductor/run/run.types.ts';
import { resolveScenario } from '../../conductor/scenario/index.ts';
import { learnedFor, readLearnedDurations } from '../../conductor/schedule/index.ts';
import { linesOf, runSoloWithoutSplitPoint, runSplitPoint } from '../../conductor/split/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { unitBaseOf } from '../../conductor/units/index.ts';
import { workTreeOf } from '../../platform/git/common-dir.ts';
import { pinBase, remotesOf } from '../../platform/git/fetch.ts';
import { readChangedFiles, readHistory, readTrackedFiles } from '../../platform/git/history.ts';
import { decideOwnership, ownershipBrief } from '../../policy/ownership/index.ts';
import { coreMcpServers } from '../../mcp/main.ts';
import { CAPTURE_SHIM } from '../../platform/capture-shim.ts';
import { foldsCaseAt } from '../../platform/paths.ts';
import { withPath } from '../../platform/os-kind.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { DEFAULT_NODE_ARGV } from '../session-road.ts';
import { grantRequiredPort, launchLayerPort } from '../user-layer-wiring/launch-layer.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { createChildTasks, xlChildrenPort } from '../../conductor/split/index.ts';
import type { XlPort } from '../../conductor/run/run.types.ts';
import { processPin } from './session-start.ts';

/**
 * Зона D этапа 4 — оценка и деление. Здесь и только здесь собирается среда деления — одна на
 * сборку дирижёра (`splitEnvFor` по тем же `deps`); дирижёр отдаёт её на своей ручке, а ручка
 * `/v1/estimate` и команды запуска берут её через порт среды команды. Карта владения — на старте
 * единицы и в брифе, деление — после шага плана (или разбора, где плана нет), суд владения —
 * после остальных шагов. Пробы дорог сессии (`cli`, `route`, `core-mcp`, `capture`) — над тем же, чем
 * пойдёт сессия: реестр переходников, реестр маршрутов загрузки, запись моста ядра дороги сессии,
 * прокладка захвата. Без реестра маршрутов дорога `route` — «not wired», и оценка честно отказывает.
 */

const ok: HookVerdict = { ok: true };
/**
 * Слоты единиц без распределителя мест (тесты проводки без него). С ним — действующая
 * параллельность задачи (этап 11, P141): min(профиль, `queue.sessionSlots`); маршрут `local:own`
 * держит своё одно место сам, деление его не знает.
 */
const UNIT_SLOTS = 2;
const FOLD_CASE = foldsCaseAt(undefined);
const OWNERSHIP_SIGNAL = 'ownership';
const HISTORY_HINT_COMMITS = 200;
const HINT_AREAS = 12;

/** Уровень источника разрешённых троек: выбор человека при запуске (06 §Precedence 2). */
const LAUNCH_LEVEL = 2;

/**
 * Разрешённые тройки новой задачи (11 §Policy): вход CLI каждого переходника, чей маршрут
 * `cli-login` настроен в реестре, любая модель. Выбора CLI в теле оценки нет, поэтому набор по
 * умолчанию — подписки всех настроенных CLI; ключ API и шлюз сюда не попадают никогда (подписка
 * раньше платного), их добавляет только человек живой командой `set-route`.
 */
export function launchAllowedRoutes(
  adapters: AdapterRegistry,
  routes: RouteRegistry | undefined,
): AllowedRoute[] {
  if (!routes) return [];
  const out: AllowedRoute[] = [];
  for (const adapter of adapters.ids()) {
    const route = routes.get(cliLoginRouteId(adapter));
    if (route?.kind !== 'cli-login') continue;
    out.push({ adapter, route: { kind: route.kind, id: route.id }, modelPattern: '*' });
  }
  return out;
}

let defaultAdapters: AdapterRegistry | undefined;

/**
 * Одна среда на одни `deps`: крючки деления и ручка дирижёра (`ConductorHandle.split`), через
 * которую её получают API и команды, держат один и тот же объект — подмена проб или подъёма
 * вопроса у одного видна другому, вторая среда не собирается.
 */
const envs = new WeakMap<ConductorWiringDeps, SplitEnv>();

export function splitEnvFor(deps: ConductorWiringDeps): SplitEnv {
  let env = envs.get(deps);
  if (!env) {
    env = buildSplitEnv(deps);
    envs.set(deps, env);
  }
  return env;
}

/**
 * Порт детей XL исполнителям (Q-2 s11): родитель ждёт детей и запускает следующую волну той же
 * средой деления (`splitEnvFor`), что и первую на запуске.
 */
export function xlPortFor(deps: ConductorWiringDeps): XlPort {
  const env = splitEnvFor(deps);
  return xlChildrenPort({
    registry: deps.registry,
    childTasks: (parent, splitId, units, only) =>
      env.childTasks
        ? env.childTasks(parent, splitId, units, only)
        : createChildTasks(deps.registry, env, parent, splitId, units, only),
    note: deps.note,
  });
}

function buildSplitEnv(deps: ConductorWiringDeps): SplitEnv {
  // Без реестра загрузки — переходники по умолчанию: их исполняемые файлы те же, подставной CLI
  // набора соответствия меняет только команду запуска.
  const adapters = deps.adapters ?? (defaultAdapters ??= createAdapterRegistry());
  // Мост ядра — та же запись, что дорога сессии кладёт в `mcpServers` шага (тот же node).
  const coreMcp = coreMcpServers(DEFAULT_NODE_ARGV)[CORE_MCP_SERVER];
  return {
    build: process.env.AGENTDECK_CORE_BUILD ?? 'dev',
    libraryDir: deps.layout.scenarios,
    allowedRoutes: () => ({
      routes: launchAllowedRoutes(adapters, deps.routes),
      level: LAUNCH_LEVEL,
    }),
    workTreeOf: (path) => workTreeOf(path),
    pinBase: (repo, baseRef) => pinBase(repo, baseRef),
    remotesOf: async (repo) => {
      try {
        return { value: await remotesOf(repo, {}) };
      } catch (error) {
        return { unknown: error instanceof Error ? error.message : String(error) };
      }
    },
    // Один вход предпроверки зоны E (машина, репозитории, движок зоны F) + дороги сессии зоны D.
    preflight: async (input, repos, allowed) =>
      deps.verifier.profile.preflight(
        { ...input, repos },
        roadProbes({
          allowed,
          // Явный путь из настройки ядра (`cliPaths`, F9) — тот же, с которым запустится сессия.
          cliOf: (id) => (adapters.cliOf ? adapters.cliOf(id) : adapters.get(id)?.images[0]),
          // Тот PATH, с которым сессия запустит CLI, — не PATH процесса ядра.
          env: withPath(
            process.env,
            await deps.road.searchPath(deps.loop ? deps.loop.pathPrefix : undefined),
          ),
          ...(deps.routes ? { routes: deps.routes } : {}),
          ...(coreMcp ? { coreMcp } : {}),
          capture: {
            preload: CAPTURE_SHIM,
            // Ручки захвата `boot-api.ts` ставит на тот же API, что принял оценку и команду запуска.
            endpointRegistered: typeof deps.verifier.capture.register === 'function',
          },
        }),
      ),
    // Сервисы нужны, если профиль хоть одного репозитория их требует; профиль не прочитан —
    // неизвестно, и движок проверяется (`needsServicesOf`).
    needsServices: async (repos) => {
      const each = await Promise.all(
        repos.map(async (r) => needsServicesOf(await deps.verifier.profile.profileOf(r))),
      );
      if (each.includes(true)) return true;
      return each.includes('unknown') ? 'unknown' : false;
    },
    // Выученное — одно чтение ядра: оценка и бюджет токенов исполнителя видят одну таблицу.
    ...(deps.history ? { history: deps.history } : {}),
    capacity: (task) => ({ slots: unitSlots(deps, task), minutes: null }),
    // Ожидание места первого сеанса на оценке ведущего (W3-16): занятость мест машины.
    ...(deps.allocator ? { sessionOccupancy: deps.allocator.occupancy } : {}),
    // Договор плана ведущего (этап 11): проверка куска — id реестра профиля его репозитория.
    checksOf: async (repo) => {
      const profile = await deps.verifier.profile.profileOf(repo);
      return 'value' in profile ? profile.value.registry.checks.map((c) => c.id) : null;
    },
    foldCase: FOLD_CASE,
    raise: (task, raise) => raiseHumanPoint(task, raise),
    // Слой человека на экране запуска: опись CLI разрешённого набора с тем же пином, что у сеанса.
    userLayer: launchLayerPort({
      adapters: () => {
        const ids = new Set(launchAllowedRoutes(adapters, deps.routes).map((r) => r.adapter));
        return [...ids].flatMap((id) => adapters.get(id) ?? []);
      },
      pin: (deps.loop ? deps.loop.pin : undefined) ?? (() => processPin()),
    }),
    grantRequired: grantRequiredPort(deps.layout),
    ...(deps.taskEnv ? { taskEnv: deps.taskEnv } : {}),
    // Дочерние задачи XL (W3-18): тот же путь оценки над этой же средой (`splitEnvFor` — одна на `deps`).
    childTasks: (parent, splitId, units, only) =>
      createChildTasks(deps.registry, splitEnvFor(deps), parent, splitId, units, only),
    // Сценарий без точки деления (проход по стенду): соло сразу на оценке, над этой же средой.
    soloWithoutSplitPoint: (task, scenario) =>
      runSoloWithoutSplitPoint(task, scenario, splitEnvFor(deps)),
  };
}

/** Сколько единиц задачи идут разом — то же число, что держит распределитель мест. */
function unitSlots(deps: ConductorWiringDeps, task?: LiveTask): number {
  return deps.allocator ? deps.allocator.parallelism(task) : UNIT_SLOTS;
}

function section(text: string): BriefSection {
  return { id: 'ownership', text, from: 'policy/ownership' };
}

/** Последний суд владения единицы — файлы вне своих путей для следующего брифа. */
function outsideOf(lines: readonly JournalLine[], unitId: string): string[] {
  let outside: string[] = [];
  for (const l of lines) {
    if (l.kind !== 'decision' || l.unitId !== unitId) continue;
    const d = (l as JournalLine<'decision'>).data;
    const out = d.output as { outside?: unknown } | null;
    if (d.class === 'ownership' && Array.isArray(out?.outside))
      outside = out.outside.filter((f): f is string => typeof f === 'string');
  }
  return outside;
}

/** Подсказка плану (02:65): области, менявшиеся чаще, и сколько единица там обычно идёт. */
async function planHint(task: LiveTask, deps: ConductorWiringDeps): Promise<string> {
  const layout = deps.layout;
  const repos = task.state.created?.repos ?? [];
  const learned = await readLearnedDurations(layout.tasks, new Set([task.taskId]));
  const parts: string[] = [
    `Repos of this task (name a unit's repo by key): ${repos.map((r) => `${r.repoKey} = ${r.path}`).join('; ')}.`,
    `Units run ${unitSlots(deps, task)} at a time.`,
  ];
  for (const r of repos) {
    const hist = await readHistory(r.path, r.baseRef, { commits: HISTORY_HINT_COMMITS });
    if (!('value' in hist)) {
      parts.push(`${r.repoKey}: git history unreadable, no area hint.`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const c of hist.value)
      for (const top of new Set(c.files.map((f) => f.split('/')[0] ?? f)))
        counts.set(top, (counts.get(top) ?? 0) + 1);
    const areas = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HINT_AREAS)
      .map(([area, n]) => {
        const ms = 'value' in learned ? learnedFor(learned.value, r.repoKey, [area]) : null;
        return `${area} (${n} commits${ms === null ? '' : `, ~${Math.round(ms / 60_000)} min per unit`})`;
      });
    parts.push(`${r.repoKey} busiest areas: ${areas.join(', ') || 'none'}.`);
  }
  return parts.join('\n');
}

async function scenarioSteps(
  task: LiveTask,
  env: SplitEnv,
): Promise<{ id: string; steps: readonly StepDef[] } | null> {
  const created = task.state.created;
  if (!created) return null;
  const ref = task.state.scenario?.ref ?? created.scenario;
  const got = await resolveScenario(ref, created.repos, { libraryDir: env.libraryDir });
  return got.ok ? { id: ref.id, steps: got.scenario.steps } : null;
}

async function knownFilesOf(task: LiveTask): Promise<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const r of task.state.created?.repos ?? []) {
    const files = await readTrackedFiles(r.path, r.baseRef);
    if ('value' in files) out[r.repoKey] = files.value;
  }
  return out;
}

/** Суд владения после шага (02:74): правка вне своих путей — сигнал и решение, не отказ. */
async function judgeOwnership(task: LiveTask, s: StepCtx): Promise<Record<string, unknown>> {
  const unit = task.state.units[s.unitId];
  if (!unit || !s.copyDir || unit.ownedPaths.includes('**')) return {};
  const units = Object.entries(task.state.units).map(([unitId, u]) => ({ unitId, ...u }));
  const base = unitBaseOf(unit, units, task.state.created?.repos ?? []);
  if ('unknown' in base) return { ownership: base.unknown };
  const changed = await readChangedFiles(s.copyDir, base.kind === 'base' ? base.sha : base.branch);
  if (!('value' in changed))
    return { ownership: 'unknown' in changed ? changed.unknown : 'absent' };
  const verdict = decideOwnership(unit.ownedPaths, changed.value, FOLD_CASE);
  const line = task.append({
    kind: 'decision',
    actor: 'core',
    unitId: s.unitId,
    stepId: s.stepId,
    data: {
      decisionId: newId(),
      class: 'ownership',
      inputs: [],
      facts: [{ readClass: 'git.diff-unit', kind: 'value' }],
      numbers: { changed: changed.value.length, outside: verdict.outside.length },
      reasons: verdict.reasons,
      output: { verdict: verdict.verdict, outside: verdict.outside },
    },
  });
  if (verdict.verdict === 'outside') {
    task.append({
      kind: 'signal',
      actor: 'core',
      unitId: s.unitId,
      stepId: s.stepId,
      cause: line.seq,
      data: {
        signal: OWNERSHIP_SIGNAL,
        severity: 'warn',
        subject: s.unitId,
        detail: verdict.outside.join('\n'),
      },
    });
  }
  return { ownership: verdict.verdict, outside: verdict.outside.length };
}

export function splitHooks(deps: ConductorWiringDeps): ConductorHooks {
  return splitHooksWith(deps, splitEnvFor(deps));
}

/** Те же крючки над данной средой (тест подменяет пробы дорог и подъём вопроса). */
export function splitHooksWith(deps: ConductorWiringDeps, env: SplitEnv): ConductorHooks {
  const live = (taskId: string): LiveTask | undefined => deps.registry.live(taskId);
  return {
    async onUnitStart(u: UnitCtx) {
      const task = live(u.taskId);
      const unit = task?.state.units[u.unitId];
      if (!unit || unit.ownedPaths.includes('**')) return { verdict: ok, sections: [] };
      return { verdict: ok, sections: [section(ownershipBrief(unit.ownedPaths, []))] };
    },
    async preStep(s: StepCtx) {
      const task = live(s.taskId);
      if (!task) return { verdict: ok, sections: [] };
      if ((s.def.kind === 'plan' || s.def.kind === 'split') && task.state.task === 'estimating')
        return { verdict: ok, sections: [section(await planHint(task, deps))] };
      const unit = task.state.units[s.unitId];
      if (!unit || unit.ownedPaths.includes('**')) return { verdict: ok, sections: [] };
      const outside = outsideOf(linesOf(task), s.unitId);
      return { verdict: ok, sections: [section(ownershipBrief(unit.ownedPaths, outside))] };
    },
    async postStep(s: StepCtx, claim) {
      const task = live(s.taskId);
      if (!task) return { verdict: ok, facts: {} };
      if (task.state.task === 'estimating') {
        const scenario = await scenarioSteps(task, env);
        if (!scenario) return { verdict: ok, facts: { split: 'scenario unresolved' } };
        const done = await runSplitPoint(
          task,
          { stepId: s.stepId, def: s.def },
          claim,
          scenario,
          env,
          await knownFilesOf(task),
        );
        if (!done) return { verdict: ok, facts: {} };
        if (done.outcome.decision.verdict === 'refused') {
          const verdict: HookVerdict = {
            ok: false,
            stop: 'step',
            code: 'split-refused',
            reason: done.outcome.decision.reasons.join('; '),
          };
          return { verdict, facts: { splitId: done.outcome.splitId } };
        }
        return {
          verdict: ok,
          facts: { splitId: done.outcome.splitId, then: done.after?.kind ?? null },
        };
      }
      return { verdict: ok, facts: await judgeOwnership(task, s) };
    },
  };
}
