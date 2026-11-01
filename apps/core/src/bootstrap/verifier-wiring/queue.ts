import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckRegistry,
  CheckRequest,
  QueueClass,
  ServiceRecipe,
  Unmet,
} from '@agentdeck/contracts/core/records';
import {
  createCheckService,
  idlePreRun,
  modelCheck,
  preRunCandidates,
  type CheckDeps,
  type CheckService,
  type ModelCheckContext,
  type PreRunOutcome,
  type PreRunScope,
} from '../../conductor/checks/index.ts';
import { changedUnitsOf } from '../../conductor/checks/scope.ts';
import { pinnedBaseOf, unitCopyOf } from '../../conductor/copy/index.ts';
import type { ModelToolDeps } from '../../conductor/model-tools/model-tools.types.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { commonDirSync, treeRows } from '../../platform/git.ts';
import { diskFree, diskVerdict, memFree, memVerdict } from '../../platform/machine.ts';
import { createLivenessProbe, identityOfPid } from '../../platform/process-identity.ts';
import { openAppendLog, type AppendLog } from '../../platform/safe-io/append-log.ts';
import { readBaseEnv } from '../../platform/base-env.ts';
import { isAbsolutePath, pathKey, pathListDelimiter } from '../../platform/paths.ts';
import { toolStamp } from '../../platform/tool-version.ts';
import { readQuarantine, writeQuarantine } from '../../verifier/flaky/index.ts';
import { envDigester, readKey } from '../../verifier/key/index.ts';
import { profileOf, registryOf, type ProfileDeps } from '../../verifier/profile/index.ts';
import { queueConfigReader } from '../../verifier/queue/config.ts';
import { DEFAULT_QUEUE_CONFIG } from '../../verifier/queue/order.ts';
import { createCheckQueue, type CheckQueue } from '../../verifier/queue/queue.ts';
import {
  createRecordStore,
  loadVerifyKey,
  storeRoot,
  type RecordStore,
} from '../../verifier/store/index.ts';
import { keyEnv } from './caller-env.ts';
import { checkServices } from './check-services.ts';
import { classRun, type ClassRunDeps } from './class-run.ts';
import { checkEconomy } from './economy.ts';
import type { WindowBook } from '../../economy/window/index.ts';
import { readPinnedProfile } from './pinned-profile.ts';
import type { ServicesWiring } from './services.ts';

/**
 * Зона C (очередь, прогон, единый вход проверки `requestCheck`). Всё ленивое: обвязка строится
 * при каждой сборке API (и в тестах без дома ядра), а очередь, ключ подписи и пин окружения нужны
 * только первой проверке. Инструмент модели `check` идёт сюда (`check`), ранние прогоны в
 * простое — `preRun` (зовёт дирижёр, когда единица закончена).
 *
 * Проверка шага идёт в копии его единицы от её закреплённой базы (G7); копии нет — в папке
 * репозитория задачи. Реестр — закреплённый снимок профиля задачи (G21, `pinned-profile.ts`), пока
 * он есть: сдвиг профиля посреди задачи называется, но набор проверок задачи не меняет.
 *
 * Пока не построено (названо, не скрыто): пауза и отмена задачи не снимают идущий прогон (только
 * срок p95×3); пин окружения — PATH оболочки входа и базовые переменные ОС, пока зона E не
 * закрепляет окружение задачи.
 *
 * Зона F: эпоха стенда — реестр стендов `services.stands` (сдвиг посреди прогона — `no-verdict
 * (stand)`); сервисы проверки с `needs` — `checkServices` (рецепты профиля, контейнер задачи,
 * адреса в окружение копии). Без `services` — эпоха `null`, а проверка с `needs` — `no-verdict`.
 * Классы `migration` и `contract` идут не раннером, а своими исполнителями (`class-run.ts`).
 */

