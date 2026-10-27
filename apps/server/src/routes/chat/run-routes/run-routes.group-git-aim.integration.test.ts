import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { deferredAsksOf } from '../deferred-routes/deferred-store.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Маршрут прав группы: git над копией (D-4, 25.10). Живой случай — карточка
 * `cd .. 2>/dev/null; git -C .. add … && rebase --continue` из `<копия>/inst-docs-ui`:
 * два подъёма, git пошёл бы в каталоге с копиями. Теперь — отказ агенту с причиной,
 * не D-n и не карточка. Настоящие маршрут, хранилище, копия git и транскрипт с
 * `cwd` оболочки; заглушен только сам CLI.
 */
describe('маршрут прав группы: git в каталоге над копией (D-4)', () => {
  let root: string;
  let copy: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  let ctx: ServerContext;
  const detaches: (() => void)[] = [];
  const GROUP = 'group-chat';

  const transcript = (): string => join(root, 'projects', 'copy-dir', `${GROUP}.jsonl`);
  const recordCall = (toolUseId: string, cwd: string): void => {
    const line = {
      type: 'assistant',
      cwd,
      sessionId: GROUP,
      message: {
        id: `msg-${toolUseId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
      },
    };
    writeFileSync(transcript(), `${JSON.stringify(line)}\n`, { flag: 'a' });
  };

  /** Ответ маршрута; придержанный карточкой вызов — `card`. */
  const ask = async (
    command: string,
    toolUseId: string,
  ): Promise<{ behavior: string; message: string }> => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: GROUP, toolName: 'Bash', input: { command }, toolUseId },
    });
    const hasCard = (): boolean =>
      events.some(
        (event) =>
          event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
      );
    let settled: { behavior: string; message: string } | undefined;
    void pending.then((res) => {
      const body = res.json<{ behavior: string; message?: string }>();
      settled = { behavior: body.behavior, message: body.message ?? '' };
    });
    const deadline = Date.now() + 15_000;
    while (!settled && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    if (settled) return settled;
    session.abort(GROUP);
    await pending;
    return { behavior: 'card', message: '' };
  };

  const norm = (text: string): string => text.replace(/\\/g, '/').toLowerCase();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-git-aim-'));
    const project = join(root, 'repo');
    copy = join(root, 'repo-worktrees', 'fix-a');
    mkdirSync(project, { recursive: true });
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    };
    git(project, ['init', '-q']);
    git(project, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(project, ['worktree', 'add', '-q', '-b', 'feature/a', copy]);
    mkdirSync(join(copy, 'inst-docs-ui', 'src'), { recursive: true });
    writeFileSync(join(copy, 'inst-docs-ui', 'src', 'app.tsx'), 'export {};\n');
    git(copy, ['add', '-A']);
    git(copy, ['commit', '-q', '-m', 'docs']);
    mkdirSync(join(root, 'projects', 'copy-dir'), { recursive: true });
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    const store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: project,
      createdAt: new Date().toISOString(),
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [{ index: 0, branch: 'feature/a', status: 'running', chatId: GROUP }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(GROUP, {
      parentChatId: 'parent',
      groupIndex: 0,
      branch: 'feature/a',
      createdAt: new Date().toISOString(),
    });
    events = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: () => new Promise(() => undefined),
      stop: () => undefined,
    }));
    session = new ChatSession(registry);
    ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    await app.ready();
    registry.start(GROUP, { prompt: 'задача группы', cwd: copy }, { projectPath: copy });
    detaches.push(
      registry.attach(GROUP, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('`cd ..` + `-C ..` из подпапки — отказ агенту: оболочка, каталог git, копия; без D-n', async () => {
    const sub = join(copy, 'inst-docs-ui');
    recordCall('toolu_d4', sub);
    const answer = await ask(
      'cd .. 2>/dev/null; git -C .. add inst-docs-ui/src/app.tsx && git -C .. rebase --continue',
      'toolu_d4',
    );
    expect(answer.behavior).toBe('deny');
    const text = norm(answer.message);
    expect(text).toMatch(/^nothing in this command ran: /);
    expect(text).toContain(`your shell is in ${norm(sub)}`);
    expect(text).toContain(`git would run in ${norm(join(root, 'repo-worktrees'))},`);
    expect(text).toContain(`contains your copy ${norm(copy)}`);
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });

  it('один подъём из подпапки и абсолютный `-C` к копии — сами, без отказа', async () => {
    const sub = join(copy, 'inst-docs-ui');
    recordCall('toolu_one', sub);
    expect(await ask('git -C .. add inst-docs-ui/src/app.tsx', 'toolu_one')).toMatchObject({
      behavior: 'allow',
    });
    recordCall('toolu_abs', sub);
    expect(await ask(`git -C "${copy}" add inst-docs-ui/src/app.tsx`, 'toolu_abs')).toMatchObject({
      behavior: 'allow',
    });
  });

  /**
   * D-6 (25.10): запрос прав пришёл раньше, чем CLI дописал запись вызова, — каталог
   * оболочки не прочитан, `-C ..` из подпапки считался от корня копии, и обычный
   * коммит своей копии ушёл человеку. Маршрут ждёт запись недолго; так и не легла —
   * отказ агенту назвать копию, не карточка.
   */
  const D6 = 'git -C .. add inst-docs-ui && git -C .. commit -qm docs; git -C .. status --short';

  it('D-6: запись вызова ложится после запроса — маршрут её дожидается, коммит сам', async () => {
    const sub = join(copy, 'inst-docs-ui');
    writeFileSync(join(sub, 'src', 'app.tsx'), 'export const a = 1;\n');
    recordCall('toolu_prev', sub);
    setTimeout(() => recordCall('toolu_d6', sub), 400);
    expect(await ask(D6, 'toolu_d6')).toMatchObject({ behavior: 'allow' });
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });

  it('D-6: запись так и не легла — отказ назвать копию, без D-n и карточки', async () => {
    recordCall('toolu_prev', join(copy, 'inst-docs-ui'));
    const answer = await ask(D6, 'toolu_never');
    expect(answer.behavior).toBe('deny');
    const text = norm(answer.message);
    expect(text).toContain("could not read your shell's directory for this call");
    expect(text).toContain(`counted from your copy root ${norm(copy)}`);
    expect(deferredAsksOf(ctx).all()).toEqual([]);
  });
});
