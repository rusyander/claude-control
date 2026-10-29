import { createHash } from 'node:crypto';
import type { CheckEntry } from '@agentdeck/contracts/core/records';
import type { DetectedCheck } from '../profile.types.ts';
import type { CiCommand, CiDropped } from './ci.types.ts';
import { matchWords, normaliseBinary } from './match.ts';

/**
 * Команда CI, что не легла на найденную проверку (04:48, 04:123), становится проверкой `ci:`
 * только если похожа на проверку: тест, линт, типы, сборка (список разрешённых слов). Шаг
 * публикации, выкладки, релиза, правки внешней системы не исполняется локально НИКОГДА:
 * инструмент взял бы учётные данные человека из домашнего конфига (`~/.npmrc`, kubeconfig,
 * `gh auth`) — необратимо. Запрет сильнее разрешения; всё, что не проверка, названо.
 */

const SETUP_BINARIES = new Set([
  'apt-get',
  'apt',
  'apk',
  'brew',
  'yum',
  'dnf',
  'choco',
  'curl',
  'wget',
  'echo',
  'printf',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'ls',
  'cat',
  'export',
  'sudo',
  'chmod',
  'chown',
  'git',
  'docker',
  'source',
  'set',
  'corepack',
  'nvm',
  'pip',
  'pip3',
  'ln',
  'tar',
  'unzip',
  'touch',
  'true',
  'rustup',
  'sdk',
  'pwd',
  'which',
]);
const SETUP_VERBS = new Set([
  'install',
  'add',
  'update',
  'upgrade',
  'fetch',
  'download',
  'sync',
  'config',
  'login',
  'logout',
  'enable',
]);
const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Слова выкладки: в имени скрипта, цели, слове или флаге команды. */
const DENY_WORDS = new Set([
  'publish',
  'deploy',
  'deployment',
  'release',
  'apply',
  'push',
  'upload',
  'destroy',
  'rollout',
  'promote',
  'ship',
  'sign',
  'notarize',
  'delete',
  'migrate',
  'seed',
  'tag',
  'invalidate',
  'prod',
  'production',
  'staging',
]);
/** Инструменты, что действуют на внешнюю систему, — каким бы ни было слово (`gh workflow run test`). */
const DENY_BINARIES = new Set([
  'gh',
  'glab',
  'hub',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'kubectl',
  'oc',
  'helm',
  'terraform',
  'terragrunt',
  'pulumi',
  'ansible',
  'ansible-playbook',
  'vercel',
  'netlify',
  'firebase',
  'heroku',
  'fly',
  'flyctl',
  'wrangler',
  'serverless',
  'sls',
  'cdk',
  'eb',
  'twine',
  'scp',
  'rsync',
  'ssh',
  'sftp',
  'ftp',
  'doctl',
  'railway',
  'surge',
  'vsce',
  'ovsx',
  'skaffold',
  'goreleaser',
  'semantic-release',
  'changeset',
]);
const CHECK_WORDS = new Set([
  'test',
  'tests',
  'spec',
  'specs',
  'unit',
  'integration',
  'e2e',
  'smoke',
  'lint',
  'linter',
  'check',
  'checks',
  'verify',
  'vet',
  'validate',
  'typecheck',
  'types',
  'tsc',
  'clippy',
  'audit',
  'analyze',
  'analyse',
  'coverage',
  'build',
  'compile',
  'ci',
]);
const CHECK_BINARIES = new Set([
  'pytest',
  'jest',
  'vitest',
  'mocha',
  'ava',
  'tox',
  'nox',
  'ctest',
  'shellcheck',
  'golangci-lint',
  'staticcheck',
  'eslint',
  'stylelint',
  'mypy',
  'pyright',
  'ruff',
  'flake8',
  'pylint',
  'phpunit',
  'rspec',
  'bats',
  'hadolint',
  'actionlint',
  'yamllint',
  'markdownlint',
  'pre-commit',
]);
/** Форматтер — проверка только в режиме сверки: без него он переписывает файлы. */
const FORMAT_WORDS = new Set(['fmt', 'format', 'prettier', 'black', 'gofmt', 'rustfmt']);
const CHECK_FLAGS = new Set(['--check', '-check', '--diff', '--list-different', '-l']);

