import { resolveRel, type ViewIndex } from '../view.ts';
import type { CiCommand, CiDropped, CiKind, CiScan } from './ci.types.ts';
import { normaliseBinary } from './match.ts';
import { splitSegments, tokenise } from './shell.ts';
import { ancestors, blockValues, keyLine, siblingValue, scalar, type Ancestor } from './yaml.ts';

/**
 * Команды CI (04:48): `.github/workflows/*.yml` (`run:`), `.gitlab-ci.yml` (`script:`),
 * `.circleci/config.yml` (`run:` / `run.command:`). Каталог команды — `working-directory` шага,
 * `defaults.run` задания и workflow, `cd` / `pushd` в том же скрипте (строки одного `run: |` и
 * элементы одного `script:` — одна оболочка) и `-C` / `--prefix` менеджеров. Каталог вне
 * репозитория или неизвестный — команда не проверка, названа. Задание выкладки (`environment:`) и
 * шаг не в командной оболочке (`shell: python`) — тоже.
 */

/** Каталог: внутри репозитория или потерян (почему). */
type Cwd = string | { lost: string };

const OUTSIDE = 'cwd leaves the repo';
const UNKNOWN_CWD = 'cwd set by a shell string: unknown';

/** Флаги каталога: команда с ними ≡ та же команда в том каталоге. */
const DIR_FLAGS: Record<string, readonly string[]> = {
  npm: ['--prefix'],
  pnpm: ['-C', '--dir'],
  yarn: ['--cwd'],
  bun: ['--cwd'],
  make: ['-C', '--directory'],
  go: ['-C'],
};

function absorbDirFlags(argv: string[], cwd: string): { argv: string[]; cwd: Cwd } {
  const flags = DIR_FLAGS[normaliseBinary(argv[0] ?? '')];
  if (!flags) return { argv, cwd };
  const out: string[] = [];
  let at: string | null = cwd;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const eq = flags.find((f) => f.startsWith('--') && a.startsWith(`${f}=`));
    const value = eq ? a.slice(eq.length + 1) : flags.includes(a) ? argv[i + 1] : undefined;
    if (value === undefined) {
      out.push(a);
      continue;
    }
    if (!eq) i += 1;
    at = at === null ? null : resolveRel(at, value);
  }
  return { argv: out, cwd: at === null ? { lost: OUTSIDE } : at };
}

interface Acc {
  commands: CiCommand[];
  dropped: CiDropped[];
  bad: number;
}

/** Строки одного скрипта (одна оболочка): `cd` переносится со строки на строку. */
function runScript(file: string, values: readonly string[], start: Cwd, acc: Acc): void {
  let cwd: Cwd = start;
  const stack: Cwd[] = [];
  for (const line of values) {
    for (const seg of splitSegments(line)) {
      if (seg.text.startsWith('#')) continue;
      const argv = seg.conditional ? null : tokenise(seg.text);
      if (argv === null) {
        acc.bad += 1;
        // Каталог, сменённый строкой оболочки, неизвестен до конца скрипта.
        if (/^(cd|pushd|popd)\b/.test(seg.text)) cwd = { lost: UNKNOWN_CWD };
        continue;
      }
      if (argv.length === 0) continue;
      const bin = argv[0] as string;
      if (bin === 'cd' || bin === 'pushd') {
        if (bin === 'pushd') stack.push(cwd);
        const to = argv[1];
        const next = to === undefined || typeof cwd !== 'string' ? null : resolveRel(cwd, to);
        cwd = next === null ? { lost: typeof cwd === 'string' ? OUTSIDE : cwd.lost } : next;
        continue;
      }
      if (bin === 'popd') {
        cwd = stack.pop() ?? { lost: UNKNOWN_CWD };
        continue;
      }
      if (typeof cwd !== 'string') {
        acc.dropped.push({ file, command: seg.text, why: cwd.lost });
        continue;
      }
      const abs = absorbDirFlags(argv, cwd);
      if (typeof abs.cwd !== 'string')
        acc.dropped.push({ file, command: seg.text, why: abs.cwd.lost });
      else acc.commands.push({ file, argv: abs.argv, cwd: abs.cwd, text: seg.text });
    }
  }
}

/** Задание, которому принадлежит строка: ключ под `jobs:` (GitHub, CircleCI) или верхний (GitLab). */
function jobOf(chain: readonly Ancestor[]): number | null {
  const top = chain.at(-1);
  if (!top) return null;
  if (top.key === 'jobs') return chain.at(-2)?.index ?? null;
  return top.index;
}

