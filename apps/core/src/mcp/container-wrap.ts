import { join } from 'node:path';
import { runPassthrough } from '../platform/passthrough.ts';
import { COMPOSE_PROJECT_LABEL, composeProject, TASK_LABEL } from '../platform/resource-scan.ts';
import { runTool } from '../platform/run-tool.ts';
import { openAppendLog } from '../platform/safe-io/append-log.ts';
import type { ContainerCall, ContainerWrapSpec } from './container-wrap.types.ts';

export type { ContainerCall, ContainerWrapSpec } from './container-wrap.types.ts';

/**
 * Обёртка движка контейнеров сессии (01 §Resources, P58): то, что сессия создаёт, несёт метку
 * задачи и находится в конце шага. `run`/`create` (и `container run|create`) получают
 * `--label agentdeck.task=<id>` после глобальных опций движка (`docker --context x run …` —
 * подкоманда не первым словом); `compose` без своего имени проекта получает проект задачи
 * (`agentdeck-<id>`, метку `com.docker.compose.project` ставит сам compose). Остальное — как есть.
 *
 * Дыры меток (G18, P90): проект compose, названный САМИМ вызовом (`-p`, `COMPOSE_PROJECT_NAME`),
 * не подменяется — обёртка пишет в `<каталог сессии>/container-calls.jsonl` его имя и контейнеры
 * проекта ДО вызова: всё созданное после — ресурс задачи, снимается по id, никогда `compose down`
 * (чужие контейнеры проекта не трогаются). `docker-compose` (v1) получает проект задачи как
 * `compose`. `podman pod create` получает метку. `podman kube play` метку не передаёт: обёртка
 * пишет новые за вызов поды без метки задачи и контейнеры только этих подов (`createdByKubePlay`).
 */

export type ContainerEngine = 'docker' | 'podman' | 'docker-compose';

/** Журнал вызовов движка сессии: читает поиск ресурсов в конце шага (`session-road/resources.ts`). */
export const CONTAINER_CALLS_FILE = 'container-calls.jsonl';

/** Глобальные опции движка со значением отдельным словом (остальные `-x` — флаги). */
const VALUED: Record<ContainerEngine, ReadonlySet<string>> = {
  docker: new Set([
    '--config',
    '-c',
    '--context',
    '-H',
    '--host',
    '-l',
    '--log-level',
    '--tlscacert',
    '--tlscert',
    '--tlskey',
  ]),
  podman: new Set([
    '--cdi-spec-dir',
    '--cgroup-manager',
    '--config',
    '--conmon',
    '--connection',
    '-c',
    '--events-backend',
    '--hooks-dir',
    '--identity',
    '--imagestore',
    '--log-level',
    '--module',
    '--network-cmd-path',
    '--network-config-dir',
    '--out',
    '--registries-conf',
    '--root',
    '--runroot',
    '--runtime',
    '--runtime-flag',
    '--ssh',
    '--storage-driver',
    '--storage-opt',
    '--tmpdir',
    '--url',
    '--volumepath',
  ]),
  // `docker-compose` (v1): аргументы — сразу опции compose, глобальных опций движка нет.
  'docker-compose': new Set(),
};

/** Глобальные опции `compose` со значением отдельным словом. */
const COMPOSE_VALUED: ReadonlySet<string> = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--project-directory',
  '--env-file',
  '--profile',
  '--parallel',
  '--ansi',
  '--progress',
]);

/** Индекс подкоманды после глобальных опций; `args.length` — подкоманды нет. */
function subcommandAt(args: readonly string[], from: number, valued: ReadonlySet<string>): number {
  let i = from;
  while (i < args.length) {
    const word = args[i]!;
    if (word === '--') return i + 1;
    if (!word.startsWith('-') || word === '-') return i;
    i += !word.includes('=') && valued.has(word) ? 2 : 1;
  }
  return i;
}

/** Имя проекта из слова флага: `[значение, сколько слов занял]`; не флаг проекта — `undefined`. */
function projectFlag(args: readonly string[], i: number): [string, number] | undefined {
  const word = args[i]!;
  if (word === '-p' || word === '--project-name') return [args[i + 1] ?? '', 2];
  if (word.startsWith('--project-name=')) return [word.slice('--project-name='.length), 1];
  if (/^-p./.test(word)) return [word.slice(2), 1];
  return undefined;
}

/**
 * Своё имя проекта compose — как его выбирает сам compose: непустой флаг до подкоманды, иначе
 * непустая переменная окружения; нет — `undefined`. Пустой флаг (`-p ""` с пустой переменной
 * оболочки) — не имя: compose берёт имя каталога (ревью B2r2-F02, живой compose v5).
 */
