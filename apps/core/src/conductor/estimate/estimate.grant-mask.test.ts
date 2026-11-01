import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dlpSecretMask } from '../../bootstrap/secret-mask.ts';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { applyGrant } from '../commands/grant.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { estimateBody, gitRepo, testEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { estimateTask, USER_LAYER_REPORT_SIGNAL } from './estimate.ts';
import type { LaunchLayer } from './estimate.types.ts';

/**
 * Грант запуска под настоящей маской журнала (`dlpSecretMask`, как в ядре): ответ оценки и
 * экран строятся по строке `user-layer-report`, а правило пары JSON считало `repoKey` (сегмент
 * `key`) секретом и писало «••••••». Команда `grant` с таким проектом не находила репозиторий
 * задачи — грант нельзя было подтвердить. Ключ репозитория — имя, секреты в той же строке
 * по-прежнему прячутся.
 */

const j = (...parts: string[]): string => parts.join('');
// Ключ вендора и пароль под секретным именем — из кусков: в репозитории не лежат целиком.
const VENDOR_KEY = j('sk-ant-api03-', 'Zq8RmT4vXw2', 'NpL7cYb9KdFh3', 'GsJ6aE1uQo5');
const NAMED_SECRET = j('h7Rq', '-', 'Xw2pLm9vTz');

let root: string;
let registry: TaskRegistry;
let scenarios: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-estimate-grant-mask-'));
  const layout = layoutOf(join(root, 'home'));
  registry = createTaskRegistry(layout.tasks, deps({ mask: dlpSecretMask }));
  scenarios = layout.scenarios;
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const layer: LaunchLayer = {
  inventory: null,
  texts: [],
  asked: { hooks: 'on', skills: 'on' },
  ran: { hooks: 'on', skills: 'on' },
  detail: [`port said ${VENDOR_KEY}`, `env API_TOKEN=${NAMED_SECRET}`],
};

async function estimateGranted() {
  const repo = gitRepo(root, `granted-${Math.random().toString(36).slice(2, 8)}`);
  const out = await estimateTask(
    estimateBody([repo], { scenario: { preset: 'review-only' } }),
    registry,
    {
      ...testEnv(scenarios),
      userLayer: async () => layer,
      grantRequired: () => [{ project: repo, globs: ['.claude/**'], ops: ['edit'] }],
    },
  );
  if (out.status === 422) throw new Error(out.problems.join('; '));
  const taskId = out.reply.taskId;
  const lines = readJournalLines(join(registry.tasksDir, taskId), taskId).lines;
  const created = lines.find((l) => l.kind === 'task.created') as JournalLine<'task.created'>;
  const report = lines.find(
    (l) =>
      l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === USER_LAYER_REPORT_SIGNAL,
  ) as JournalLine<'signal'>;
  return { reply: out.reply, taskId, repoKeys: created.data.repos.map((r) => r.repoKey), report };
}

describe('estimate grants under the real journal mask (conductor/estimate)', () => {
  it('the reply grant names the task repo key in clear, and the grant command with it is applied', async () => {
    const { reply, taskId, repoKeys, report } = await estimateGranted();
    expect(repoKeys).toHaveLength(1);
    expect(reply.grants.map((g) => g.repoKey)).toEqual(repoKeys);
    expect(report.data.detail).toContain(`"repoKey":${JSON.stringify(repoKeys[0])}`);

    const task = registry.live(taskId);
    if (!task) throw new Error('estimated task is not live');
    const grant = reply.grants[0]!;
    const result = await applyGrant(
      task,
      {
        cmdId: newId(),
        kind: 'grant',
        fields: { project: grant.repoKey, globs: grant.globs, ops: grant.ops },
      } as unknown as CommandEnvelope,
      commandEnv(),
    );
    expect(result.status).toBe('applied');
  });

  it('secrets in the same report line stay masked: a vendor key and a value under a secret name', async () => {
    const { reply, report } = await estimateGranted();
    expect(report.data.detail).not.toContain(VENDOR_KEY);
    expect(report.data.detail).not.toContain(NAMED_SECRET);
    expect(reply.userLayer.detail.join('\n')).not.toMatch(/sk-ant-|h7Rq/);
    expect(reply.userLayer.detail).toEqual(['port said ••••••', 'env API_TOKEN=••••••']);
  });
});