interface Defaults {
  workflow?: string;
  jobs: Map<number, string>;
}

/** `defaults: run: <key>:` задания и workflow (GitHub). */
function defaultsOf(lines: readonly string[], key: string): Defaults {
  const out: Defaults = { jobs: new Map() };
  lines.forEach((line, i) => {
    if (keyLine(line)?.key !== key) return;
    const chain = ancestors(lines, i);
    if (chain[0]?.key !== 'run' || chain[1]?.key !== 'defaults') return;
    const value = scalar(keyLine(line)?.rest ?? '');
    if (chain.length === 2) out.workflow = value;
    else {
      const job = jobOf(chain.slice(2));
      if (job !== null && chain[2]?.index === job) out.jobs.set(job, value);
    }
  });
  return out;
}

/** Задания выкладки: `environment:` прямо в задании (GitHub, GitLab). */
function deployJobs(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  lines.forEach((line, i) => {
    if (keyLine(line)?.key !== 'environment') return;
    const chain = ancestors(lines, i);
    const job = jobOf(chain);
    if (job !== null && chain[0]?.index === job) out.add(job);
  });
  return out;
}

function isCommandKey(kind: CiKind, key: string, chain: readonly Ancestor[]): boolean {
  if (kind === 'gitlab') return key === 'script';
  if (key === 'run') return chain[0]?.key !== 'defaults';
  return kind === 'circleci' && key === 'command' && chain[0]?.key === 'run';
}

function scanFile(file: string, text: string, kind: CiKind, acc: Acc): void {
  const lines = text.split(/\r?\n/);
  const wdKey = kind === 'circleci' ? 'working_directory' : 'working-directory';
  const wd = kind === 'github' ? defaultsOf(lines, wdKey) : { jobs: new Map<number, string>() };
  const sh = kind === 'github' ? defaultsOf(lines, 'shell') : { jobs: new Map<number, string>() };
  // У CircleCI `environment:` задания — переменные окружения, не выкладка.
  const deploy = kind === 'circleci' ? new Set<number>() : deployJobs(lines);
  lines.forEach((line, i) => {
    const k = keyLine(line);
    if (!k) return;
    const chain = ancestors(lines, i);
    if (!isCommandKey(kind, k.key, chain)) return;
    const values = blockValues(lines, i, k.keyIndent, k.rest);
    if (values.length === 0) return;
    const job = jobOf(chain);
    const drop = (why: string): void => {
      for (const v of values) acc.dropped.push({ file, command: v, why });
    };
    if (job !== null && deploy.has(job)) return drop('job deploys to an environment');
    // GitLab-скрипт — оболочка раннера; у шагов GitHub / CircleCI — свой `shell:`.
    const shell =
      kind === 'gitlab'
        ? undefined
        : (siblingValue(lines, i, 'shell') ??
          (job !== null ? sh.jobs.get(job) : undefined) ??
          sh.workflow);
    // Простая команда в pwsh / cmd — тот же argv (их подстановки `$…` / `%…%` разбор отвергнет);
    // `shell: python` / `node` — код интерпретатора, не команды.
    if (shell !== undefined && !/^(bash|sh|pwsh|powershell|cmd)\b/.test(shell))
      return drop(`shell: ${shell} is not a command shell`);
    const dir =
      kind === 'gitlab'
        ? undefined
        : (siblingValue(lines, i, wdKey) ??
          (job !== null ? wd.jobs.get(job) : undefined) ??
          wd.workflow);
    const start = dir === undefined ? '' : resolveRel('', dir);
    runScript(file, values, start === null ? { lost: OUTSIDE } : start, acc);
  });
}

const SOURCES: { kind: CiKind; test: (path: string) => boolean }[] = [
  { kind: 'github', test: (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) },
  { kind: 'gitlab', test: (p) => p === '.gitlab-ci.yml' },
  { kind: 'circleci', test: (p) => p === '.circleci/config.yml' },
];

export function scanCi(view: ViewIndex): CiScan {
  const out: CiScan = { commands: [], unparsed: [], dropped: [], files: [] };
  for (const src of SOURCES)
    for (const f of view.matching(src.test)) {
      const acc: Acc = { commands: out.commands, dropped: out.dropped, bad: 0 };
      out.files.push(f.path);
      scanFile(f.path, f.text ?? '', src.kind, acc);
      if (acc.bad > 0) out.unparsed.push({ file: f.path, count: acc.bad });
    }
  return out;
}
