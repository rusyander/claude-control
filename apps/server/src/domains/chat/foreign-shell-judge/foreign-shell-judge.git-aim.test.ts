import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { judgeForeignShell, type ForeignShellJudgeDeps } from './foreign-shell-judge.ts';

/**
 * git над копией у чужого CLI (D-4, 25.10) — тот же отказ, что у маршрута Claude:
 * `cd ..; git -C ..` из подпапки поднимается выше копии, и вместо D-n группа
 * получает причину с тем, где пошёл бы git. Настоящие хранилище, копия git и суд;
 * мост к маршруту Claude — заглушка, которая считает заведённые D-n.
 */
describe('judgeForeignShell — git над копией (D-4)', () => {
  const KEY = 'codex:group-chat';
  let root: string;
  let copy: string;
  let sub: string;
  let store: AppStore;
  const deferred: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-foreign-aim-'));
    copy = join(root, 'shop-worktrees', 'fix-PROJ-1-x');
    sub = join(copy, 'inst-docs-ui');
    mkdirSync(join(sub, 'src'), { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: copy,
        stdio: 'ignore',
      });
    };
    git('init', '-q', '-b', 'fix-PROJ-1/x');
    writeFileSync(join(sub, 'src', 'app.tsx'), 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'codex:parent',
      projectPath: join(root, 'repo'),
      createdAt: '2026-10-25T10:00:00.000Z',
      request: { allowEdits: true },
      groups: [{ index: 1, title: 'g', status: 'started', chatId: KEY, branch: 'fix-PROJ-1/x' }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(KEY, {
      parentChatId: 'codex:parent',
      groupIndex: 1,
      branch: 'fix-PROJ-1/x',
      createdAt: '2026-10-25T10:00:00.000Z',
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const deps = (): ForeignShellJudgeDeps => ({
    store,
    bridge: {
      asks: () => ({ consume: () => undefined, retryOf: () => undefined }),
      scopeOf: () => ({ kind: 'group', parentChatId: 'codex:parent', groupIndex: 1 }),
      reachesPanelDecision: () => false,
      deliveryRefusal: () => undefined,
      protectedWriteRefusal: async () => undefined,
      defer: (call) => {
        deferred.push(String((call.input as { command?: unknown }).command));
        return 'D-1 waits for the human';
      },
      withMrState: async (group) => group,
      syncRefOf: async () => undefined,
    },
    deliverAhead: () => false,
    autoApproveRules: () => new Set(),
    guardedPatterns: () => [],
    guardHit: () => undefined,
  });

  const judge = (command: string, cwd: string | undefined) =>
    judgeForeignShell(
      {
        key: KEY,
        providerId: 'codex',
        workdir: copy,
        ...(cwd ? { cwd } : {}),
        command,
        shell: 'bash',
        allowEdits: true,
      },
      deps(),
    );
  const norm = (text: string): string => text.replace(/\\/g, '/').toLowerCase();

  it('два подъёма из подпапки — отказ с причиной, D-n не заводится', async () => {
    deferred.length = 0;
    const live =
      'cd .. 2>/dev/null; git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue';
    const verdict = await judge(live, sub);
    expect(verdict.behavior).toBe('deny');
    const text = norm(verdict.behavior === 'deny' ? verdict.message : '');
    expect(text).toMatch(/^nothing in this command ran: /);
    expect(text).toContain(`your shell is in ${norm(sub)}`);
    expect(text).toContain(`git would run in ${norm(join(root, 'shop-worktrees'))},`);
    expect(text).toContain(`contains your copy ${norm(copy)}`);
    expect(deferred).toEqual([]);
  });

  it('один подъём из подпапки и абсолютный путь к копии — не этот отказ', async () => {
    const one = await judge('git -C .. add inst-docs-ui/src/app.tsx', sub);
    const absolute = await judge(`git -C "${copy}" add inst-docs-ui/src/app.tsx`, sub);
    for (const verdict of [one, absolute]) {
      expect(verdict.behavior === 'deny' ? verdict.message : '').not.toContain(
        'Nothing in this command ran',
      );
    }
    expect(one.behavior).toBe('allow');
    expect(absolute.behavior).toBe('allow');
  });

  it('каталог оболочки вне копии суд не берёт — `-C ..` от угаданного корня: отказ назвать копию (D-6)', async () => {
    deferred.length = 0;
    const verdict = await judge('git -C .. add x', join(root, 'elsewhere'));
    const text = verdict.behavior === 'deny' ? verdict.message : '';
    expect(text).not.toContain('your shell is in');
    expect(text).toContain('so `..` was counted from your copy root');
    expect(deferred).toEqual([]);
  });
});
