import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { WorktreeBootstrapState } from '@agentdeck/contracts';
import {
  isHeavyShape,
  SPLIT_HEAVY_RULE_DEFAULT,
  type SplitHeavyRule,
} from '@agentdeck/contracts/split-groups';
import { killChildTree } from '../../lib/process-tree.ts';
import { gitSync } from './exec.ts';

/**
 * Бутстрап копии: команда, которая идёт в новой копии ДО того, как в ней
 * стартует агент, — обычно установка зависимостей. Чекаут и зеркало локального
 * слоя дают файлы проекта, но не `node_modules`: без этого шага первый ход
 * агента уходит на «поставлю зависимости», а при отказе он изворачивается без
 * проверок проекта.
 *
 * Команду задаёт человек на проекте; пусто — панель сама строит план по
 * lock-файлам (`detectBootstrapPlan`): установка в корне, а нет его там — по
 * каталогу первого уровня на цепочку, разом, со сборкой локальной библиотеки,
 * чей вход в копии не собран. Без lock-файла не делает ничего. Потолок
 * десять минут на весь план; провал копию не отменяет и группу разделения не останавливает —
 * агент получает хвост лога в задании и решает сам.
 *
 * Лог и запись о состоянии лежат в `<appData>/worktree-logs/<slug>.{log,json}`:
 * так карточка копии показывает результат и после перезапуска панели, а запись
 * «идёт», пережившая перезапуск, честно читается как провал — процесса уже нет.
 *
 * Команда запускается через оболочку системы (так её и пишет человек:
 * `pnpm install && pnpm build`), с `CI=1` — установщики в этом режиме не задают
 * вопросов и не рисуют прогресс, а вопрос без ответа висел бы до таймаута.
 */

export const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
/** Хвост лога, который уезжает в карточку и в задание агента. */
export const LOG_TAIL_CHARS = 2000;

/** Одна команда подготовки; `cwd` — каталог относительно корня копии, `''` — сам корень. */
export interface BootstrapStep {
  cwd: string;
  command: string;
}

/**
 * Цепочка — шаги ОДНОГО каталога по порядку (установка, затем сборка);
 * `after` — каталоги, чьи цепочки должны кончиться раньше.
 */
export interface BootstrapChain {
  cwd: string;
  steps: BootstrapStep[];
  after: string[];
}

/**
 * План подготовки копии: цепочки идут ПАРАЛЛЕЛЬНО, шаги в цепочке — по
 * порядку. `summary` — то, что человек видит в карточке копии и в состоянии.
 */
export interface BootstrapPlan {
  summary: string;
  chains: BootstrapChain[];
}

/** Сколько цепочек одного плана идёт разом: шесть `npm ci` сразу забивают диск. */
export const BOOTSTRAP_CHAIN_LIMIT = 4;

type PackageManager = 'pnpm' | 'npm' | 'yarn';

function lockfileManager(dir: string): PackageManager | undefined {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return undefined;
}

/**
 * Установка по lock-файлу. `--prefer-offline` у npm — из замера 24.09.2026 на
 * каталоге в 36 тыс. файлов: 16 с без флага, 9–10 с с ним (кэш тёплый — пакеты
 * уже ставились в основную копию). Аудит и призывы к пожертвованиям — лишний
 * сетевой запрос в каждой копии.
 */
const INSTALL: Record<PackageManager, string> = {
  pnpm: 'pnpm install --frozen-lockfile --prefer-offline',
  npm: 'npm ci --prefer-offline --no-audit --no-fund',
  yarn: 'yarn install --immutable',
};

const BUILD: Record<PackageManager, string> = {
  pnpm: 'pnpm run build',
  npm: 'npm run build',
  yarn: 'yarn build',
};

/** Каталоги первого уровня, где lock-файл не ищем: служебные и чужие зависимости. */
const SKIP_NESTED = new Set(['node_modules', 'vendor', 'dist', 'build']);

interface PackageJson {
  main?: unknown;
  module?: unknown;
  types?: unknown;
  typings?: unknown;
  exports?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Все строковые листья `exports` плюс `main`/`module`/`types`; шаблоны с `*` — мимо. */
function entryPaths(pkg: PackageJson): string[] {
  const out: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.includes('*')) out.push(value);
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) collect(nested);
    }
  };
  collect(pkg.main);
  collect(pkg.module);
  collect(pkg.types);
  collect(pkg.typings);
  collect(pkg.exports);
  return out;
}

