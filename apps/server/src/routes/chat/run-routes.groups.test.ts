import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Набор, включившийся сам, — в ленте прогона.
 *
 * Включение тут ни при чём: оно задумано и проверено в `group-activation.test.ts`.
 * Вопрос ровно один — узнает ли об этом человек: набор правит общие файлы
 * `~/.claude`, тумблера никто не трогал, и молчание панели читается как «агент
 * повёл себя странно сам по себе».
 *
 * Поверх НАСТОЯЩЕГО маршрута: заглушен только CLI, потому что заметка обязана
 * доехать по тому же потоку событий, которым идёт весь остальной прогон.
 */
describe('маршрут отправки: набор, включившийся сам', () => {
  let root: string;
  let work: string;
  let app: FastifyInstance;
  let store: AppStore;
  const CHAT = 'run-groups-notice';

  const makeGroup = (patch: Partial<Group>): Group => ({
    id: 'g1',
    name: 'Ревью фронта',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    ...patch,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-run-groups-'));
    work = join(root, 'work');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    const registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        onEvent({
          kind: 'session',
          sessionId: options.sessionId ?? 'sess',
          model: options.model ?? '',
          tools: 0,
        });
        return Promise.resolve();
      },
      stop: () => undefined,
    }));
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    // Папку вложений маршрут заводит в домашнем каталоге на каждую отправку.
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt: 'привет', projectPath: work },
    });

  it('включённый набор назван в ленте прогона', async () => {
    store.saveGroup(makeGroup({ projectPaths: [work], isEnabled: false }));

    const response = await send();

    expect(response.statusCode).toBe(200);
    expect(store.getGroups().at(0)?.isEnabled).toBe(true);
    expect(response.body).toContain('groupsActivated');
    expect(response.body).toContain('Ревью фронта');
  });

  it('ничего не включилось — и заметки нет', async () => {
    // Набор уже включён человеком: панель состояния не меняла, и говорить не о чем.
    store.saveGroup(makeGroup({ projectPaths: [work], isEnabled: true }));

    const response = await send();

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('groupsActivated');
  });
});
