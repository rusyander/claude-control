import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Непорождённое звено правок или доставки (F-07 ревью П1): звено заведено под
 * `new-…`, процесс оборвался до первого хода. «Продолжить» раньше продолжало
 * прошлую сессию работы общим «продолжи, где остановился» — замечания ревью и
 * задание доставки терялись, цепочка кончалась, а напоминание доставки уходило
 * в сессию с запретом пуша. Теперь звено стартует заново СВОИМ заданием, под
 * своим ключом и со своим профилем. Сборка настоящая (`createRuntime`), подменён
 * только процесс CLI.
 */

const PARENT = 'родитель-f07';
const FINDING = 'SENTINEL_FINDING foo.ts:12 null deref';
const DELIVERY = 'SENTINEL_DELIVERY push the branch feature/g1 and open an MR';
const HANDOFF = 'SENTINEL_HANDOFF next: EditModelPage read-only view';

const base: ChatLink = {
  parentChatId: PARENT,
  groupIndex: 0,
  branch: 'feature/g1',
  model: 'claude-sonnet-4-5',
  ceilingModel: 'claude-opus-4-1',
  lowered: true,
  createdAt: '2026-10-20T01:00:00.000Z',
};

interface StageSettings {
  permissions?: { deny?: string[] };
}

describe('непорождённое звено правок и доставки продолжается своим заданием (F-07)', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let started: RunOptions[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-unborn-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    const git = (args: string): void => {
      execSync(`git ${args}`, { cwd: project, stdio: 'ignore' });
    };
    git('init -q -b main');
    git('-c user.email=p@x -c user.name=p commit -q --allow-empty -m base');
    git('checkout -q -b feature/g1');
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    store = new AppStore(appData);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    started = [];
    // Ход не кончается: проверяется только то, с чем звено стартовало.
    const fake = (): RunLike => ({
      start: async (options) => {
        started.push(options);
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  /** Работа и ревью родились; звено `key` заведено, но оборвалось до первого хода. */
  function seed(key: string, unborn: ChatLink): void {
    const work: ChatLink = {
      ...base,
      stage: 'work',
      conversation: 'new-w',
      reviewedAt: '2026-10-20T02:00:00.000Z',
    };
    store.setChatLink('new-w', work);
    store.setChatLink('work-sid', work);
    const review: ChatLink = {
      ...base,
      stage: 'review',
      model: 'claude-opus-4-1',
      createdAt: '2026-10-20T02:00:00.000Z',
      conversation: 'new-r',
    };
    store.setChatLink('new-r', review);
    store.setChatLink('review-sid', review);
    store.setChatLink(key, unborn);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: project,
      createdAt: '2026-10-20T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'G', tasks: ['PROJ-1'] }] },
      groups: [
        {
          index: 0,
          title: 'G',
          branch: 'feature/g1',
          after: [],
          status: 'awaiting',
          waitingFor: 'interrupted',
          chatId: key,
          path: project,
          deliver: true,
        },
      ],
    } as unknown as SplitPlanRecord);
  }

  async function resume(): Promise<{ resumed: number[]; refused: number[] }> {
    const outcome = runtime.splitConveyor.resumeInterrupted(PARENT, 0) as unknown as {
      resumed: number[];
      refused: number[];
    };
    await new Promise((done) => setTimeout(done, 100));
    return outcome;
  }

  it('правки: стартуют под своим ключом с замечаниями, а не продолжением работы', async () => {
    seed('new-fix', {
      ...base,
      stage: 'fix',
      createdAt: '2026-10-20T03:00:00.000Z',
      fixFindings: [FINDING],
      stagePrompt: `Fix the review findings:\n- ${FINDING}`,
    });

    expect((await resume()).resumed).toEqual([0]);

    const run = started[0];
    expect(run?.permissionPrompt?.runId).toBe('new-fix');
    expect(run?.sessionId).toBeUndefined();
    expect(run?.prompt).toContain(FINDING);
  });

  it('доставка: стартует своим заданием, и пуш этой сессии не запрещён', async () => {
    seed('new-deliver', {
      ...base,
      stage: 'deliver',
      createdAt: '2026-10-20T03:00:00.000Z',
      stagePrompt: DELIVERY,
    });

    expect((await resume()).resumed).toEqual([0]);

    const run = started[0];
    expect(run?.permissionPrompt?.runId).toBe('new-deliver');
    expect(run?.prompt).toContain(DELIVERY);
    const deny = (run?.platformSettings as StageSettings | undefined)?.permissions?.deny ?? [];
    expect(deny).not.toContain('Bash(git push*)');
  });

  it('продолжение работы, оборванное паузой до первого хода, стартует своей вводной (d9869abf:9)', async () => {
    seed('new-cont', {
      ...base,
      stage: 'work',
      createdAt: '2026-10-20T03:00:00.000Z',
      stagePrompt: HANDOFF,
    });
    const plan = store.getSplitPlan(PARENT)!;
    plan.groups[0] = { ...plan.groups[0]!, status: 'paused', pausedAt: '2026-10-20T03:00:02.000Z' };
    store.setSplitPlan(plan);
    // Ход работы не кончается: конец завёл бы ревью уже после теста, в чужой `started`.
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = () => ({
      start: (options) => {
        started.push(options);
        return new Promise<void>(() => undefined);
      },
      stop: () => undefined,
    });

    expect(runtime.splitConveyor.resumePaused(PARENT, 0, true)).toBe('sent');
    await new Promise((done) => setTimeout(done, 100));

    const run = started[0];
    expect(run?.permissionPrompt?.runId).toBe('new-cont');
    expect(run?.sessionId).toBeUndefined();
    expect(run?.prompt).toContain(HANDOFF);
  });

  // Та же беда со стороны сборки: перенос связи продолжения (`carryLink`) хранит
  // вводную, с которой продолжение стартовало, — иначе пауза до первого хода её теряет.
  it('продолжение группы по контексту несёт в связи ту же вводную, что ушла в прогон (d9869abf:9)', async () => {
    const work: ChatLink = { ...base, stage: 'work', conversation: 'чат-w' };
    store.setChatLink('чат-w', work);
    const proposal = { done: 'этап закрыт', next: HANDOFF, checkpoint: '.agent/PROGRESS.md' };
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = () => ({
      start: (options, onEvent) => {
        started.push(options);
        if (started.length > 1) return new Promise<void>(() => undefined);
        mkdirSync(join(project, '.agent'), { recursive: true });
        writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'progress', 'utf8');
        onEvent({
          kind: 'text',
          text: ['Готово.', '', '```' + HANDOFF_BLOCK_LANG, JSON.stringify(proposal), '```'].join(
            '\n',
          ),
        });
        // Окно почти полно — продолжение уходит в чистую сессию, а не в эту же.
        onEvent({ kind: 'usage', input: 10, output: 5, cacheRead: 990_000, cacheCreation: 0 });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'work-sid' });
        return Promise.resolve();
      },
      stop: () => undefined,
    });

    runtime.chatRuns.start('чат-w', { prompt: 'работай', cwd: project }, { projectPath: project });
    await new Promise((done) => setTimeout(done, 100));

    const next = started[1];
    expect(next?.prompt).toContain(HANDOFF);
    expect(next?.sessionId).toBeUndefined();
    const key = next?.permissionPrompt?.runId ?? '';
    expect(key).toMatch(/^new-/);
    expect(store.getChatLink(key)?.stagePrompt).toBe(next?.prompt);
  });

  it('связь без сохранённого задания — к человеку, а не продолжение работы общим словом', async () => {
    seed('new-old', {
      ...base,
      stage: 'fix',
      createdAt: '2026-10-20T03:00:00.000Z',
      fixFindings: [FINDING],
    });

    expect((await resume()).refused).toEqual([0]);
    expect(started).toEqual([]);
  });
});