/**
 * Локальная зависимость, которую надо собрать: объявленный вход пакета в копии
 * отсутствует, а сборка у пакета есть. Так выглядит общая библиотека, чей
 * `dist` в `.gitignore`: в основной копии он собран руками давно, в свежей
 * копии его нет, и приложения-соседи падают на первом же импорте.
 */
function needsBuild(dir: string): boolean {
  const pkg = readPackageJson(dir);
  if (!pkg || typeof pkg.scripts?.build !== 'string') return false;
  const entries = entryPaths(pkg);
  if (entries.some((entry) => !existsSync(resolve(dir, entry)))) return true;
  return entries.length > 0 && !allTracked(dir, entries);
}

/**
 * Окажутся ли входы в СВЕЖЕЙ копии. План строится и по основной копии — для
 * сводки в настройках и для выбора «групп разом», — а там `dist` давно собран
 * руками и лежит на диске, хотя в git его нет: сводка теряла сборку, и
 * подготовка выглядела лёгкой (живой прогон 24.09.2026). В копию приезжает
 * только то, что git отслеживает; не репозиторий — правда за диском. Один
 * вызов git на пакет: план строится на каждой отправке в чат проекта.
 */
function allTracked(dir: string, entries: string[]): boolean {
  const listed = gitSync(dir, ['ls-files', '-z', '--', ...entries]);
  if (listed === undefined) return true;
  const tracked = listed
    .split('\0')
    .filter(Boolean)
    .map((path) => resolve(dir, path));
  // Вход бывает и каталогом (`./dist/styles/`): его отслеживаемые файлы — внутри.
  return entries.every((entry) => {
    const full = resolve(dir, entry);
    return tracked.some((path) => path === full || path.startsWith(`${full}${sep}`));
  });
}

/** Локальные зависимости каталога (`file:` / `link:`), лежащие внутри копии. */
function localDependencies(root: string, dir: string): string[] {
  const pkg = readPackageJson(dir);
  if (!pkg) return [];
  const specs = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].flatMap((group) =>
    Object.values(group ?? {}),
  );
  const rootKey = normalizeDir(root);
  return specs.flatMap((spec) => {
    if (typeof spec !== 'string') return [];
    const match = /^(?:file|link):(.+)$/.exec(spec);
    if (!match?.[1]) return [];
    const target = resolve(dir, match[1]);
    const key = normalizeDir(target);
    return key.startsWith(`${rootKey}/`) ? [key.slice(rootKey.length + 1)] : [];
  });
}

function nestedPackageDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && !SKIP_NESTED.has(name))
      .sort()
      .filter((name) => lockfileManager(join(dir, name)) !== undefined);
  } catch {
    return [];
  }
}

function summarize(chains: BootstrapChain[]): string {
  return chains
    .map((chain) => {
      const text = chain.steps.map((step) => step.command).join(' && ');
      return chain.cwd ? `[${chain.cwd}] ${text}` : text;
    })
    .join(' · ');
}

/**
 * План по lock-файлам: в корне — одна установка; в корне нет — по каталогам
 * первого уровня (Д13), каждый своей цепочкой, разом. Репозиторий «бэкенд +
 * фронт рядом» держит lock-файл в `frontend/` или `web/`, а «несколько
 * приложений + общая библиотека» — в каждом из них.
 *
 * Каталог, от которого соседи зависят через `file:`, и чей вход в копии не
 * собран, получает сборку после установки. Соседи на pnpm и yarn ждут его
 * цепочку: они кладут `file:`-пакет копией на установке, и без собранного
 * `dist` в неё уезжает пустота; npm ставит ссылку и не ждёт.
 */
