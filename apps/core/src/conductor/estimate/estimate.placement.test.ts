import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Placement } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { estimateBody, gitRepo, testEnv, type TestEnv } from '../split/__fixtures__/split-stand.ts';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { estimateTask } from './estimate.ts';
import { chatOpeningOf, folderChatRoot, inPlaceRootOf } from './placement.ts';

/**
 * Чат и место работы (этап 10, 06:98) через настоящую оценку: чат не оценивается (у него нет
 * точки деления — `estimating` ждало бы вечно), `auto` запускает его сразу; основная папка
 * проекта — только чату, только одному репозиторию и только с грантом на ЭТОТ корень; грант
 * ложится строкой `grant.given` с ключом оценки.
 */

let root: string;
let tasksDir: string;
let registry: TaskRegistry;
let env: TestEnv;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-placement-'));
  const layout = layoutOf(join(root, 'home'));
  tasksDir = layout.tasks;
  registry = createTaskRegistry(layout.tasks, deps());
  env = testEnv(layout.scenarios);
});
afterAll(() => {
  registry.closeAll();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const journal = (taskId: string): JournalLine[] =>
  readJournalLines(join(tasksDir, taskId), taskId).lines;

const inPlace = (project: string): Placement => ({
  kind: 'in-place',
  grant: { project, ops: ['edit'] },
});

describe('chat@1 estimate: no estimating, in-place only by grant (06:98)', () => {
  it('a panel chat in place with auto launch: running at once, no unit 0, placement and the grant journaled under the estimate cmdId', async () => {
    const repo = gitRepo(root, 'chat-in-place');
    const body = estimateBody([repo], {
      scenario: { preset: 'chat' },
      launchPolicy: 'auto',
      placement: inPlace(repo),
    });
    const out = await estimateTask(body, registry, env);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const lines = journal(out.reply.taskId);
    const created = lines.find((l) => l.kind === 'task.created')!;
    expect((created.data as { placement?: string }).placement).toBe('in-place');
    const grant = lines.find((l) => l.kind === 'grant.given');
    expect(grant?.data).toEqual({ cmdId: body.cmdId, project: repo, globs: ['**'], ops: ['edit'] });
    const moves = lines
      .filter((l) => l.kind === 'task.transition')
      .map((l) => (l.data as { event: string }).event);
    expect(moves).toEqual(['launch']);
    expect(lines.some((l) => l.kind === 'unit.created')).toBe(false);
  });

  it('a chat in a copy with confirm launch stays a draft: no placement field, no grant, no estimating', async () => {
    const repo = gitRepo(root, 'chat-copy');
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'chat' } }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const lines = journal(out.reply.taskId);
    expect('placement' in lines.find((l) => l.kind === 'task.created')!.data).toBe(false);
    expect(lines.some((l) => l.kind === 'grant.given')).toBe(false);
    expect(lines.some((l) => l.kind === 'task.transition')).toBe(false);
  });

  it('in-place is refused before any task exists: a non-chat scenario, a grant for another root, two repositories', async () => {
    const repo = gitRepo(root, 'refused-a');
    const other = gitRepo(root, 'refused-b');
    const before = registry.list().length;
    const feature = await estimateTask(
      estimateBody([repo], { placement: inPlace(repo) }),
      registry,
      env,
    );
    expect(feature).toMatchObject({ status: 422 });
    expect(feature.status === 422 && feature.problems).toEqual([
      'placement in-place: only the chat scenario runs in the project root',
    ]);
    const foreign = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'chat' }, placement: inPlace(other) }),
      registry,
      env,
    );
    expect(foreign.status === 422 && foreign.problems.join('; ')).toMatch(/grant names .* root is/);
    const two = await estimateTask(
      estimateBody([repo, other], { scenario: { preset: 'chat' }, placement: inPlace(repo) }),
      registry,
      env,
    );
    expect(two.status === 422 && two.problems.join('; ')).toMatch(/one repository, got 2/);
    expect(registry.list().length).toBe(before);
  });

  it('the same root written another way is the same root (trailing separator)', async () => {
    const repo = gitRepo(root, 'chat-sep');
    const out = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'chat' }, placement: inPlace(`${repo}/`) }),
      registry,
      env,
    );
    expect(out.status).toBe(202);
  });
});

