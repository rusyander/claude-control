import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { DeferredAskRecord } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import type { OwnerRow } from '../../domains/chat/group-process-owner.ts';
import { rejudgeGroupAsk, type RejudgeDeps } from './rejudge.ts';

/**
 * Повторный суд ждущей записи группы при старте (D-1, 24.10): настоящий стор
 * панели и настоящий транскрипт копии во временной папке; подменены только
 * снимок процессов и держатели портов — граница ОС.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';
const filetime = (ms: number): bigint => BigInt(ms + 11_644_473_600_000) * 10_000n;
const LAUNCHED = '(npx vite --port 5284 --strictPort &)';
const STUB = `bash.exe -c "source /c/snap.sh && eval '${LAUNCHED}' < /dev/null && pwd -P"`;

/** Сирота группы: заглушка bash (CLI ушёл) → vite на :5284; 200 — dev-сервер владельца. */
const t = Date.now() - 10 * 60_000;
const TABLE: OwnerRow[] = [
  { pid: 500, ppid: 4, created: filetime(t), command: STUB },
  { pid: 501, ppid: 500, created: filetime(t + 1000), command: 'node vite.js --port 5284' },
  { pid: 200, ppid: 7, created: filetime(t - 60_000), command: 'node vite.js --port 5178' },
  { pid: 7, ppid: 0, created: filetime(t - 120_000), command: 'WindowsTerminal.exe' },
];
const HOLDERS: Record<number, number[]> = { 5284: [501], 5178: [200] };

function setup(transcript: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'cc-rejudge-'));
  dirs.push(root);
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  store.setSplitPlan({
    parentChatId: 'parent',
    projectPath: join(root, 'repo'),
    createdAt: '2026-10-24T10:00:00.000Z',
    request: { allowEdits: true },
    groups: [
      { index: 1, title: 'g', status: 'awaiting', chatId: 'group-chat', branch: 'fix-PROJ-1/x' },
    ],
  } as unknown as SplitPlanRecord);
  store.setChatLink('group-chat', {
    parentChatId: 'parent',
    groupIndex: 1,
    branch: 'fix-PROJ-1/x',
    createdAt: '2026-10-24T10:00:00.000Z',
  });
  const projects = join(root, 'projects');
  mkdirSync(join(projects, 'C--copy'), { recursive: true });
  writeFileSync(join(projects, 'C--copy', 'sess-1.jsonl'), `${transcript.join('\n')}\n`);
  const deps: RejudgeDeps = {
    source: store,
    projectsDir: projects,
    guardedPatterns: () => [],
    allowedTools: () => new Set(),
    guarded: () => false,
    facts: {
      readTable: async () => TABLE,
      portHolders: (port) => HOLDERS[port] ?? [],
      platform: 'win32',
    },
    worktree: async (group) => ({
      ...group,
      worktree: COPY,
      ownBranch: 'fix-PROJ-1/x',
      ignored: [],
    }),
  };
  return { deps };
}

const callLine = (command: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });

function waiting(command: string, extra: Partial<DeferredAskRecord> = {}): DeferredAskRecord {
  return {
    id: 'D-1',
    state: 'waiting',
    kind: 'permission',
    scope: { kind: 'group', parentChatId: 'parent', groupIndex: 1 },
    runKeys: ['group-chat', 'sess-1'],
    toolName: 'Bash',
    input: { command },
    hash: 'h',
    reason: "the group's permission rows send this call to the human",
    reasonCode: 'group-rows',
    askedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    cwd: COPY,
    source: {},
    ...extra,
  };
}

/** Дословная команда D-1 (24.10 16:10Z): своя vite на :5284 по номеру из netstat. */
const D1 = `for p in $(netstat -ano | grep ":5284 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done; netstat -ano | grep -c ":5284 .*LISTENING"`;

describe('rejudgeGroupAsk', () => {
  it('D-1: своя сирота на порту (запуск записан в копии) — разрешить', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(await rejudgeGroupAsk(waiting(D1), deps)).toEqual({ behavior: 'allow' });
  });

  it('та же команда без записи запуска — отказ агенту с подписью процесса', async () => {
    const { deps } = setup([callLine('npm run build')]);
    const decision = await rejudgeGroupAsk(waiting(D1), deps);
    expect(decision?.behavior).toBe('deny');
    expect(decision?.message).toContain('port 5284 held by pid 501 (node vite.js --port 5284)');
  });

  it('порт владельца — отказ; неназванная цель — отказ с тем, как назвать', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    const owner = await rejudgeGroupAsk(waiting('npx kill-port 5178'), deps);
    expect(owner).toMatchObject({ behavior: 'deny' });
    expect(owner?.message).toContain('port 5178 held by pid 200');
    const unnamed = await rejudgeGroupAsk(waiting('pkill -f vite'), deps);
    expect(unnamed?.message).toContain('does not name by number');
  });

  it('порт без держателя — разрешить: гасить нечего', async () => {
    const { deps } = setup();
    expect(await rejudgeGroupAsk(waiting('npx kill-port 5999'), deps)).toEqual({
      behavior: 'allow',
    });
  });

  it('не погашение, защита бэкенда, чужая причина, не группа — по-прежнему человеку', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(await rejudgeGroupAsk(waiting('psql -c "DROP TABLE users"'), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1), { ...deps, guarded: () => true })).toBeUndefined();
    expect(
      await rejudgeGroupAsk(waiting(D1, { reasonCode: 'backend-guard' }), deps),
    ).toBeUndefined();
    expect(
      await rejudgeGroupAsk(waiting(D1, { scope: { kind: 'chat', chatKeys: ['c'] } }), deps),
    ).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1, { state: 'allowed' }), deps)).toBeUndefined();
    expect(await rejudgeGroupAsk(waiting(D1, { runKeys: ['stranger'] }), deps)).toBeUndefined();
  });

  it('погашение рядом с затиранием или пушем — живому маршруту', async () => {
    const { deps } = setup([callLine(LAUNCHED)]);
    expect(
      await rejudgeGroupAsk(waiting(`npx kill-port 5284 && git reset --hard HEAD~1`), deps),
    ).toBeUndefined();
  });
});