const parts = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[-_.:=,]+/)
    .filter(Boolean);

interface Words {
  bin: string;
  head: string[];
  words: string[];
  flags: string[];
}

/** Голова (путь и имя бинаря/скрипта), слова без путей, имена флагов — на части. */
function wordsOf(argv: readonly string[]): Words {
  const first = (argv[0] ?? '').replace(/\\/g, '/');
  const rest = argv.slice(1);
  return {
    bin: normaliseBinary(first),
    head: first.split('/').flatMap(parts),
    words: rest
      .filter((a) => !a.startsWith('-') && !/[/\\]/.test(a) && a !== '.')
      .map((a) => a.toLowerCase()),
    flags: rest
      .filter((a) => a.startsWith('-'))
      .flatMap((a) => parts(a.replace(/^-+/, '').split('=')[0] as string)),
  };
}

function isSetup(argv: readonly string[], w: Words): boolean {
  if (SETUP_BINARIES.has(w.bin)) return true;
  if (w.words.some((x) => SETUP_VERBS.has(x))) return true;
  if (PMS.has(w.bin) && ['ci', 'i'].includes(w.words[0] ?? '')) return true;
  if (w.words[0] === 'mod' && w.words.includes('download')) return true;
  // Проба версии: `node --version`, `go version`, `java -version`.
  return argv.length <= 3 && argv.slice(1).some((a) => /^(-v|-V|--?version|version)$/.test(a));
}

export type CiVerdict = { kind: 'check' } | { kind: 'setup' } | { kind: 'drop'; why: string };

export function classifyCiCommand(argv: readonly string[]): CiVerdict {
  const w = wordsOf(argv);
  const all = [...w.head, ...w.words.flatMap(parts), ...w.flags];
  if (
    DENY_BINARIES.has(w.bin) ||
    w.words.some((x) => DENY_BINARIES.has(x)) ||
    all.some((x) => DENY_WORDS.has(x))
  )
    return { kind: 'drop', why: 'publish/deploy step: never run as a check' };
  if (isSetup(argv, w)) return { kind: 'setup' };
  const named = [...w.head, ...w.words.flatMap(parts)];
  const format =
    named.some((x) => FORMAT_WORDS.has(x)) &&
    argv.some((a) => CHECK_FLAGS.has(a.split('=')[0] as string));
  if (
    format ||
    CHECK_BINARIES.has(w.bin) ||
    w.words.some((x) => CHECK_BINARIES.has(x)) ||
    named.some((x) => CHECK_WORDS.has(x))
  )
    return { kind: 'check' };
  return { kind: 'drop', why: 'not a test/lint/type/build step: not run as a check' };
}

/** Команды CI без своей проверки → проверки `ci:` (класс строжайший, `static`) и названные отказы. */
export function genericFromCi(unmatched: readonly CiCommand[]): {
  checks: DetectedCheck[];
  dropped: CiDropped[];
} {
  const seen = new Set<string>();
  const checks: DetectedCheck[] = [];
  const dropped: CiDropped[] = [];
  for (const cmd of unmatched) {
    const verdict = classifyCiCommand(cmd.argv);
    if (verdict.kind === 'setup') continue;
    if (verdict.kind === 'drop') {
      dropped.push({ file: cmd.file, command: cmd.text, why: verdict.why });
      continue;
    }
    const id = `ci:${createHash('sha256')
      .update(`${cmd.cwd}\0${cmd.argv.join('\0')}`)
      .digest('hex')
      .slice(0, 8)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const bin = cmd.argv[0] as string;
    const entry: CheckEntry = {
      id,
      class: 'static',
      argv: cmd.argv,
      cwd: cmd.cwd,
      unit: 'project',
      requiredAt: [],
      baseDependent: false,
      inputs: [],
      envAllow: ['CI'],
      // Скрипт репозитория (`./scripts/x.sh`) — файл дерева, уже в ключе; инструмент — только из PATH.
      tools: /[/\\]/.test(bin) ? [] : [normaliseBinary(bin)],
      artifacts: [],
      needs: [],
      source: 'detected',
    };
    checks.push({
      entry,
      role: 'static',
      match: { kind: 'argv', words: matchWords(cmd.argv), root: cmd.cwd },
    });
  }
  return { checks, dropped };
}