describe('inPlaceRootOf: where a chat unit works (Q1: in place only by the chat-start grant)', () => {
  it('an in-place panel chat works in the project root; the same chat asked in a copy gets no root', async () => {
    const repo = gitRepo(root, 'root-yes');
    const placed = await estimateTask(
      estimateBody([repo], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(repo),
      }),
      registry,
      env,
    );
    if (placed.status === 422) throw new Error(placed.problems.join('; '));
    // Корень — закреплённый оценкой путь репозитория (длинное имя, а не 8.3 из временной папки).
    expect(inPlaceRootOf(registry.live(placed.reply.taskId)!, 'u1')).toBe(
      realpathSync.native(repo),
    );
    const copy = await estimateTask(
      estimateBody([repo], { scenario: { preset: 'chat' }, launchPolicy: 'auto' }),
      registry,
      env,
    );
    if (copy.status === 422) throw new Error(copy.problems.join('; '));
    expect(inPlaceRootOf(registry.live(copy.reply.taskId)!, 'u1')).toBeUndefined();
  });

  it('no grant line under the estimate key, a grant for another root or without edit: the unit goes to a copy', async () => {
    const repo = gitRepo(root, 'root-no');
    const out = await estimateTask(
      estimateBody([repo], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(repo),
      }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const task = registry.live(out.reply.taskId)!;
    const lines = journal(task.taskId);
    const grant = lines.find((l) => l.kind === 'grant.given')!;
    // Тот же журнал без строки гранта: задача `in-place`, но разрешения человека нет.
    const created = task.state.created!;
    const bare = await registry.create({ ...created, origin: { cmdId: newId() } });
    expect(bare.state.created?.placement).toBe('in-place');
    expect(inPlaceRootOf(bare, 'u1')).toBeUndefined();
    const elsewhere = await registry.create({ ...created, origin: { cmdId: newId() } });
    const key = elsewhere.state.created!.origin!.cmdId;
    elsewhere.append({
      kind: 'grant.given',
      actor: 'core',
      cmdId: key,
      data: { cmdId: key, project: join(root, 'other'), globs: ['**'], ops: ['edit'] },
    });
    expect(inPlaceRootOf(elsewhere, 'u1')).toBeUndefined();
    const dbOnly = await registry.create({ ...created, origin: { cmdId: newId() } });
    const k2 = dbOnly.state.created!.origin!.cmdId;
    dbOnly.append({
      kind: 'grant.given',
      actor: 'core',
      cmdId: k2,
      data: { cmdId: k2, project: repo, globs: ['**'], ops: ['exec-db'] },
    });
    expect(inPlaceRootOf(dbOnly, 'u1')).toBeUndefined();
    // Грант на тот же корень, но другой командой (не начало чата): Q1 — только грант оценки.
    const later = await registry.create({ ...created, origin: { cmdId: newId() } });
    const other = newId();
    later.append({
      kind: 'grant.given',
      actor: 'core',
      cmdId: other,
      data: { cmdId: other, project: repo, globs: ['**'], ops: ['edit'] },
    });
    expect(inPlaceRootOf(later, 'u1')).toBeUndefined();
    expect(grant.cmdId).toBe(created.origin!.cmdId);
  });

  it('a non-chat task created in-place never works in the root', async () => {
    const repo = gitRepo(root, 'root-feature');
    const chat = await estimateTask(
      estimateBody([repo], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(repo),
      }),
      registry,
      env,
    );
    if (chat.status === 422) throw new Error(chat.problems.join('; '));
    // Тот же журнал оценки, но сценарий — не чат (оценка такого не пропустит; журнал чужой руки).
    const created = registry.live(chat.reply.taskId)!.state.created!;
    const task = await registry.create({
      ...created,
      scenario: { id: 'feature', version: 1 },
      origin: { cmdId: newId() },
    });
    const key = task.state.created!.origin!.cmdId;
    task.append({
      kind: 'grant.given',
      actor: 'core',
      cmdId: key,
      data: { cmdId: key, project: repo, globs: ['**'], ops: ['edit'] },
    });
    expect(inPlaceRootOf(task, 'u1')).toBeUndefined();
  });

  it('the chat opening is the human first message as written (request.md), not a step brief', async () => {
    const repo = gitRepo(root, 'root-opening');
    const out = await estimateTask(
      estimateBody([repo], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(repo),
        request: 'Привет, что в этом проекте?',
      }),
      registry,
      env,
    );
    if (out.status === 422) throw new Error(out.problems.join('; '));
    expect(chatOpeningOf(registry.live(out.reply.taskId)!)).toBe('Привет, что в этом проекте?');
  });
});

