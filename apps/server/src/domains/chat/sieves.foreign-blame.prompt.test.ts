import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SIEVES, sievePromptBlock } from '@agentdeck/contracts/sieves';
import { readSieveFacts } from '../project-git/sieve-facts/sieve-facts.ts';

/**
 * Задание звена о «чужих −» называло только файлы (INST a закрыл лишь пробел
 * судьи): агент не знал, чей коммит удалён и какие строки, и снимал одноимённые
 * файлы именем без пути. Теперь задание — тем же видом, что пробел судьи:
 * путь, коммит основной, строки, и просьба называть полным путём.
 *
 * Путь настоящий: голый «удалённый», основная ушла вперёд после старта группы,
 * ветка перенесена и удалила пришедшую строку — `readSieveFacts` по git, его
 * механика — в `sievePromptBlock`.
 */

const BEFORE = '2026-01-01T10:00:00Z';
const STARTED = '2026-02-01T10:00:00Z';
const AFTER = '2026-03-01T10:00:00Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date = BEFORE): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function commit(root: string, files: Record<string, string>, date: string, message = 'c'): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-q', '-m', message], date);
}

describe('задание звена: «чужие −» с коммитом и строками', () => {
  it('строка механики называет sha, тему и строки и просит полный путь', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sieve-prompt-'));
    dirs.push(root);
    const origin = join(root, 'origin.git');
    const main = join(root, 'main');
    const work = join(root, 'work');
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['clone', '-q', origin, main]);
    git(main, ['checkout', '-q', '-b', 'main']);
    commit(main, { 'docs/late.ts': 'export const a = 1;\n' }, BEFORE, 'seed');
    git(main, ['push', '-q', '-u', 'origin', 'main']);
    git(root, ['clone', '-q', origin, work]);
    git(work, ['checkout', '-q', '-b', 'grp']);
    commit(work, { 'mine.ts': 'export const mine = 1;\n' }, STARTED);
    commit(
      main,
      { 'docs/late.ts': 'export const a = 1;\nexport const lateWork = 2;\n' },
      AFTER,
      'landed after start',
    );
    git(main, ['push', '-q', 'origin', 'main'], AFTER);
    git(work, ['fetch', '-q', 'origin'], AFTER);
    git(work, ['rebase', '-q', 'origin/main'], AFTER);
    commit(work, { 'docs/late.ts': 'export const a = 1;\n' }, AFTER, 'overwrite');

    const facts = await readSieveFacts({ cwd: work, startedAt: STARTED });
    const sha = git(main, ['rev-parse', 'HEAD']).trim().slice(0, 10);
    const prompt = sievePromptBlock({
      stage: 'deliver',
      applicable: BUILTIN_SIEVES.filter((sieve) => sieve.id === 'foreign-removals'),
      mechanics: facts.mechanics,
    });
    const line = prompt.split('\n').find((text) => text.includes('landed in main')) ?? '';
    expect(line).toContain(`docs/late.ts (${sha} «landed after start», lines 2)`);
    expect(line).toContain('by its full path');
  });

  it('без сведений о коммите — строка с одним путём, как раньше', () => {
    const prompt = sievePromptBlock({
      stage: 'deliver',
      applicable: BUILTIN_SIEVES.filter((sieve) => sieve.id === 'foreign-removals'),
      mechanics: { foreignRemovals: ['a.ts', 'b/a.ts'] },
    });
    expect(prompt).toContain('after the group started: a.ts, b/a.ts — restore them');
  });
});
