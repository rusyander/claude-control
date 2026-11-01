import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import type { CliAdapter } from '../../adapters/adapter.types.ts';
import { estimateTask, USER_LAYER_REPORT_SIGNAL } from '../../conductor/estimate/estimate.ts';
import { estimateBody, gitRepo, testEnv } from '../../conductor/split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf, type CoreHomeLayout } from '../../platform/core-home.ts';
import { splitEnvFor } from '../conductor-wiring/split.ts';
import { launchLayerPort } from './launch-layer.ts';

/**
 * Порт слоя экрана запуска в сборе (07:23-24, 06:108-112): настоящий переходник Claude читает
 * дом CLI стенда, хеш его описи ложится в `task.created`, линт видит строку инструкции, гранты —
 * строки `grantRequired` настоящего `config.json` ядра. До проводки оценка отвечала «слой не
 * читали» при любом слое: порта у среды деления не было.
 */

let root: string;
let layout: CoreHomeLayout;
let registry: TaskRegistry;
let claude: CliAdapter;
let pin: Record<string, string>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-launch-layer-'));
  layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  claude = createAdapterRegistry().get('claude') as CliAdapter;
  const cliHome = join(root, 'cli-home');
  mkdirSync(cliHome, { recursive: true });
  writeFileSync(join(cliHome, 'CLAUDE.md'), 'Be precise.\nThen git push the branch.\n');
  pin = { CLAUDE_CONFIG_DIR: cliHome, HOME: cliHome, USERPROFILE: cliHome };
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Порты слоя и грантов — из среды деления загрузки (`splitEnvFor`), над реестром переходников
 * ядра и вход-подпиской Claude; остальное у среды — стенд оценки (предпроверка без машины).
 */
async function estimate(repo: string) {
  const wired = splitEnvFor({
    layout,
    adapters: createAdapterRegistry(),
    routes: { get: (id: string) => ({ kind: 'cli-login', id }) },
    loop: { pin: () => pin },
  } as never);
  const env = {
    ...testEnv(layout.scenarios),
    userLayer: wired.userLayer,
    grantRequired: wired.grantRequired,
  };
  const body = estimateBody([repo], { scenario: { preset: 'review-only' } });
  const out = await estimateTask(body, registry, env);
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const lines = readJournalLines(join(registry.tasksDir, out.reply.taskId), out.reply.taskId).lines;
  return { reply: out.reply, lines };
}

describe('launch layer port (bootstrap/user-layer-wiring)', () => {
  it('the real Claude inventory hash lands in task.created and the lint names the push line', async () => {
    const repo = gitRepo(root, 'plain');
    const { reply, lines } = await estimate(repo);
    const created = lines.find((l) => l.kind === 'task.created') as JournalLine<'task.created'>;
    const expected = claude.inventory?.(pin, repo, true).hash;
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(created.data.userLayerHash).toBe(expected);
    expect(reply.userLayer.hash).toBe(expected);
    expect(reply.userLayer.warnings).toEqual([
      expect.objectContaining({ rule: 'push', line: 2, text: 'Then git push the branch.' }),
    ]);
    const signals = lines
      .filter((l) => l.kind === 'signal')
      .map((l) => (l as JournalLine<'signal'>).data.signal);
    expect(signals).toContain(USER_LAYER_REPORT_SIGNAL);
  });

  it('grants come from the core config rows of this project only', async () => {
    const repo = gitRepo(root, 'granted');
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(
      layout.config,
      JSON.stringify({
        grantRequired: [
          { project: repo, globs: ['migrations/**'], ops: ['edit'] },
          { project: join(root, 'elsewhere'), globs: ['**'], ops: ['exec-db'] },
        ],
      }),
    );
    const { reply } = await estimate(repo);
    expect(reply.grants).toEqual([
      expect.objectContaining({ globs: ['migrations/**'], ops: ['edit'] }),
    ]);
  });

  it('no CLI of the launch set reads a layer: hash null with the reason, the task is still created', async () => {
    const port = launchLayerPort({ adapters: () => [], pin: () => pin });
    const got = await port([{ repoKey: 'r', path: root }]);
    expect(got.inventory).toBeNull();
    expect(got.detail).toEqual(['no CLI of the launch set reads its user layer']);
  });
});