/**
 * Чат в папке без git (s10 G12 p7): прежний чат панели шёл в любой папке, под ядром — так же.
 * Закреплять нечего: задача без репозиториев, корень — сама папка (`folder`), и он же — место
 * работы единицы. Всё, что не чат на месте, по-прежнему требует репозиторий; папки нет — отказ с
 * её именем; репозиторий без коммита — репозиторий (база не найдена), а не «папка».
 */
describe('chat@1 in a folder without git (G12 p7: parity with the old panel chat)', () => {
  const folder = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('an in-place chat in a plain folder is created: no repositories, the folder journaled, the unit works in it', async () => {
    const dir = folder('plain-chat');
    const body = estimateBody([dir], {
      scenario: { preset: 'chat' },
      launchPolicy: 'auto',
      placement: inPlace(dir),
    });
    const out = await estimateTask(body, registry, env);
    if (out.status === 422) throw new Error(out.problems.join('; '));
    const created = journal(out.reply.taskId).find((l) => l.kind === 'task.created')!.data as {
      repos: unknown[];
      folder?: string;
      placement?: string;
    };
    expect(created.repos).toEqual([]);
    expect(created.placement).toBe('in-place');
    expect(created.folder).toBe(realpathSync.native(dir));
    // Единицу создаёт дирижёр с ключом `r1` (репозитория нет) — корень всё равно папка.
    expect(inPlaceRootOf(registry.live(out.reply.taskId)!, 'u1')).toBe(realpathSync.native(dir));
  });

  it('only the in-place chat: a chat in a copy and a feature task in a plain folder are refused as before', async () => {
    const dir = folder('plain-other');
    const before = registry.list().length;
    const copy = await estimateTask(
      estimateBody([dir], { scenario: { preset: 'chat' }, launchPolicy: 'auto' }),
      registry,
      env,
    );
    expect(copy.status === 422 && copy.problems.join('; ')).toMatch(/not a git repository/);
    const feature = await estimateTask(estimateBody([dir]), registry, env);
    expect(feature.status === 422 && feature.problems.join('; ')).toMatch(/not a git repository/);
    expect(registry.list().length).toBe(before);
    // Не чат на месте — не папка, даже если в обход оценки (создатели задач кроме неё).
    const asFeature = estimateBody([dir], { placement: inPlace(dir) }).fields;
    expect(await folderChatRoot(asFeature, env.workTreeOf)).toBeUndefined();
  });

  it('a missing folder is refused with its name and no task; a repository without a commit stays a repository', async () => {
    const before = registry.list().length;
    const gone = join(root, 'no-such-folder');
    const missing = await estimateTask(
      estimateBody([gone], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(gone),
      }),
      registry,
      env,
    );
    expect(missing.status === 422 && missing.problems).toEqual([`${gone}: no such folder`]);
    const unborn = folder('unborn');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: unborn });
    const empty = await estimateTask(
      estimateBody([unborn], {
        scenario: { preset: 'chat' },
        launchPolicy: 'auto',
        placement: inPlace(unborn),
      }),
      registry,
      env,
    );
    expect(empty.status === 422 && empty.problems.join('; ')).toMatch(
      /base default branch not found/,
    );
    expect(registry.list().length).toBe(before);
  });
});
