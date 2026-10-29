import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDetachedWorktree } from '../../platform/git.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { runTool } from '../../platform/run-tool.ts';
import { fixtureEntry, fixtureRegistry } from '../__fixtures__/registry.ts';
import { envDigester, readKey, type KeyReadInput } from './index.ts';

/**
 * Ключ на настоящем git (04:10, D§3.3): коммит, amend, rebase без правок, другая копия с тем же
 * содержимым — один ключ; правка в замыкании, `chmod +x` и новый `.env` — новый.
 */

let root: string;

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const run = await runTool('git', ['-C', cwd, ...args], { timeoutMs: 30_000 });
  if (!run.ok) throw new Error(`git ${args.join(' ')}: ${run.reason}`);
}

function put(repo: string, rel: string, text: string): void {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

async function repoWithUnits(): Promise<string> {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  await sh(repo, 'init', '-q', '-b', 'main');
  await sh(repo, 'config', 'user.email', 't@example.com');
  await sh(repo, 'config', 'user.name', 't');
  await sh(repo, 'config', 'core.autocrlf', 'false');
  put(repo, 'apps/app/main.ts', 'export const app = 1;\n');
  put(repo, 'apps/admin/main.ts', 'export const admin = 1;\n');
  put(repo, 'packages/shared/index.ts', 'export const s = 1;\n');
  put(repo, 'vitest.config.ts', 'export default {};\n');
  put(repo, 'tools/gate.mjs', '\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

const input = (repo: string, rev: string): KeyReadInput => ({
  repo,
  entry: fixtureEntry(),
  registry: fixtureRegistry(),
  unit: 'app',
  selection: [],
  rev,
  baseRev: null,
  tools: { node: 'v22' },
  env: { NODE_ENV: 'test' },
  envDigest: envDigester(Buffer.alloc(32, 7)),
});

async function keyAt(repo: string, rev: string): Promise<string> {
  const fact = await readKey(input(repo, rev));
  if (!('value' in fact)) throw new Error(JSON.stringify(fact));
  return fact.value.key;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-key-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('verifier/key on real git', () => {
  it('P07 content key: commit = work tree = amend = no-op rebase = another copy; closure edit, chmod +x and a new .env move it', async () => {
    const repo = await repoWithUnits();
    const committed = await keyAt(repo, 'HEAD');
    expect(await keyAt(repo, 'worktree')).toBe(committed);
    await sh(repo, 'commit', '-q', '--amend', '--no-edit', '--allow-empty');
    expect(await keyAt(repo, 'HEAD')).toBe(committed);
    put(repo, 'README.md', 'outside every closure\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-q', '-m', 'two');
    await sh(repo, 'rebase', '-q', '--force-rebase', 'HEAD~1');
    expect(await keyAt(repo, 'HEAD')).toBe(committed);

    const copy = join(root, 'copy');
    expect('created' in (await addDetachedWorktree(repo, copy, 'HEAD'))).toBe(true);
    expect(await keyAt(copy, 'worktree')).toBe(committed);

    put(copy, 'packages/shared/index.ts', 'export const s = 2;\n');
    const edited = await keyAt(copy, 'worktree');
    expect(edited).not.toBe(committed);
    await sh(copy, 'checkout', '--', 'packages/shared/index.ts');
    expect(await keyAt(copy, 'worktree')).toBe(committed);

    if (currentOs() === 'win32') await sh(copy, 'update-index', '--chmod=+x', 'apps/app/main.ts');
    else chmodSync(join(copy, 'apps/app/main.ts'), 0o755);
    expect(await keyAt(copy, 'worktree')).not.toBe(committed);

    put(repo, '.env.local', 'A=1\n');
    expect(await keyAt(repo, 'worktree')).not.toBe(committed);
  });
});
