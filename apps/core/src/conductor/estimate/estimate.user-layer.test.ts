import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { estimateBody, gitRepo, testEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { estimateTask, USER_LAYER_REPORT_SIGNAL } from './estimate.ts';
import type { LaunchLayer, SplitEnv } from './estimate.types.ts';

/**
 * G-h, 07:23-24, 06:108-112 — экран запуска: хеш описи слоя CLI запуска идёт в
 * `task.created.userLayerHash`; ответ несёт «просили / пойдёт», подмены, предупреждения линта со
 * строкой и число источников, гранты по `grantRequired` репозитория задачи. Отчёт — строкой
 * журнала: повтор `cmdId` отвечает тем же, даже когда слой с тех пор изменился. Нет описи или
 * сбой порта — хеш `null` с причиной, задача создаётся. P36: линт не входит ни в одно решение —
 * журнал с линтом и без совпадает, кроме самой строки отчёта.
 */

let root: string;
let registry: TaskRegistry;
let scenarios: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-estimate-layer-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps());
  scenarios = layout.scenarios;
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const HASH = 'a'.repeat(64);
const inventory = (hash = HASH): UserLayerInventory => ({
  cli: 'claude',
  hash,
  sources: [
    { kind: 'instructions', scope: 'user', path: 'CLAUDE.md', sha256: 'b'.repeat(64), bytes: 40 },
  ] as UserLayerInventory['sources'],
  hooks: [],
  skills: [],
  agents: [],
  unread: [],
});

const layerOf = (text: string, hash = HASH): LaunchLayer => ({
  inventory: inventory(hash),
  texts: [{ path: 'CLAUDE.md', text }],
  asked: { hooks: 'on', skills: 'on' },
  ran: { hooks: 'observe', skills: 'on' },
  detail: ['untrusted copy: hooks on → observe'],
});

function envWith(over: Partial<SplitEnv>): SplitEnv {
  return { ...testEnv(scenarios), ...over };
}

async function created(
  env: SplitEnv,
  repo = gitRepo(root, `r-${Math.random().toString(36).slice(2, 8)}`),
) {
  const body = estimateBody([repo], { scenario: { preset: 'review-only' } });
  const out = await estimateTask(body, registry, env);
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const lines = readJournalLines(join(registry.tasksDir, out.reply.taskId), out.reply.taskId).lines;
  const taskCreated = lines.find((l) => l.kind === 'task.created') as JournalLine<'task.created'>;
  return { out, lines, body, repo, hash: taskCreated.data.userLayerHash };
}

describe('G-h estimate user layer report and grants (conductor/estimate)', () => {
  it('the launch CLI inventory hash lands in task.created; the reply names asked/ran, detail, line-numbered lint and sources', async () => {
    const { out, hash } = await created(
      envWith({ userLayer: async () => layerOf('Be precise.\nThen git push the branch.\n') }),
    );
    expect(hash).toBe(HASH);
    expect(out.reply.userLayer).toMatchObject({
      hash: HASH,
      asked: { hooks: 'on', skills: 'on' },
      ran: { hooks: 'observe', skills: 'on' },
      detail: ['untrusted copy: hooks on → observe'],
      sources: 1,
    });
    expect(out.reply.userLayer.warnings).toEqual([
      expect.objectContaining({
        rule: 'push',
        source: 'CLAUDE.md',
        line: 2,
        text: 'Then git push the branch.',
      }),
    ]);
  });

  it('a replay of the same cmdId answers the journaled report, not a re-read of the changed layer', async () => {
    let text = 'git push it';
    const env = envWith({ userLayer: async () => layerOf(text) });
    const first = await created(env);
    text = 'nothing to see';
    const again = await estimateTask(first.body, registry, env);
    expect(again.status).toBe(200);
    if (again.status === 422) throw new Error('replay refused');
    expect(again.reply.userLayer).toEqual(first.out.reply.userLayer);
  });

  it('no port or a failing port: hash null with the reason named, the task is still created', async () => {
    const none = await created(envWith({}));
    expect(none.hash).toBeNull();
    expect(none.out.reply.userLayer).toMatchObject({
      hash: null,
      detail: ['user layer inventory not built'],
    });
    const failing = await created(
      envWith({
        userLayer: async () => {
          throw new Error('settings.json unreadable');
        },
      }),
    );
    expect(failing.hash).toBeNull();
    expect(failing.out.reply.state).toBe('estimating');
    expect(failing.out.reply.userLayer.detail).toEqual([
      'user layer inventory failed: settings.json unreadable',
    ]);
    const unread = await created(
      envWith({ userLayer: async () => ({ ...layerOf(''), inventory: null, detail: [] }) }),
    );
    expect(unread.out.reply.userLayer).toMatchObject({
      hash: null,
      detail: ['user layer inventory not read'],
      sources: 0,
    });
  });

  it('grantRequired rows of a task repo become launch grant confirmations; other repos stay out', async () => {
    const repo = gitRepo(root, 'granted');
    const { out } = await created(
      envWith({
        grantRequired: () => [
          { project: repo, globs: ['.claude/**'], ops: ['edit'] },
          { project: join(root, 'elsewhere'), globs: ['**'], ops: ['exec-db'] },
        ],
      }),
      repo,
    );
    expect(out.reply.grants).toEqual([
      {
        repoKey: expect.any(String),
        globs: ['.claude/**'],
        ops: ['edit'],
        matchedOwnedPaths: ['**'],
      },
    ]);
  });

  it('P36 guard: the journal with lint warnings equals the one without, except the report line itself', async () => {
    const shape = (lines: readonly JournalLine[]) =>
      lines.map((l) => {
        if (l.kind === 'signal') {
          const d = (l as JournalLine<'signal'>).data;
          return d.signal === USER_LAYER_REPORT_SIGNAL
            ? 'signal:report'
            : `signal:${d.signal}:${d.severity}`;
        }
        if (l.kind === 'decision') {
          const d = (l as JournalLine<'decision'>).data;
          return `decision:${d.class}:${JSON.stringify(d.output)}`;
        }
        if (l.kind === 'task.created') {
          const d = (l as JournalLine<'task.created'>).data;
          return `task.created:${d.userLayerHash}:${JSON.stringify(d.scenario)}`;
        }
        return l.kind;
      });
    const linted = await created(
      envWith({
        userLayer: async () =>
          layerOf('Merge the PR.\nWait for the pipeline.\nRun the whole test suite.'),
      }),
    );
    const clean = await created(
      envWith({ userLayer: async () => layerOf('Prefer small functions.') }),
    );
    expect(linted.out.reply.userLayer.warnings.map((w) => w.rule)).toEqual([
      'merge',
      'ci-wait',
      'whole-suite',
    ]);
    expect(clean.out.reply.userLayer.warnings).toEqual([]);
    expect(shape(linted.lines)).toEqual(shape(clean.lines));
    expect(linted.out.reply.state).toBe(clean.out.reply.state);
  });
});
