import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, describe, expect, it } from 'vitest';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { CONTAINER_CALLS_FILE } from '../../mcp/container-wrap.ts';
import { PROTECTED_FILE, protectedAtEnd, protectedBefore } from './protected-step.ts';
import { BASELINE_FILE, scanAfterStop, takeBaseline, type ResourceReaders } from './resources.ts';

/**
 * Каталог сессии пишет любой процесс её дерева (P04: право не судит текст команды) — значит,
 * ничто оттуда не решает за ядро (ревью B2r4-F02, B2r4-F04). Сессия переписывает снимок ресурсов
 * (чужой репозиторий, чужой движок), журнал вызовов движка (путь к любой программе) и снимок
 * защищённых корней (своя копия = основная) — ядро не запускает чужое, не снимает чужое и не
 * теряет находку.
 */

const root = tempDir('session-writable-');
const temps: string[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const got = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (got.status !== 0) throw new Error(`git ${args.join(' ')}: ${got.stderr}`);
}

describe('session-writable files are never the core source of truth', () => {
  it('a rewritten baseline and a forged calls line: no foreign engine run, no foreign repo read', async () => {
    const registry = createTaskRegistry(join(root, 'res', 'tasks'), deps());
    const task = await registry.create(CREATED);
    const session = seedSession(task, { stepKind: 'work' });
    const dir = join(root, 'res', 'session');
    const stateDir = join(root, 'res', 'core-state');
    mkdirSync(dir, { recursive: true });
    const ran: string[] = [];
    const readers: ResourceReaders = {
      worktrees: async (repo) => {
        ran.push(`worktrees ${repo}`);
        return { value: [] };
      },
      containers: async (_t, engine) => {
        ran.push(`containers ${engine}`);
        return { value: [] };
      },
      listeners: async () => ({ value: [] }),
      sweep: async () => ({ value: [] }),
      projectContainers: async (_p, engine) => {
        ran.push(`project ${engine}`);
        return { value: [] };
      },
      allContainers: async () => ({ value: [] }),
    };
    const baseline = await takeBaseline(
      { task, sessionId: session.sessionId, stateDir, cwd: dir, engines: [] },
      readers,
    );
    // Сессия переписывает снимок в своём каталоге и дописывает строку вызова движка.
    writeFileSync(
      join(dir, BASELINE_FILE),
      JSON.stringify({ worktrees: [], containers: {}, engines: ['evil.exe'], cwd: 'C:\\victim' }),
    );
    writeFileSync(
      join(dir, CONTAINER_CALLS_FILE),
      `${JSON.stringify({ v: 1, at: 1, engine: 'C:\\evil\\touch.exe', kind: 'compose-project', project: 'x', before: [] })}\n`,
    );
    const handle = { sessionId: session.sessionId, dir, host: { pid: 1, start: 'x' } };
    ran.length = 0;
    const out = await scanAfterStop(
      {
        task,
        handle: handle as unknown as SessionHandle,
        tmpDir: join(dir, 'none'),
        readers,
        note: () => undefined,
        baseline: { value: baseline },
      },
      { ports: [], unread: [] },
      { how: 'exited', residual: [] },
    );
    registry.closeAll();
    expect(ran.filter((r) => /victim|evil/i.test(r))).toEqual([]);
    expect(out.unread).toContain(
      'container calls: engine C:\\evil\\touch.exe not wrapped by the core',
    );
  });

  it('a rewritten protected-roots snapshot does not erase the finding in the main checkout', async () => {
    const fx = mkdtempSync(join(tmpdir(), 'agentdeck-writable-'));
    temps.push(fx);
    const main = join(fx, 'repo');
    const own = join(fx, 'own');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'own', own);
    const dir = join(fx, 'session');
    const stateDir = join(fx, 'core-state');
    mkdirSync(dir);
    const { task } = await openFresh();
    const { sessionId, stepId } = seedSession(task, { stepKind: 'work' });
    const layer = { dirs: [], credentials: [] };
    await protectedBefore({ task, sessionId, stateDir, stepId, cwd: own, layer, ownCopies: [] });
    writeFileSync(join(main, 'dropped.sql'), 'drop\n');
    // Сессия переписывает «свою копию» на основную — так её находка исчезла бы.
    const forged = { input: { repo: own, ownCopy: main, volatile: [main] }, stepId, before: {} };
    writeFileSync(join(dir, PROTECTED_FILE), JSON.stringify(forged));
    // Без `held` — путь прикреплённой заново сессии: снимок из дома ядра по отпечатку журнала.
    const end = { task, sessionId, stateDir, cwd: own, ownCopies: [], liveCopies: [] };
    const got = await protectedAtEnd(end);
    expect(got).toMatchObject({
      value: [expect.objectContaining({ root: 'main-checkout', change: 'status' })],
    });
    expect(readFileSync(join(dir, PROTECTED_FILE), 'utf8')).toContain('ownCopy');
    // Подменён сам снимок в доме ядра — отпечаток не сходится: `unknown` и `stop`, не «чисто».
    writeFileSync(join(stateDir, sessionId, PROTECTED_FILE), JSON.stringify(forged));
    const tampered = await protectedAtEnd(end);
    expect(tampered).toEqual({
      unknown: `before: ${PROTECTED_FILE}: changed after the core wrote it`,
    });
    const last = readJournalLines(task.dir, task.taskId).lines.at(-1) as JournalLine<'signal'>;
    expect(last.data).toMatchObject({ signal: 'protected-root-unread', severity: 'stop' });
    task.close();
  });
});
