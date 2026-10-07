import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalLayerRow, GlobalLayerSideState } from '@agentdeck/contracts';
import { buildCaseRepo, isolatedGitEnv, type Corpus } from './case-repo.ts';
import { failingCases, judge, type SideRun } from './judge.ts';
import { corpusPath, type PairEntry } from './registry.ts';

/**
 * Одна сверка пары: корпус → репозитории случаев → обе стороны в своих
 * процессах → судья. Общая для сервиса (карточка) и для `cli.ts` (приёмка в
 * чате переноса): «корпус зелёный» значит одно и то же в обоих местах.
 */

const RUN_SIDE = fileURLToPath(new URL('./run-side.ts', import.meta.url));
/** Репозиторий панели: от этого модуля — `apps/server/src/domains/global-layer`. */
export const PANEL_REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SIDE_TIMEOUT_MS = 180_000;

export interface ComparisonInput {
  pair: PairEntry;
  /** Каталог конфигурации Claude Code (`~/.claude` или подменённый). */
  configRoot: string;
  repoRoot?: string;
  /**
   * Каталог предложения для глобальной стороны: его файлы ложатся поверх
   * файлов пары из конфигурации, и сверка меряет предложение, не трогая
   * настоящий слой.
   */
  proposalDir?: string;
}

export interface ComparisonResult {
  rows: GlobalLayerRow[];
  panel: GlobalLayerSideState;
  global: GlobalLayerSideState;
  cases: number;
  /** Отпечатки файлов сторон на момент сверки. */
  hashes: { panel: string; global: string };
}

/** Отпечаток набора файлов; отсутствующий файл — отдельная метка, не ошибка. */
export function fingerprint(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root, file);
    hash.update(`${file}\0`);
    hash.update(existsSync(path) ? readFileSync(path) : '\0missing');
  }
  return hash.digest('hex').slice(0, 16);
}

function runSide(job: object, env: NodeJS.ProcessEnv, scratch: string): Promise<SideRun> {
  const jobFile = join(scratch, `job-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', RUN_SIDE, jobFile],
      { env, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), SIDE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as SideRun);
      } catch {
        resolve({ results: {}, errors: { '*': stderr.trim().slice(0, 400) || 'no output' } });
      }
    });
  });
}

/** Глобальная сторона: сам слой или его копия с предложением поверх. */
function globalRoot(input: ComparisonInput, scratch: string): string {
  if (!input.proposalDir) return input.configRoot;
  const overlay = join(scratch, 'global-overlay');
  for (const file of input.pair.global.files) {
    const source = existsSync(join(input.proposalDir, file))
      ? join(input.proposalDir, file)
      : join(input.configRoot, file);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(join(overlay, file)), { recursive: true });
    cpSync(source, join(overlay, file));
  }
  return overlay;
}

function sideState(run: SideRun, rows: GlobalLayerRow[], side: 'panel' | 'global') {
  const error = run.errors['*'];
  return {
    ok: !error,
    failing: failingCases(rows, side),
    ...(error ? { error } : {}),
  };
}

export async function runComparison(input: ComparisonInput): Promise<ComparisonResult> {
  const repoRoot = input.repoRoot ?? PANEL_REPO_ROOT;
  const corpus = JSON.parse(readFileSync(corpusPath(input.pair), 'utf8')) as Corpus;
  const scratch = mkdtempSync(join(tmpdir(), `agentdeck-global-layer-${input.pair.id}-`));
  try {
    const env = isolatedGitEnv(scratch);
    const repos = corpus.cases.map((item) => ({
      id: item.id,
      cwd: buildCaseRepo(join(scratch, 'cases'), corpus, item, env),
    }));
    const root = globalRoot(input, scratch);
    const globalModule = join(root, input.pair.global.module);
    const [panel, global] = await Promise.all([
      runSide(
        {
          runner: input.pair.runner,
          side: 'panel',
          module: join(repoRoot, input.pair.panel.module),
          repos,
        },
        env,
        scratch,
      ),
      existsSync(globalModule)
        ? runSide(
            { runner: input.pair.runner, side: 'global', module: globalModule, repos },
            env,
            scratch,
          )
        : Promise.resolve<SideRun>({
            results: {},
            errors: { '*': `missing ${input.pair.global.module}` },
          }),
    ]);
    const rows = judge(corpus.cases, panel, global);
    return {
      rows,
      panel: sideState(panel, rows, 'panel'),
      global: sideState(global, rows, 'global'),
      cases: corpus.cases.length,
      hashes: {
        panel: fingerprint(repoRoot, input.pair.panel.files),
        global: fingerprint(root, input.pair.global.files),
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
