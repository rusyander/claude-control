import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import { AppStore } from '../../lib/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { registerSplitControlRoutes } from './split-control-routes.ts';

/**
 * Разрешения группы разделения поверх НАСТОЯЩЕГО маршрута прав и НАСТОЯЩЕГО
 * хранилища: запрос от прогона группы решается строками вкладки «Группы»
 * (общие + своё у проекта), а прогон обычного чата — по-прежнему тумблером.
 * Заглушен только процесс CLI — внешняя граница, которой у теста быть не может.
 */
describe('маршрут прав: строки вкладки «Группы»', () => {
  let root: string;
  let project: string;
  let copy: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  const detaches: (() => void)[] = [];
  const GROUP = 'group-chat';
  const PLAIN = 'plain-chat';

  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
  });

  const startRun = (chatId: string): void => {
    registry.start(chatId, { prompt: 'задача группы', cwd: copy }, { projectPath: copy });
    detaches.push(
      registry.attach(chatId, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  };

  /**
   * Ответ маршрута или `'card'` — вызов придержан карточкой человеку. Ждать
   * ответа на придержанный запрос нельзя: он и не придёт до клика.
   */
  let asked = 0;
  const ask = async (chatId: string, command: string, toolName = 'Bash'): Promise<string> => {
    asked += 1;
    const toolUseId = `tool-${asked}`;
    const input = toolName === 'Bash' ? { command } : { file_path: command };
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: chatId, toolName, input, toolUseId },
    });
    const settled = await Promise.race([
      pending.then((res) => res.json<{ behavior: string }>().behavior),
      new Promise<string>((done) => setTimeout(() => done('pending'), 300)),
    ]);
    if (settled !== 'pending') return settled;
    const card = events.find(
      (event) =>
        event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
    );
    session.abort(chatId);
    await pending;
    return card ? 'card' : 'pending-without-card';
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-perms-'));
    project = join(root, 'repo');
    copy = join(root, 'repo-group');
    mkdirSync(project, { recursive: true });
    mkdirSync(copy, { recursive: true });
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
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
    registry = new ChatRunRegistry(liveRun);
    session = new ChatSession(registry);
    const ctx = {
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
    // Маршрут «убрать отметки» — тот же, что зовёт хаб; конвейер ему не нужен.
    registerSplitControlRoutes(app, ctx, {} as Parameters<typeof registerSplitControlRoutes>[2]);
    await app.ready();
    startRun(GROUP);
    startRun(PLAIN);
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('группа из коробки коммитит и убирает сама, базу сносить — спрашивает', async () => {
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
    expect(await ask(GROUP, 'rm -rf dist')).toBe('allow');
    expect(await ask(GROUP, 'pnpm build')).toBe('allow');
    expect(await ask(GROUP, 'psql -c "drop table users"')).toBe('card');
  });

  it('обычный чат без тумблера — как раньше: коммит карточкой', async () => {
    expect(await ask(PLAIN, 'git commit -m "чат"')).toBe('card');
  });

  it('строка проекта сильнее общей; общая действует там, где проект не трогал', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('card');

    store.setSplitDefaults({
      ...structuredClone(SPLIT_DEFAULTS_BUILTIN),
      permissions: { ...SPLIT_DEFAULTS_BUILTIN.permissions, filesDelete: false, routine: false },
    });
    expect(await ask(GROUP, 'rm -rf dist')).toBe('card');
    expect(await ask(GROUP, 'pnpm build')).toBe('card');

    store.setSplitSettings(project, { deliver: true, permissions: null });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
  });

  it('связь без группы в записи разделения (звено каскада) — не группа', async () => {
    store.setChatLink(PLAIN, {
      parentChatId: 'parent',
      groupIndex: 5,
      branch: 'feature/other',
      createdAt: new Date().toISOString(),
    });
    expect(await ask(PLAIN, 'git commit -m "каскад"')).toBe('card');
  });

  it('разделение без права правок — группа правит файлы только с карточкой', async () => {
    expect(await ask(GROUP, 'a.txt', 'Edit')).toBe('allow');
    const plan = store.getSplitPlan('parent') as SplitPlanRecord;
    store.setSplitPlan({ ...plan, request: { allowEdits: false } });
    expect(await ask(GROUP, 'a.txt', 'Edit')).toBe('card');
  });

  it('тумблер, включённый человеком в чате группы, сильнее строк группы', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    session.armAutoApprove(GROUP, { enabled: true, allowEdits: true });
    expect(await ask(GROUP, 'git commit -m "человек"')).toBe('allow');
  });

  /**
   * Итоговое ревью 25.09 (M3): группа наследует тумблер родителя, и раньше
   * любой унаследованный тумблер — даже выключенный — отключал строки группы:
   * коммит вставал на карточке, которую никто не смотрит, а при включённом у
   * родителя выключенные строки молча игнорировались.
   */
  it('унаследованный от родителя выключенный тумблер строкам не мешает', async () => {
    session.armAutoApprove('parent', { enabled: false, allowEdits: true });
    session.inherit(['parent'], GROUP, true);
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
  });

  it('унаследованный включённый тумблер не отменяет выключенную строку', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    session.armAutoApprove('parent', { enabled: true, allowEdits: true });
    session.inherit(['parent'], GROUP, true);
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('card');
  });

  it('ответ человека из хаба (тумблер выключен) строки группы не отключает', async () => {
    session.armAutoApprove(GROUP, { enabled: false, allowEdits: true });
    expect(await ask(GROUP, 'git commit -m "после ответа"')).toBe('allow');
  });

  /**
   * Аудит 25.09, L163: пуш с перезаписью истории у группы — только карточкой,
   * кроме пуша арендой СВОЕЙ ветки после rebase (решение владельца): без него
   * группа, догнавшая основную ветку, вставала бы у самого MR.
   */
  it('затирание истории — карточка; аренда своей ветки — сама, чужой — карточка', async () => {
    expect(await ask(GROUP, 'git push --force origin feature/a')).toBe('card');
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin main')).toBe('card');
    expect(
      await ask(GROUP, 'git push --force-with-lease origin feature/a && git push -f origin main'),
    ).toBe('card');
    // Пуш у человека — и аренда своей ветки тоже.
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: 'human' } });
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('card');
  });

  /** Аудит 25.09, L20: «с отметкой» — прошло само, но хаб родителя это видит. */
  it('строка «с отметкой» разрешает и пишет отметку, хаб её убирает', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: 'notify' } });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
    expect(await ask(GROUP, 'pnpm build')).toBe('allow');
    const notices = (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices;
    expect(notices?.map((notice) => notice.summary)).toEqual(['git commit -m "группа"']);

    const dismissed = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent/auto-notices/dismiss',
      payload: { index: 0 },
    });
    expect(dismissed.json()).toEqual({ index: 0, dismissed: 1 });
    expect(
      (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices,
    ).toBeUndefined();

    const missing = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent/auto-notices/dismiss',
      payload: { index: 7 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ messageCode: 'split-group-not-found' });
  });

  it('строка «человек» — карточка и без отметки', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { routine: 'human' } });
    expect(await ask(GROUP, 'pnpm build')).toBe('card');
    expect(
      (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices,
    ).toBeUndefined();
  });
});