export function ownProject(
  args: readonly string[],
  from: number,
  to: number,
  env: Record<string, string | undefined> = {},
): string | undefined {
  for (let i = from; i < to; i += 1) {
    const got = projectFlag(args, i);
    if (got && got[0] !== '') return got[0];
  }
  const named = env['COMPOSE_PROJECT_NAME'];
  return named ? named : undefined;
}

/** argv без пустых флагов проекта: иначе пустой флаг после нашего перебил бы проект задачи. */
function withoutEmptyProject(args: readonly string[], from: number, to: number): string[] {
  const out = args.slice(0, from);
  for (let i = from; i < args.length;) {
    const got = i < to ? projectFlag(args, i) : undefined;
    if (got && got[0] === '') {
      i += got[1];
      continue;
    }
    out.push(args[i]!);
    i += 1;
  }
  return out;
}

/** Где в argv лежат опции compose: после `compose` у движка, с начала у `docker-compose`. */
function composeSpan(
  engine: ContainerEngine,
  args: readonly string[],
): { from: number; inner: number } | undefined {
  if (engine === 'docker-compose') return { from: 0, inner: subcommandAt(args, 0, COMPOSE_VALUED) };
  const at = subcommandAt(args, 0, VALUED[engine]);
  if (args[at] !== 'compose') return undefined;
  return { from: at + 1, inner: subcommandAt(args, at + 1, COMPOSE_VALUED) };
}

export function labelledArgv(
  engine: ContainerEngine,
  args: readonly string[],
  taskId: string,
  env: Record<string, string | undefined> = {},
): string[] {
  const label = ['--label', `${TASK_LABEL}=${taskId}`];
  const span = composeSpan(engine, args);
  if (span) {
    if (ownProject(args, span.from, span.inner, env) !== undefined) return [...args];
    const bare = withoutEmptyProject(args, span.from, span.inner);
    return [
      ...bare.slice(0, span.from),
      '--project-name',
      composeProject(taskId),
      ...bare.slice(span.from),
    ];
  }
  if (engine === 'docker-compose') return [...args];
  const at = subcommandAt(args, 0, VALUED[engine]);
  const sub = args[at];
  const head = args.slice(0, at);
  if (sub === 'run' || sub === 'create') return [...head, sub, ...label, ...args.slice(at + 1)];
  if (sub === 'container' || (engine === 'podman' && sub === 'pod')) {
    const inner = subcommandAt(args, at + 1, new Set());
    const verb = args[inner];
    // `pod create` — только create: у пода нет `run`.
    if (verb === 'create' || (sub === 'container' && verb === 'run')) {
      return [...args.slice(0, inner), verb, ...label, ...args.slice(inner + 1)];
    }
  }
  return [...args];
}

/**
 * Что вызов оставит без метки задачи и что о нём записать (G18): проект compose, названный самим
 * вызовом, или `podman kube play` / `play kube`. Остальное размечено меткой — записи не нужно.
 */
export function unlabelledCall(
  engine: ContainerEngine,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): { kind: 'compose-project'; project: string } | { kind: 'created-during' } | undefined {
  const span = composeSpan(engine, args);
  if (span) {
    const project = ownProject(args, span.from, span.inner, env);
    return project ? { kind: 'compose-project', project } : undefined;
  }
  if (engine !== 'podman') return undefined;
  const at = subcommandAt(args, 0, VALUED.podman);
  const inner = subcommandAt(args, at + 1, new Set());
  const pair = `${args[at] ?? ''} ${args[inner] ?? ''}`;
  return pair === 'kube play' || pair === 'play kube' ? { kind: 'created-during' } : undefined;
}

/** Спецификация обёртки: `{real, dir}` (каталог сессии для журнала вызовов) или прежний массив argv. */
export function decodeWrapSpec(encoded: string): ContainerWrapSpec | undefined {
  try {
    const doc = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(doc) && doc.every((w) => typeof w === 'string')) return { real: doc };
    const spec = doc as Partial<ContainerWrapSpec>;
    if (Array.isArray(spec.real) && spec.real.every((w) => typeof w === 'string')) {
      return { real: spec.real, ...(typeof spec.dir === 'string' ? { dir: spec.dir } : {}) };
    }
  } catch {
    // Слово не base64url-JSON — ниже отказ «bad arguments».
  }
  return undefined;
}

/** Движок, которым ищутся контейнеры: `docker-compose` ставит метку проекта, её видит `docker`. */
const scanEngineOf = (engine: ContainerEngine): 'docker' | 'podman' =>
  engine === 'podman' ? 'podman' : 'docker';