/** Единицы репозитория для запроса: реестр, изменённые против базы и проверки по единицам. */
export interface CheckScope {
  registry: Fact<CheckRegistry>;
  registryUnits: string[];
  changedUnits: string[];
  packageChecks: string[];
}

export interface QueueWiring {
  check: NonNullable<ModelToolDeps['check']>;
  service(): Promise<Fact<CheckService>>;
  /** Вход и его чтения (хранилище, реестр, ключ) — дорогам захвата и забору очереди (волна 2). */
  parts(): Promise<Fact<{ service: CheckService; deps: CheckDeps }>>;
  /** База `null` (псевдозадача, итог из очереди) — изменёнными считаются все единицы (04:55). */
  /** `taskId` — реестр из закреплённого снимка профиля задачи (G21), если он есть. */
  scope(
    repo: { repoKey: string; path: string; baseRef: string | null },
    taskId?: string,
  ): Promise<CheckScope>;
  preRun(scope: PreRunScope): Promise<PreRunOutcome>;
}

export interface QueueWiringDeps {
  registry: Partial<Pick<TaskRegistry, 'live'>>;
  layout: Partial<CoreHomeLayout>;
  /** Зона F: стенды задач и сервисы проверок (`verifier-wiring/index.ts` передаёт свои). */
  services?: Pick<ServicesWiring, 'ensureServices' | 'stands'>;
  /** Исполнители классов migration/contract: тесты дают свой движок (внешняя граница). */
  classes?: Pick<ClassRunDeps, 'engine' | 'run'>;
  /** Книга окон ядра (G7): окно суда проверки — по маршруту сессии шага. Нет — открыто. */
  windows?: WindowBook;
  /** Секреты окружения сеанса (P61): выдержки ответа `check` модели маскируются и по значению. */
  known?(taskId: string, sessionId: string): readonly string[];
  /** Цифры машины; тесты дают свои (внешняя граница — ОС), иначе настоящие. */
  machine?: {
    diskFree: (path: string) => ReturnType<typeof diskFree>;
    memFree: () => ReturnType<typeof memFree>;
  };
}

/** Сборка ядра, которой выдаются аренды (00:70-71). */
export function coreBuild(): string {
  return process.env.AGENTDECK_CORE_BUILD ?? 'dev';
}

