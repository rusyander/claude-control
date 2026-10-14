import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Клон или рабочая копия, которую сессия сама создала (`git worktree add`, `git clone` в
 * транскрипте), — зона агента: удаление, `git clean` и откат внутри неё не требуют «да».
 * Чужой каталог, основной репозиторий, предки cwd и неразобранные переменные спрашивают как
 * раньше. Настоящий файл набора; фикстуры лежат вне temp — temp сам по себе зона агента.
 */

process.env.AGENTDECK_KIT_STATE = mkdtempSync(join(tmpdir(), 'kit-scratch-zone-'));
const HOOKS = join(builtinKitDir(), 'hooks', 'lib');
type Verdict = { decision: string; reason: string } | null;
type Input = Record<string, unknown>;
const guard = (await import(pathToFileURL(join(HOOKS, 'destructive-guard.mjs')).href)) as {
  default: (input: Input) => Verdict;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), `.scratch-zone-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const MAIN = join(ROOT, 'main');
const WT = join(ROOT, 'wt-probe');
const CLONE = join(ROOT, 'clone-probe');
const FOREIGN = join(ROOT, 'foreign');
const NOGIT = join(ROOT, 'nogit');
const URLONLY = join(ROOT, 'upstream-repo');
for (const d of [MAIN, WT, CLONE, FOREIGN, URLONLY])
  mkdirSync(join(d, '.git'), { recursive: true });
mkdirSync(NOGIT, { recursive: true });
const fwd = (p: string): string => p.split('\\').join('/');

const ran = (command: string): object => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: command, name: 'Bash', input: { command } }] },
});
const MADE = [
  ran(`git worktree add --detach "${fwd(WT)}" abc123`),
  ran(`git clone --depth 1 -b main https://example.com/x.git "${fwd(CLONE)}"`),
  ran(`cd "${fwd(ROOT)}" && git clone https://example.com/org/upstream-repo.git`),
  ran(`git worktree add "${fwd(NOGIT)}"`),
  ran(`git worktree add "${fwd(ROOT)}"`), // предок cwd — никогда не зона
  ran('git worktree add $D abc'), // неизвестная переменная — никогда не зона
];
let seq = 0;
const input = (command: string, records: object[] = MADE): Input => {
  const transcript = join(ROOT, `t${++seq}.jsonl`);
  writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { tool_name: 'Bash', tool_input: { command }, transcript_path: transcript, cwd: MAIN };
};

describe('destructive-guard: клон сессии — зона агента', () => {
  const allowed: [string, string][] = [
    ['файл внутри созданной рабочей копии', `rm -rf "${fwd(WT)}/src/old"`],
    ['сама созданная рабочая копия', `rm -rf "${fwd(WT)}"`],
    [
      'созданный клон с ключами -b / --depth',
      `rm -rf "${fwd(CLONE)}/node_modules" "${fwd(CLONE)}/dist"`,
    ],
    ['клон только по адресу после cd', `rm -rf "${fwd(URLONLY)}"`],
    ['git -C <копия> clean -fdx', `git -C "${fwd(WT)}" clean -fdx`],
    ['git -C <копия> checkout -- .', `git -C "${fwd(WT)}" checkout -- .`],
    ['cd <копия> && git restore .', `cd "${fwd(WT)}" && git restore .`],
  ];
  it.each(allowed)('без вопроса: %s', (_name, command) => {
    expect(guard.default(input(command))).toBeNull();
  });

  const asked: [string, string][] = [
    ['git clean в cwd (основной репозиторий)', 'git clean -fd'],
    ['git checkout -- . в cwd', 'git checkout -- .'],
    ['каталог, которого сессия не создавала', `rm -rf "${fwd(FOREIGN)}/src"`],
    ['основной репозиторий', `rm -rf "${fwd(MAIN)}/src"`],
    ['предок созданной копии', `rm -rf "${fwd(ROOT)}"`],
    ['выход из копии через ..', `rm -rf "${fwd(WT)}/../foreign"`],
    ['созданный каталог без своего .git', `rm -rf "${fwd(NOGIT)}"`],
    ['своя копия и чужой путь вместе', `rm -rf "${fwd(WT)}/a" "${fwd(FOREIGN)}/b"`],
    ['git -C <чужой> clean -fdx', `git -C "${fwd(FOREIGN)}" clean -fdx`],
    ['clean в копии и в cwd вместе', `git -C "${fwd(WT)}" clean -fd && git clean -fd`],
    ['цель с неразобранной переменной', 'rm -rf "$D/src"'],
  ];
  it.each(asked)('спрашивает: %s', (_name, command) => {
    expect(guard.default(input(command))?.decision).toBe('deny');
  });

  it('без команды создания в транскрипте тот же rm спрашивает', () => {
    expect(guard.default(input(`rm -rf "${fwd(WT)}/src/old"`, []))?.decision).toBe('deny');
  });
});