/** id по `ps -q`; движок не ответил — `null` (запись тогда названа непрочитанной, не пустой). */
async function idsOf(
  tool: { file: string; prefix: string[] },
  args: readonly string[],
): Promise<string[] | null> {
  const got = await runTool(tool.file, [...tool.prefix, ...args], { timeoutMs: 20_000 });
  if (!got.ok) return null;
  return got.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function record(dir: string | undefined, call: ContainerCall): void {
  if (!dir) {
    process.stderr.write('agentdeck container wrapper: call not recorded (no session dir)\n');
    return;
  }
  try {
    const log = openAppendLog(join(dir, CONTAINER_CALLS_FILE));
    try {
      log.append(Buffer.from(`${JSON.stringify(call)}\n`, 'utf8'));
    } finally {
      log.close();
    }
  } catch (error) {
    process.stderr.write(
      `agentdeck container wrapper: call not recorded: ${(error as Error).message}\n`,
    );
  }
}

/**
 * Процесс обёртки: `run.ts container <движок> <id задачи> <спецификация base64url JSON> …`.
 * Код выхода — код настоящего движка (сигнал — 128 + номер); движок не запустился — 127.
 */
export async function runContainerWrapper(argv: readonly string[]): Promise<number> {
  const [engine, taskId, specB64, ...args] = argv;
  const known = engine === 'docker' || engine === 'podman' || engine === 'docker-compose';
  const spec = specB64 ? decodeWrapSpec(specB64) : undefined;
  if (!known || !taskId || !spec || !spec.real[0]) {
    process.stderr.write('agentdeck container wrapper: bad arguments\n');
    return 2;
  }
  const [file, ...prefix] = spec.real as [string, ...string[]];
  const run = (): number =>
    runPassthrough(
      file,
      [...prefix, ...labelledArgv(engine, args, taskId, process.env)],
      'agentdeck container wrapper',
    );
  const gap = unlabelledCall(engine, args, process.env);
  if (!gap) return run();
  // `docker-compose` своего `ps` движка не имеет: контейнеры его проекта читает `docker` из PATH.
  const scan =
    engine === 'docker-compose' ? { file: 'docker', prefix: [] as string[] } : { file, prefix };
  const scanEngine = scanEngineOf(engine);
  if (gap.kind === 'compose-project') {
    const before = await idsOf(scan, [
      'ps',
      '-a',
      '-q',
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}=${gap.project}`,
    ]);
    // Запись ДО вызова: упавшая посреди обёртка всё равно оставила след проекта.
    record(spec.dir, {
      v: 1,
      at: Date.now(),
      engine: scanEngine,
      kind: 'compose-project',
      project: gap.project,
      before,
    });
    return run();
  }
  const before = await idsOf(scan, ['ps', '-a', '-q']);
  const podsBefore = await idsOf(scan, ['pod', 'ps', '-q']);
  const code = run();
  const created = await createdByKubePlay(scan, before, podsBefore);
  record(spec.dir, {
    v: 1,
    at: Date.now(),
    engine: scanEngine,
    kind: 'created-during',
    ...created,
  });
  return code;
}

/**
 * Что создал САМ `kube play` (ревью B2r2-F01): разница `ps -a` до/после — окно времени, в него
 * попадает и контейнер другой задачи, и контейнер человека, а снимаются они `rm -f`. Поэтому:
 * поды — новые за вызов БЕЗ метки задачи (`pod create` сессий метку несёт, `kube play` — нет);
 * контейнеры — только из этих подов (kube play всё кладёт в под) и новые за вызов. Что-то не
 * прочиталось — `null`: поиск в конце шага назовёт непрочитанным, не пустым.
 */
async function createdByKubePlay(
  scan: { file: string; prefix: string[] },
  before: string[] | null,
  podsBefore: string[] | null,
): Promise<{ containers: string[] | null; pods: string[] | null }> {
  const after = await idsOf(scan, ['ps', '-a', '-q']);
  const podsAfter = await idsOf(scan, ['pod', 'ps', '-q']);
  const labelled = await idsOf(scan, ['pod', 'ps', '-q', '--filter', `label=${TASK_LABEL}`]);
  if (podsBefore === null || podsAfter === null || labelled === null) {
    return { containers: null, pods: null };
  }
  const pods = podsAfter.filter((id) => !podsBefore.includes(id) && !labelled.includes(id));
  if (before === null || after === null) return { containers: null, pods };
  const fresh = after.filter((id) => !before.includes(id));
  const containers: string[] = [];
  for (const pod of pods) {
    const inPod = await idsOf(scan, ['ps', '-a', '-q', '--filter', `pod=${pod}`]);
    if (inPod === null) return { containers: null, pods };
    for (const id of inPod) if (fresh.includes(id) && !containers.includes(id)) containers.push(id);
  }
  return { containers, pods };
}