export function classOf(stepKind: string): QueueClass {
  if (stepKind.includes('fix')) return 'fix';
  if (stepKind.includes('review')) return 'review';
  if (stepKind.includes('deliver') || stepKind === 'publish') return 'deliver';
  return 'work';
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

/**
 * Каталоги профиля (`node_modules/.bin`, `.venv/bin`) — впереди PATH процесса проверки (A2-F06):
 * иначе `vitest`/`pytest` репозитория не находились, а находились чужие глобальные. Путь — внутри
 * копии: абсолютный или с `..` (профиль правит человек) не берётся. Имя переменной — как в пине
 * (Windows `Path`), без второй копии.
 */
export function withPathEntries(
  pin: Readonly<Record<string, string>>,
  copyDir: string,
  entries: readonly string[],
): Record<string, string> {
  const lead = entries
    .filter((rel) => rel !== '' && !isAbsolutePath(rel) && !rel.split(/[\\/]/).includes('..'))
    .map((rel) => join(copyDir, ...rel.split('/')));
  if (lead.length === 0) return { ...pin };
  const out = { ...pin };
  const name = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const delimiter = pathListDelimiter();
  const rest = (out[name] ?? '').split(delimiter).filter((d) => d !== '' && !lead.includes(d));
  out[name] = [...new Set(lead), ...rest].join(delimiter);
  return out;
}

/**
 * Профиль копии читается без записи (A2-F08): общий файл профиля держит основную копию, его пишет
 * только создание копии (`conductor/copy/create.ts`); копия посреди задачи затирала бы его своим.
 */
export const copyProfileDeps = (profilesDir: string): ProfileDeps => ({
  profilesDir,
  write: () => undefined,
});

/** Версия среды для корня записи (A2-F04): `node@svc` вложенного стека раньше общей `node`. */
export function runtimeOf<T>(
  runtimes: Readonly<Record<string, T>>,
  name: string,
  cwd: string,
): T | undefined {
  return (cwd === '' ? undefined : runtimes[`${name}@${cwd}`]) ?? runtimes[name];
}

interface Ready {
  service: CheckService;
  queue: CheckQueue;
  deps: CheckDeps;
}

export function queueWiring(deps: QueueWiringDeps): QueueWiring {
  let ready: Promise<Fact<Ready>> | null = null;
  let log: AppendLog | null = null;
  const stores = new Map<string, RecordStore>();
  let pin: Promise<Record<string, string>> | null = null;

  const layout = (): Fact<CoreHomeLayout> => {
    const l = deps.layout;
    return l.root && l.queue && l.config && l.logs && l.profiles
      ? { value: l as CoreHomeLayout }
      : { unknown: 'core home not laid out' };
  };

  function note(line: Record<string, unknown>): void {
    const l = layout();
    if (!('value' in l)) return;
    try {
      log ??= openAppendLog(join(l.value.logs, 'core.jsonl'));
      log.append(Buffer.from(`${JSON.stringify({ at: Date.now(), area: 'queue', ...line })}\n`));
    } catch {
      // Журнал ядра не открылся — очередь работает дальше; событие теряется, не прогон.
    }
  }

  const machine = deps.machine ?? { diskFree, memFree };
  const doubts = new Map<'disk' | 'memory', string>();
  /**
   * Сомнение в цифрах машины (A1r3-F12) не молчит: одна строка `machine-doubt` на смену причины —
   * плитка его покажет. Работа идёт дальше (сомнение не повод держать очередь), но не скрыто.
   */
  function doubtOf(subject: 'disk' | 'memory', verdict: { kind: string; reason?: string }): void {
    if (verdict.kind !== 'doubt') {
      doubts.delete(subject);
      return;
    }
    const reason = verdict.reason ?? 'unknown';
    if (doubts.get(subject) === reason) return;
    doubts.set(subject, reason);
    note({ kind: 'machine-doubt', subject, reason });
  }

  function taskOf(taskId: string): LiveTask | undefined {
    return deps.registry.live?.(taskId);
  }

  function repoOf(req: { taskId: string; project: string }) {
    return taskOf(req.taskId)?.state.created?.repos.find((r) => r.repoKey === req.project);
  }

  /**
   * База прогона по его cwd: копия единицы — её закреплённая база, папка репозитория — `baseRef`
   * задачи; не узнана — `null` (контракт без вердикта, не «нет изменений»).
   */
  function baseOfRun(taskId: string, cwd: string): string | null {
    const task = taskOf(taskId);
    if (!task) return null;
    const inside = (dir: string): boolean => {
      const a = pathKey(cwd);
      const b = pathKey(dir);
      return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
    };
    for (const unitId of Object.keys(task.state.units)) {
      const copy = unitCopyOf(task, unitId);
      if (copy && inside(copy.dir)) {
        const repo = task.state.created?.repos.find(
          (r) => r.repoKey === task.state.units[unitId]?.repoKey,
        );
        return pinnedBaseOf(task, unitId) ?? repo?.baseRef ?? null;
      }
    }
    return task.state.created?.repos.find((r) => inside(r.path))?.baseRef ?? null;
  }

  /** Реестр закреплённого снимка профиля задачи (G21); снимка нет — `undefined`, читается живой. */
  function pinnedRegistry(req: {
    taskId: string;
    project: string;
  }): Promise<Fact<CheckRegistry>> | undefined {
    const profiles = deps.layout.profiles;
    const fp = taskOf(req.taskId)?.state.created?.profilePins.find(
      (p) => p.repoKey === req.project,
    )?.inputsFp;
    if (!profiles || !fp) return undefined;
    const snap = readPinnedProfile(profiles, fp);
    return snap ? Promise.resolve({ value: snap.registry }) : undefined;
  }

  function storeOf(root: string, home: string): Fact<RecordStore> {
    const known = stores.get(root);
    if (known) return { value: known };
    const key = loadVerifyKey(home);
    if (!('value' in key)) return { unknown: `verify key: ${why(key)}` };
    const store = createRecordStore({ root, key: key.value });
    stores.set(root, store);
    return { value: store };
  }

  function storeDir(req: CheckRequest): Fact<string> {
    const common = commonDirSync(req.copyDir);
    return 'value' in common ? { value: storeRoot(common.value) } : common;
  }

  async function envPin(): Promise<Record<string, string>> {
    // Неудачное чтение не запоминается: отвергнутый промис в кэше отвечал бы отказом всю жизнь ядра.
    pin ??= readBaseEnv({ temp: false }).catch((error: unknown) => {
      pin = null;
      throw error;
    });
    return pin;
  }

  async function build(): Promise<Fact<Ready>> {
    const l = layout();
    if (!('value' in l)) return l;
    const home = l.value;
    const me = await identityOfPid(process.pid);
    if (!('value' in me)) return { unknown: `own process identity: ${why(me)}` };
    const probe = createLivenessProbe();
    const queue = createCheckQueue({
      dir: home.queue,
      config: queueConfigReader(home.config, DEFAULT_QUEUE_CONFIG, (issue) =>
        note({ kind: 'config', issue }),
      ),
      holder: { pid: process.pid, start: me.value.start, bootId: newId() },
      build: coreBuild(),
      now: Date.now,
      newId,
      isAlive: (id) => probe.isAlive(id),
      lowMemory: () => {
        const mem = memVerdict(machine.memFree());
        doubtOf('memory', mem);
        return mem.kind === 'low';
      },
      onEvent: (event) => note({ ...event }),
    });
    // Ключ подписи не прочитан (второе ядро ещё пишет файл) — не на всю жизнь процесса:
    // следующий запрос читает снова, как verify.ts.
    let verifyKey = loadVerifyKey(home.root);
    let digest = 'value' in verifyKey ? envDigester(verifyKey.value) : null;
    const digester = (): typeof digest => {
      if (digest) return digest;
      verifyKey = loadVerifyKey(home.root);
      digest = 'value' in verifyKey ? envDigester(verifyKey.value) : null;
      return digest;
    };
    const profileDeps = copyProfileDeps(home.profiles);
    const checkDeps: CheckDeps = {
      queue,
      store: (req) => {
        const dir = storeDir(req);
        return 'value' in dir ? storeOf(dir.value, home.root) : dir;
      },
      registry: (req) =>
        pinnedRegistry(req) ?? registryOf({ repoKey: req.project, path: req.copyDir }, profileDeps),
      key: async ({ req, entry, registry, unit, selection }) => {
        const envDigest = digester();
        if (!envDigest) return { unknown: `verify key: ${why(verifyKey)}` };
        const profile = await profileOf({ repoKey: req.project, path: req.copyDir }, profileDeps);
        const runtimes = 'value' in profile ? profile.value.runtimes : {};
        const tools: Record<string, string> = {};
        const env = await envPin();
        // Отпечаток — того, что найдёт процесс проверки: по его PATH (каталоги профиля впереди).
        const runEnv = keyEnv(
          withPathEntries(env, req.copyDir, 'value' in profile ? profile.value.pathEntries : []),
          req,
        );
        // Инструмент в ключе — объявленная версия И отпечаток установленного: без объявления
        // заглушка `unknown` совпала бы у node 20 и 22. Отпечаток не прочитан — ключа нет.
        for (const name of entry.tools) {
          const stamp = toolStamp(name, req.copyDir, runEnv);
          if (!('value' in stamp)) return { unknown: `tool ${why(stamp)}` };
          tools[name] = `${runtimeOf(runtimes, name, entry.cwd)?.version ?? '-'}|${stamp.value}`;
        }
        return readKey({
          repo: req.copyDir,
          entry,
          registry,
          unit,
          selection,
          rev: 'worktree',
          baseRev: repoOf(req)?.baseRef ?? null,
          tools,
          env: keyEnv(env, req),
          envDigest,
        });
      },
      // Только процесс проверки получает каталоги профиля (A2-F06); сессия агента — никогда.
      env: async (req) => {
        const env = await envPin();
        const profile = await profileOf({ repoKey: req.project, path: req.copyDir }, profileDeps);
        return {
          value: withPathEntries(
            env,
            req.copyDir,
            'value' in profile ? profile.value.pathEntries : [],
          ),
        };
      },
      standEpoch: (taskId) => deps.services?.stands.standEpoch(taskId) ?? null,
      ...(deps.services
        ? {
            services: checkServices({
              registry: deps.registry,
              services: deps.services,
              profilesDir: home.profiles,
            }),
          }
        : {}),
      journal: (taskId, entry) => {
        const task = taskOf(taskId);
        if (!task) throw new Error(`task ${taskId} is not live`);
        task.append({
          kind: entry.kind,
          actor: 'core',
          ...(entry.stepId ? { stepId: entry.stepId } : {}),
          data: entry.data,
        } as never);
      },
      // Строка, что журнал задачи не принял, — в журнал ядра с причиной, не в тишину (A1r4-F10).
      onJournalLoss: (taskId, kind, reason) =>
        note({ kind: 'journal-loss', taskId, line: kind, reason }),
      tempRoot: join(home.root, 'tmp', 'checks'),
      run: classRun({
        ...deps.classes,
        baseOf: (spec) => baseOfRun(spec.taskId, spec.cwd),
        recipes: async (taskId) => {
          const out: ServiceRecipe[] = [];
          for (const repo of taskOf(taskId)?.state.created?.repos ?? []) {
            const p = await profileOf({ repoKey: repo.repoKey, path: repo.path }, profileDeps);
            if ('value' in p) out.push(...p.value.serviceRecipes);
          }
          return out;
        },
      }),
      now: Date.now,
      newId,
      quarantine: (req) => {
        const dir = storeDir(req);
        return 'value' in dir ? readQuarantine(dir.value) : dir;
      },
      writeQuarantine: (req, entries) => {
        const dir = storeDir(req);
        if ('value' in dir) writeQuarantine(dir.value, entries);
      },
      // Окно маршрута шага и разовый fresh-перезапуск (этап 5): книга окон ядра и журнал задачи.
      ...checkEconomy({ registry: deps.registry, windows: deps.windows }),
      blockers: async (): Promise<Unmet[]> => {
        const disk = diskVerdict(await machine.diskFree(home.root));
        doubtOf('disk', disk);
        return disk.kind === 'low'
          ? [
              {
                code: 'disk',
                subject: `free ${disk.free.freeBytes} bytes below ${disk.thresholdBytes}`,
                next: 'free disk space; the check runs when it is back above the threshold',
              },
            ]
          : [];
      },
    };
    return { value: { service: createCheckService(checkDeps), queue, deps: checkDeps } };
  }

  function ensure(): Promise<Fact<Ready>> {
    ready ??= build().then((fact) => {
      // Неудача не запоминается: дом ядра или ключ могли появиться к следующему вызову.
      if (!('value' in fact)) ready = null;
      return fact;
    });
    return ready;
  }

  async function scopeOf(
    repo: { repoKey: string; path: string; baseRef: string | null },
    taskId?: string,
  ): Promise<CheckScope> {
    const registry: Fact<CheckRegistry> = await ((taskId
      ? pinnedRegistry({ taskId, project: repo.repoKey })
      : undefined) ??
      registryOf(
        { repoKey: repo.repoKey, path: repo.path },
        copyProfileDeps((deps.layout.profiles as string | undefined) ?? ''),
      ));
    let changedUnits: string[] = [];
    if ('value' in registry) {
      const [rows, baseRows] = await Promise.all([
        treeRows(repo.path, 'worktree'),
        repo.baseRef === null ? null : treeRows(repo.path, repo.baseRef),
      ]);
      // Дерево не прочиталось или базы нет — изменёнными считаются все единицы: сомнение → прогон (04:55).
      changedUnits =
        'value' in rows && baseRows && 'value' in baseRows
          ? changedUnitsOf(registry.value, rows.value, baseRows.value)
          : Object.keys(registry.value.units);
    }
    return {
      registry,
      registryUnits: 'value' in registry ? Object.keys(registry.value.units) : [],
      changedUnits,
      packageChecks:
        'value' in registry
          ? registry.value.checks.filter((c) => c.unit === 'package').map((c) => c.id)
          : [],
    };
  }

  async function contextOf(
    task: LiveTask,
    b: { stepId: string; stepKind: string; sessionId?: string },
  ): Promise<Fact<ModelCheckContext>> {
    const created = task.state.created;
    // Проверка шага идёт в копии его единицы (G7), от её закреплённой базы; копии ещё нет
    // (псевдозадача, шаг без единицы) — в папке репозитория задачи, как до копий.
    const unitId = task.state.steps[b.stepId]?.unitId;
    const unitRepoKey = unitId ? task.state.units[unitId]?.repoKey : undefined;
    const repo = created?.repos.find((r) => r.repoKey === unitRepoKey) ?? created?.repos[0];
    if (!created || !repo) return { unknown: 'task has no repository pinned' };
    const copy = unitId ? unitCopyOf(task, unitId) : undefined;
    const copyDir = copy?.dir ?? repo.path;
    const baseRef = (unitId ? pinnedBaseOf(task, unitId) : undefined) ?? repo.baseRef;
    const scope = await scopeOf({ repoKey: repo.repoKey, path: copyDir, baseRef }, task.taskId);
    return {
      value: {
        taskId: task.taskId,
        stepId: b.stepId,
        project: repo.repoKey,
        copyDir,
        class: classOf(b.stepKind),
        phase: b.stepKind === 'final-gate' ? 'final' : 'mid-task',
        registryUnits: scope.registryUnits,
        changedUnits: scope.changedUnits,
        packageChecks: scope.packageChecks,
        ...(deps.known && b.sessionId ? { known: deps.known(task.taskId, b.sessionId) } : {}),
      },
    };
  }

  return {
    async check(task, b, call) {
      const ready = await ensure();
      if (!('value' in ready))
        return { verdict: 'refused', reason: `verifier not ready: ${why(ready)}` };
      const ctx = await contextOf(task, b);
      if (!('value' in ctx)) return { verdict: 'refused', reason: why(ctx) };
      return modelCheck(ready.value.service, call, ctx.value);
    },
    async service() {
      const ready = await ensure();
      return 'value' in ready ? { value: ready.value.service } : ready;
    },
    async parts() {
      const ready = await ensure();
      return 'value' in ready
        ? { value: { service: ready.value.service, deps: ready.value.deps } }
        : ready;
    },
    scope: scopeOf,
    async preRun(scope) {
      const ready = await ensure();
      if (!('value' in ready)) return { answers: [], stopped: why(ready) };
      const registry = await (pinnedRegistry({ taskId: scope.taskId, project: scope.project }) ??
        registryOf(
          { repoKey: scope.project, path: scope.copyDir },
          copyProfileDeps((deps.layout.profiles as string | undefined) ?? ''),
        ));
      if (!('value' in registry)) return { answers: [], stopped: `registry: ${why(registry)}` };
      return idlePreRun(
        ready.value.service,
        ready.value.queue,
        preRunCandidates(registry.value, scope),
      );
    },
  };
}