export function detectBootstrapPlan(dir: string): BootstrapPlan | undefined {
  const root = lockfileManager(dir);
  if (root) {
    const chains = [{ cwd: '', steps: [{ cwd: '', command: INSTALL[root] }], after: [] }];
    return { summary: summarize(chains), chains };
  }
  const names = nestedPackageDirs(dir);
  if (names.length === 0) return undefined;
  // Путь зависимости нормализован (на Windows — в нижнем регистре); сверяем с
  // каталогами в том же виде, а храним их настоящие имена.
  const known = new Map(
    names.map((name) => [process.platform === 'win32' ? name.toLowerCase() : name, name]),
  );
  const deps = new Map(
    names.map((name) => [
      name,
      [...new Set(localDependencies(dir, join(dir, name)))].flatMap((target) => {
        const real = known.get(target);
        return real && real !== name ? [real] : [];
      }),
    ]),
  );
  const built = new Set(
    [...new Set([...deps.values()].flat())].filter((name) => needsBuild(join(dir, name))),
  );
  // Собираемые библиотеки — первыми: под потолком одновременных они на
  // критическом пути, соседям без них делать нечего.
  const ordered = [
    ...names.filter((name) => built.has(name)),
    ...names.filter((name) => !built.has(name)),
  ];
  const chains = ordered.map((name): BootstrapChain => {
    const manager = lockfileManager(join(dir, name)) as PackageManager;
    const steps = [{ cwd: name, command: INSTALL[manager] }];
    if (built.has(name)) steps.push({ cwd: name, command: BUILD[manager] });
    // npm ставит `file:`-пакет ссылкой и в его вход не заглядывает — ждать
    // сборку незачем; pnpm и yarn кладут копию, и её надо снять с собранного.
    const after = manager === 'npm' ? [] : (deps.get(name) ?? []).filter((dep) => built.has(dep));
    return { cwd: name, steps, after };
  });
  return { summary: summarize(chains), chains };
}

/** Настроенная человеком команда — одна цепочка в корне. */
function planOfCommand(command: string): BootstrapPlan {
  return { summary: command, chains: [{ cwd: '', steps: [{ cwd: '', command }], after: [] }] };
}

/** Настроенная человеком команда сильнее автоопределения; пустая строка — «определи сама». */
export function bootstrapPlanFor(dir: string, configured?: string): BootstrapPlan | undefined {
  const own = configured?.trim();
  return own ? planOfCommand(own) : detectBootstrapPlan(dir);
}

/**
 * Тяжёлая подготовка — установок или шагов в цепочке больше порога: групп
 * разом стоит меньше. Порог — правило вкладки «Группы»; из коробки прежнее
 * «больше одной установки или сборка».
 */
export function isHeavyPlan(
  plan: BootstrapPlan | undefined,
  rule: SplitHeavyRule = SPLIT_HEAVY_RULE_DEFAULT,
): boolean {
  if (!plan) return false;
  return isHeavyShape(
    plan.chains.map((chain) => chain.steps.length),
    rule,
  );
}

/** Последние символы лога, начиная с целой строки. */
export function logTail(text: string, max = LOG_TAIL_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < max / 2 ? cut.slice(nl + 1) : cut;
}

