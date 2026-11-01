import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installer,
  makeRepo,
  taskWithUnit,
  wiring,
} from '../../conductor/copy/__fixtures__/copy-harness.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createSessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import { sessionKnown, unitReviewInput } from './boot-economy.ts';

/**
 * Чтения экономики в сборе на настоящих частях: чеканка токенов сеанса ядра и настоящая копия
 * единицы на настоящем git (подменён только установщик пакетов — сеть реестра).
 */

const gitIn = (cwd: string, ...args: string[]): void => {
  // Автор задан явно: в контейнере Linux глобального имени нет, `commit` без него падает.
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: 'pipe',
  });
};

describe('bootEconomy reads (P61 known, unit review input)', () => {
  it('known = the minted session token + secret-named pin values of 8+ chars; plain names and short values stay out', () => {
    const tokens = createSessionTokens('k'.repeat(32));
    const taskId = newId();
    const sessionId = newId();
    const pin = {
      ANTHROPIC_API_KEY: 'sk-pinned-0123456789',
      GITHUB_TOKEN: 'short',
      PATH: '/usr/bin:/bin:/usr/local/bin',
    };
    const known = sessionKnown(tokens, pin, taskId, sessionId);
    expect(known).toContain(tokens.mint({ taskId, sessionId }));
    expect(known).toContain('sk-pinned-0123456789');
    expect(known).not.toContain('short');
    expect(known).not.toContain('/usr/bin:/bin:/usr/local/bin');
    expect(known).toHaveLength(2);
    // Псевдозадача (id не UUIDv7): токена нет, пин остаётся.
    expect(sessionKnown(tokens, pin, 'pseudo', 'x')).toEqual(['sk-pinned-0123456789']);
  });

  it('the review input diffs the unit copy from the pinned sha: a base branch moving later adds nothing', async () => {
    const { repo } = makeRepo({ 'src/a.ts': 'one\n' });
    const { task, unitId } = await taskWithUnit(repo, 'main');
    expect(await unitReviewInput(task, unitId)).toBeNull();
    const got = await wiring(task, tempDir('bei-'), installer().install).prepare(
      task.taskId,
      unitId,
    );
    if (!('value' in got) || !got.value.placed) throw new Error(JSON.stringify(got));
    writeFileSync(join(repo, 'src', 'c.ts'), 'main only\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'moved');
    writeFileSync(join(got.value.placed.dir, 'src', 'a.ts'), 'two\nthree\n');

    const input = await unitReviewInput(task, unitId);
    expect(input?.baseRef).toMatch(/^[0-9a-f]{40,64}$/);
    expect(input?.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(input?.files[0]).toMatchObject({ added: 2, deleted: 1, binary: false });
    expect(input?.files[0]?.diff).toContain('+three');
  });
});
