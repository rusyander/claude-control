import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelCheckReply } from '../../conductor/checks/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import {
  R1,
  seedRequirements,
  seedSession,
} from '../../conductor/model-tools/__fixtures__/seed.ts';
import { handleModelTool } from '../../conductor/model-tools/model-tools.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../../platform/core-home.ts';
import { evidenceWiring } from './evidence.ts';
import { queueWiring } from './queue.ts';
import { verifyWiring } from './verify.ts';

/**
 * Свежесть и охват доказательства `step_done` на настоящем пути (G22, P92): дом ядра во временном
 * каталоге, настоящий git-репозиторий с реестром, настоящий прогон проверки ядра, запись в
 * настоящем хранилище, ключ на дереве и дифф единицы — настоящие чтения git. Подмены нет.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

interface Stand {
  home: CoreHomeLayout;
  repo: string;
  task: LiveTask;
  b: SessionBinding;
}

async function stand(baseRef = 'main'): Promise<Stand> {
  const root = mkdtempSync(join(tmpdir(), 'adk-evid-'));
  roots.push(root);
  const home = ensureCoreHome(join(root, 'home'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [
        { id: 'tests', class: 'test-runner', argv: ['node', 'ok.mjs'], requiredAt: ['publish'] },
        { id: 'lint', class: 'static', argv: ['node', 'ok.mjs'], requiredAt: ['publish'] },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const { task } = await openFresh(join(root, 'tasks'));
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: repo, baseRef }] },
  });
  seedRequirements(task, [R1]);
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { home, repo, task, b: bound.binding };
}

async function claimWith(s: Stand, checkId: string, edit: () => void = () => undefined) {
  const queue = queueWiring({ registry: { live: () => s.task }, layout: s.home });
  const ran = (await queue.check(s.task, s.b, { checkId })) as ModelCheckReply;
  expect(ran.verdict, JSON.stringify(ran)).toBe('pass');
  edit();
  const deps = {
    ...verifyWiring({ registry: { liveTasks: () => [s.task] }, layout: s.home }),
    evidence: evidenceWiring(queue),
    humanPolicy: () => ({
      actionClasses: [],
      pathGlobs: [],
      grantRequired: [],
      trackerWrites: 'ask' as const,
      forgeWrites: 'auto' as const,
    }),
  };
  return handleModelTool(
    s.task,
    s.b,
    'step_done',
    {
      stepId: s.b.stepId,
      outcome: 'done',
      requirements: [{ id: R1, state: 'covered', evidence: [ran.recordId as string] }],
      summary: 'changed a.ts and ran the tests',
    },
    deps,
  );
}

describe('step_done evidence on a real repo, store and tree (G22, P92)', () => {
  it('a core test-runner record on the current tree, whose closure holds the changed file, covers', async () => {
    const s = await stand();
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 2;\n');
    const claim = await claimWith(s, 'tests');
    // Замечания первыми: отказ назван причиной, а не одним `ok: false`.
    expect('issues' in claim ? claim.issues : []).toEqual([]);
    expect(claim).toMatchObject({ ok: true });
    s.task.close();
  });

  it('G22 the tree moved after the run: the recomputed key differs, the claim is stale-evidence', async () => {
    const s = await stand();
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 2;\n');
    const reply = await claimWith(s, 'tests', () =>
      writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 3;\n'),
    );
    expect(reply).toMatchObject({
      ok: false,
      code: 'evidence-rejected',
      issues: [{ message: expect.stringMatching(/^stale-evidence: .*the tree moved/) }],
    });
    s.task.close();
  });

  it('P92 a static record never covers; a green run over a tree with nothing changed against the base covers nothing', async () => {
    const s = await stand();
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 2;\n');
    expect(await claimWith(s, 'lint')).toMatchObject({
      ok: false,
      issues: [{ message: expect.stringMatching(/^irrelevant-evidence: .*static check/) }],
    });
    s.task.close();
    const idle = await stand();
    expect(await claimWith(idle, 'tests')).toMatchObject({
      ok: false,
      issues: [{ message: expect.stringMatching(/^irrelevant-evidence: .*covers none/) }],
    });
    idle.task.close();
  });

  it('git.diff-unit fault: a base the repository does not have is unknown, the claim refuses, never "nothing changed"', async () => {
    const s = await stand('no-such-base');
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 2;\n');
    const reply = await claimWith(s, 'tests');
    expect(reply).toMatchObject({
      ok: false,
      issues: [
        { message: expect.stringMatching(/^irrelevant-evidence: .*not readable: .*no-such-base/) },
      ],
    });
    s.task.close();
  });
});