function normalizeDir(dir: string): string {
  const text = resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * Команда через оболочку системы — так её пишет человек (`pnpm install &&
 * pnpm build`), с `CI=1`: установщики в этом режиме не задают вопросов и не
 * рисуют прогресс.
 */
function spawnShell(command: string, cwd: string): ChildProcess {
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
  return process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn('/bin/sh', ['-c', command], {
        cwd,
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
}

export interface BootstrapOptions {
  timeoutMs?: number;
  /** Часы — в тесте фиксируются. */
  now?: () => Date;
  /**
   * Что сделать в копии после команды (удачной или нет): откат lock-файлов,
   * которые установка переписала. Возвращает, что откатилось, — в лог и в
   * состояние. Не задано — ничего.
   */
  afterRun?: (dir: string) => Promise<string[]>;
}

export class WorktreeBootstraps {
  private readonly running = new Map<string, Promise<WorktreeBootstrapState>>();
  private readonly states = new Map<string, WorktreeBootstrapState>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly logDir: string;
  private readonly afterRun?: (dir: string) => Promise<string[]>;

  constructor(logDir: string, options: BootstrapOptions = {}) {
    this.logDir = logDir;
    this.timeoutMs = options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.afterRun = options.afterRun;
  }

  /** Имя файлов лога: имя каталога плюс хвост хеша пути — две копии `feature-x` разных проектов не сойдутся. */
  slugFor(dir: string): string {
    const key = normalizeDir(dir);
    const tag = createHash('sha1').update(key).digest('hex').slice(0, 8);
    const name =
      basename(key)
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .slice(0, 40) || 'copy';
    return `${name}-${tag}`;
  }

  logPath(dir: string): string {
    return join(this.logDir, `${this.slugFor(dir)}.log`);
  }

  private recordPath(dir: string): string {
    return join(this.logDir, `${this.slugFor(dir)}.json`);
  }

  isRunning(dir: string): boolean {
    return this.running.has(normalizeDir(dir));
  }

  /**
   * Состояние копии: из памяти, иначе с диска. Запись «идёт» без процесса в
   * памяти — панель перезапустилась посреди установки: процесса больше нет, и
   * сказать «идёт» значило бы ждать вечно.
   */
  status(dir: string): WorktreeBootstrapState | undefined {
    const key = normalizeDir(dir);
    const live = this.states.get(key);
    if (live) return live;
    const stored = this.readRecord(dir);
    if (!stored) return undefined;
    if (stored.status === 'running') {
      const failed: WorktreeBootstrapState = {
        ...stored,
        status: 'failed',
        finishedAt: stored.finishedAt ?? this.now().toISOString(),
        logTail: `${stored.logTail}\n[панель перезапущена — установка прервана]`.trim(),
      };
      this.states.set(key, failed);
      this.writeRecord(dir, failed);
      return failed;
    }
    this.states.set(key, stored);
    return stored;
  }

  /** Полный лог последнего запуска; пусто, если запусков не было. */
  log(dir: string): string {
    try {
      return readFileSync(this.logPath(dir), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Запустить подготовку копии: строка — одна команда в корне, план — его
   * цепочки. Повторный вызов, пока идёт первый, возвращает ТОТ ЖЕ результат, а
   * не второй процесс поверх первого: два `pnpm install` в одном каталоге ломают
   * друг друга.
   *
   * Никогда не отклоняется: отказ оболочки, таймаут, ненулевой код — всё это
   * состояние `failed` с причиной в логе, а не исключение у вызывающего.
   */
  run(dir: string, work: string | BootstrapPlan): Promise<WorktreeBootstrapState> {
    const key = normalizeDir(dir);
    const active = this.running.get(key);
    if (active) return active;

    const plan = typeof work === 'string' ? planOfCommand(work) : work;
    const startedAt = this.now().toISOString();
    const state: WorktreeBootstrapState = {
      command: plan.summary,
      status: 'running',
      startedAt,
      logTail: '',
    };
    this.states.set(key, state);
    this.writeRecord(dir, state);

    const promise = this.execute(dir, plan, state).finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, promise);
    return promise;
  }

  private async execute(
    dir: string,
    plan: BootstrapPlan,
    state: WorktreeBootstrapState,
  ): Promise<WorktreeBootstrapState> {
    mkdirSync(this.logDir, { recursive: true });
    const chunks: string[] = [];
    let size = 0;
    let file: ReturnType<typeof createWriteStream> | undefined;
    const write = (text: string): void => {
      chunks.push(text);
      size += text.length;
      // Хвост держим в памяти ограниченно: лог целиком лежит в файле.
      while (size > LOG_TAIL_CHARS * 4 && chunks.length > 1) {
        size -= (chunks.shift() as string).length;
      }
      file?.write(text);
    };

    const finish = (patch: Partial<WorktreeBootstrapState>): WorktreeBootstrapState => {
      const done: WorktreeBootstrapState = {
        ...state,
        ...patch,
        finishedAt: this.now().toISOString(),
        logTail: logTail(chunks.join('')),
      };
      this.states.set(normalizeDir(dir), done);
      this.writeRecord(dir, done);
      return done;
    };

    try {
      file = createWriteStream(this.logPath(dir), { flags: 'w' });
    } catch (error) {
      write(`Лог не открылся: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    write(`$ ${plan.summary}\n[${state.startedAt}] cwd: ${dir}\n\n`);

    // Вывод параллельных цепочек перемешан — каждую строку метим каталогом.
    // Одна цепочка в корне (настроенная команда) идёт без меток, как раньше.
    const tagged = plan.chains.length > 1 || plan.chains.some((chain) => chain.cwd !== '');
    const children = new Set<ChildProcess>();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      write(`\n[потолок ${Math.round(this.timeoutMs / 60_000)} мин — процесс остановлен]\n`);
      for (const child of children) killChildTree(child, { group: process.platform !== 'win32' });
    }, this.timeoutMs);

    const runStep = (step: BootstrapStep): Promise<number | undefined> => {
      const tag = tagged ? `[${step.cwd || '.'}] ` : '';
      if (tagged) write(`${tag}$ ${step.command}\n`);
      return new Promise((resolveStep) => {
        const child = spawnShell(step.command, step.cwd ? join(dir, step.cwd) : dir);
        children.add(child);
        let pending = '';
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString('utf8');
          if (!tag) {
            write(text);
            return;
          }
          const lines = (pending + text).split('\n');
          pending = lines.pop() ?? '';
          if (lines.length > 0) write(lines.map((line) => `${tag}${line}\n`).join(''));
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        let settled = false;
        const settle = (code: number | undefined, note: string): void => {
          if (settled) return;
          settled = true;
          children.delete(child);
          if (pending) write(`${tag}${pending}\n`);
          write(note);
          resolveStep(code);
        };
        child.on('error', (error) =>
          settle(undefined, `\n${tag}Команда не запустилась: ${error.message}\n`),
        );
        child.on('close', (code, signal) =>
          settle(
            typeof code === 'number' ? code : undefined,
            `\n${tag}[${this.now().toISOString()}] ${
              timedOut ? 'таймаут' : `код ${code ?? signal ?? '?'}`
            }\n`,
          ),
        );
      });
    };

    // Первый провал решает итог: его код — в состоянии, как у одиночной команды.
    let failure: { code?: number } | undefined;
    const runChain = async (chain: BootstrapChain): Promise<void> => {
      for (const step of chain.steps) {
        if (timedOut) return;
        const code = await runStep(step);
        if (code !== 0) {
          failure ??= typeof code === 'number' ? { code } : {};
          return;
        }
      }
    };

    // Цепочка стартует, когда кончились те, от кого она зависит (удачно или
    // нет: провал сборки соседа — строка в логе, а не повод не ставить своё),
    // и когда есть свободное место под потолком одновременных.
    const done = new Set<string>();
    const waiting = [...plan.chains];
    await new Promise<void>((resolveAll) => {
      let active = 0;
      const pump = (): void => {
        if (waiting.length === 0 && active === 0) {
          resolveAll();
          return;
        }
        for (let index = 0; index < waiting.length && active < BOOTSTRAP_CHAIN_LIMIT;) {
          const chain = waiting[index] as BootstrapChain;
          const ready =
            timedOut ||
            chain.after.every((dep) => done.has(dep) || !plan.chains.some((c) => c.cwd === dep));
          if (!ready) {
            index++;
            continue;
          }
          waiting.splice(index, 1);
          active++;
          void runChain(chain).finally(() => {
            active--;
            done.add(chain.cwd);
            pump();
          });
        }
      };
      pump();
    });
    clearTimeout(timer);

    // Чистота дерева — после любой команды: и провальная установка успевает
    // переписать lock-файл. Отказ отката не портит итог установки.
    const reverted = this.afterRun ? await this.afterRun(dir).catch(() => []) : [];
    if (reverted.length > 0) write(`[lock-файлы откачены: ${reverted.join(', ')}]\n`);
    const result = finish({
      status: !timedOut && !failure ? 'ok' : 'failed',
      ...(failure?.code !== undefined
        ? { exitCode: failure.code }
        : !failure && !timedOut
          ? { exitCode: 0 }
          : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(reverted.length > 0 ? { reverted } : {}),
    });
    file?.end();
    return result;
  }

  private readRecord(dir: string): WorktreeBootstrapState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.recordPath(dir), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return undefined;
      const record = raw as Partial<WorktreeBootstrapState>;
      if (typeof record.command !== 'string' || typeof record.startedAt !== 'string') {
        return undefined;
      }
      return {
        command: record.command,
        status: record.status === 'ok' || record.status === 'running' ? record.status : 'failed',
        startedAt: record.startedAt,
        logTail: typeof record.logTail === 'string' ? record.logTail : '',
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
        ...(record.timedOut ? { timedOut: true } : {}),
        // Откат lock-файлов — единственное, что панель СДЕЛАЛА с рабочим
        // деревом копии; потерять его при перезапуске значит промолчать о
        // своей же правке.
        ...(Array.isArray(record.reverted) && record.reverted.length > 0
          ? { reverted: record.reverted.filter((name) => typeof name === 'string') }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writeRecord(dir: string, state: WorktreeBootstrapState): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      writeFileSync(this.recordPath(dir), JSON.stringify(state, null, 2));
    } catch {
      // Без записи на диске состояние живёт до перезапуска — этого хватает карточке.
    }
  }
}
