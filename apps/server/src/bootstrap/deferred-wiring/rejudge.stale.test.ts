import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { DeferredAskRecord } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import { rejudgeGroupAsk, type RejudgeDeps } from './rejudge.ts';

/**
 * Пересуд ждущей записи группы, 26.10 (D-5/D-10/D-11): настоящие каталоги копии,
 * настоящие файлы во временном каталоге системы и настоящие транскрипты —
 * разговора и субагента. Подменён только снимок git копии (`deps.worktree`).
 */

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const norm = (text: string | undefined): string => (text ?? '').replace(/\\/g, '/').toLowerCase();
const T0 = Date.now();
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function stand() {
  const root = mkdtempSync(join(tmpdir(), 'cc-rejudge-stale-'));
  made.push(root);
  const copy = join(root, 'shop-worktrees', 'fix-a');
  mkdirSync(copy, { recursive: true });
  const store = new AppStore(join(root, 'agentdeck'));
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: join(root, 'repo'),
    createdAt: '2026-10-26T00:00:00.000Z',
    request: { allowEdits: true },
    groups: [{ index: 1, title: 'g', status: 'awaiting', chatId: 'group-chat', branch: 'fix/a' }],
  } as unknown as SplitPlanRecord);
  store.setChatLink('group-chat', {
    parentChatId: 'parent',
    groupIndex: 1,
    branch: 'fix/a',
    createdAt: '2026-10-26T00:00:00.000Z',
  });
  const projects = join(root, 'projects');
  const session = join(projects, 'C--copy');
  mkdirSync(join(session, 'sess-1', 'subagents'), { recursive: true });
  const deps: RejudgeDeps = {
    source: store,
    projectsDir: projects,
    guardedPatterns: () => [],
    allowedTools: () => new Set(),
    guarded: () => false,
    worktree: async (group) => ({ ...group, worktree: copy, ownBranch: 'fix/a', ignored: [] }),
  };
  const use = (id: string, command: string, offsetMs: number, sidechain: boolean) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at(offsetMs),
      cwd: copy,
      ...(sidechain ? { isSidechain: true } : {}),
      message: {
        id: `m-${id}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    });
  const result = (id: string, offsetMs: number) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(offsetMs),
      cwd: copy,
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] },
    });
  /** Главный файл разговора и, если дано, файл субагента с этим вызовом. */
  const transcripts = (command: string, subagent?: string[]) => {
    writeFileSync(join(session, 'sess-1.jsonl'), `${use('toolu_agent', 'x', -60_000, false)}\n`);
    const lines = [...(subagent ?? []), use('toolu_now', command, 20_000, true)];
    writeFileSync(join(session, 'sess-1', 'subagents', 'agent-a.jsonl'), `${lines.join('\n')}\n`);
  };
  const waiting = (command: string): DeferredAskRecord => ({
    id: 'D-5',
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'parent', groupIndex: 1 },
    runKeys: ['group-chat', 'sess-1'],
    toolName: 'Bash',
    toolUseId: 'toolu_now',
    input: { command },
    hash: 'h',
    reason: "the group's permission rows send this call to the human",
    reasonCode: 'group-rows',
    askedAt: at(20_000),
    expiresAt: at(86_400_000),
    cwd: copy,
    source: {},
  });
  return { root, copy, deps, use, result, transcripts, waiting };
}

describe('пересуд: папки команды больше нет (D-5)', () => {
  /**
   * Форма D-5: клон рецензии вне копии, `cd` в него, пробный скрипт и его
   * удаление после `;` — оно и уводило запись человеку (удаление вне копии).
   */
  const d5 = (clone: string) =>
    `C="${clone}"; cd "$C" && grep -n "  // pair" scripts/check_content.mjs && node -e 'const fs=require("fs");fs.writeFileSync("scripts/check_content.probe.mjs","x")' && node scripts/check_content.probe.mjs 2>&1 | grep PROBE; rm scripts/check_content.probe.mjs`;

  it('клон убран — отказ агенту: названа папка, сказано, что делать', async () => {
    const { root, deps, transcripts, waiting } = stand();
    const clone = join(root, 'claude-review', 'review-docs', 'clone', 'inst-docs-ui');
    transcripts(d5(clone));
    const decision = await rejudgeGroupAsk(waiting(d5(clone)), deps);
    expect(decision?.behavior).toBe('deny');
    expect(norm(decision?.message)).toContain(`the folder ${norm(clone)} this call works in`);
    expect(decision?.message).toContain('Redo the step if it is still needed.');
  });

  it('клон на месте — по-прежнему человеку: отказ только для убранной папки', async () => {
    const { root, deps, transcripts, waiting } = stand();
    const clone = join(root, 'claude-review', 'review-docs', 'clone', 'inst-docs-ui');
    mkdirSync(clone, { recursive: true });
    transcripts(d5(clone));
    expect(await rejudgeGroupAsk(waiting(d5(clone)), deps)).toBeUndefined();
  });

  it('разрешение сильнее: чтение в убранной папке копии — разрешить', async () => {
    const { copy, deps, transcripts, waiting } = stand();
    const command = `cd ${copy.replace(/\\/g, '/')}/.agent/tmp/gone && cat notes.txt`;
    transcripts(command);
    expect(await rejudgeGroupAsk(waiting(command), deps)).toEqual({ behavior: 'allow' });
  });
});

describe('пересуд: свой временный файл субагента (D-10/D-11) и рабочая папка CLI', () => {
  it('D-10: возврат копии и уборка `rm /tmp/<stem>-*.bak` после своего `cp` — разрешить', async () => {
    const { copy, deps, use, result, transcripts, waiting } = stand();
    const clone = join(copy, '.agent', 'tmp', 'review', 'clone', 'inst-admin-ui');
    mkdirSync(join(clone, 'src'), { recursive: true });
    const stem = `rj${process.pid}${Math.random().toString(36).slice(2, 8)}`;
    for (const name of [`${stem}-c.bak`, `${stem}-w.bak`]) {
      made.push(join(tmpdir(), name));
      writeFileSync(join(tmpdir(), name), 'backup');
    }
    const C = clone.replace(/\\/g, '/');
    const backup = `cd ${C} && cp src/a.ts /tmp/${stem}-c.bak && cp src/b.tsx /tmp/${stem}-w.bak`;
    const restore = `cd ${C} && cp /tmp/${stem}-c.bak src/a.ts && cp /tmp/${stem}-w.bak src/b.tsx && rm /tmp/${stem}-*.bak && git status --short`;
    transcripts(restore, [use('toolu_cp', backup, -5_000, true), result('toolu_cp', 5_000)]);
    expect(await rejudgeGroupAsk(waiting(restore), deps)).toEqual({ behavior: 'allow' });
    // Без улики та же команда — человеку: своё в `/tmp` только доказанное.
    transcripts(restore);
    expect(await rejudgeGroupAsk(waiting(restore), deps)).toBeUndefined();
  });

  it('уборка в рабочей папке CLI этой сессии — как у живого маршрута: разрешить', async () => {
    const { deps, transcripts, waiting } = stand();
    const pad = join(tmpdir(), 'claude', 'C--copy', 'sess-1', 'scratchpad').replace(/\\/g, '/');
    const command = `rm -rf "${pad}/shots"`;
    transcripts(command);
    expect(await rejudgeGroupAsk(waiting(command), deps)).toEqual({ behavior: 'allow' });
  });
});
