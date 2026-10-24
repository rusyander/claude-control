import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * L1 (ревью 23.10): одиночный чат с тумблером и ВКЛЮЧЁННЫМ правилом «История
 * git» (`gitHistory`) — удаление данных git и слияние всё равно карточкой
 * (решение владельца 23.10). Правило разрешает затирание рабочих файлов
 * (`reset --hard`, `restore`), но не снос веток, тегов, ссылок и слияние.
 *
 * НАСТОЯЩИЙ маршрут прав и НАСТОЯЩЕЕ хранилище; заглушен только процесс CLI.
 */
describe('маршрут прав одиночного чата: «История git» включена', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  const detaches: (() => void)[] = [];
  const CHAT = 'plain-chat';

  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
  });

  let asked = 0;
  /** Ответ маршрута или `'card'` — вызов придержан карточкой человеку. */
  const ask = async (command: string): Promise<string> => {
    asked += 1;
    const toolUseId = `tool-${asked}`;
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName: 'Bash', input: { command }, toolUseId },
    });
    const hasCard = (): boolean =>
      events.some(
        (event) =>
          event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
      );
    let settled = 'pending';
    void pending.then((res) => (settled = res.json<{ behavior: string }>().behavior));
    const deadline = Date.now() + 10_000;
    while (settled === 'pending' && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    if (settled !== 'pending') return settled;
    const card = hasCard();
    session.abort(CHAT);
    await pending;
    // Прогон снят вместе с карточкой — следующей команде нужен живой.
    startRun();
    return card ? 'card' : 'pending-without-card';
  };

  /** Как стартует прогон: тумблер панели или авторежим CLI без тумблера. */
  let mode: 'toggle' | 'cli-auto' = 'toggle';
  const startRun = (): void => {
    registry.start(
      CHAT,
      { prompt: 'задача', cwd: root, ...(mode === 'cli-auto' ? { permissionMode: 'auto' } : {}) },
      { projectPath: root },
    );
    detaches.push(
      registry.attach(CHAT, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
    if (mode === 'toggle') session.armAutoApprove(CHAT, { enabled: true, allowEdits: true });
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-git-ask-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.updateSettings({ autoApproveRules: { gitHistory: true, gitWrite: true } });
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
    await app.ready();
    startRun();
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('затирание рабочих файлов правило пускает само', async () => {
    expect(await ask('git reset --hard HEAD~1')).toBe('allow');
    expect(await ask('git restore src/app.ts')).toBe('allow');
    expect(await ask('git commit -m "чат"')).toBe('allow');
  });

  it.each([
    'git branch -D old',
    'git branch --delete old',
    'git branch -M renamed',
    'git tag -d v1',
    'git push origin --delete old',
    'git push origin :old',
    'git merge feat/x',
    'git stash drop',
    'git stash clear',
    'git reflog expire --all',
    'git worktree remove ../a',
    'git update-ref -d refs/heads/x',
    'git update-ref --stdin',
    'env git branch -D old',
    'bash -c "git branch -D old"',
    'git -C ../x branch -D y',
  ])('%s — карточка', async (command) => {
    expect(await ask(command)).toBe('card');
  });

  /**
   * L2: авторежим CLI без тумблера панели. До брокера доходят только вызовы,
   * задетые правилом `ask` (`CHAT_GIT_ASK`); задетое лишь шаблоном (`git log
   * --merges`) прежде вставало карточкой — тумблер выключен, — и авторежим
   * стоял там, где классификатор CLI пропустил бы сам.
   */
  describe('авторежим CLI без тумблера', () => {
    beforeEach(() => {
      for (const detach of detaches.splice(0)) detach();
      registry.stopAll();
      mode = 'cli-auto';
      startRun();
      // Тумблер панели выключен: внешний beforeEach его включал.
      session.armAutoApprove(CHAT, { enabled: false, allowEdits: true });
    });
    afterEach(() => {
      mode = 'toggle';
    });

    it.each([
      'git log --merges --oneline',
      'git merge-base HEAD origin/main',
      'git branch -a --sort=-committerdate',
    ])('%s — задето шаблоном, решено правилами чата: само', async (command) => {
      expect(await ask(command)).toBe('allow');
    });

    it.each(['git branch -D old', 'git merge feat/x', 'git push origin :old', 'git stash drop'])(
      '%s — карточка',
      async (command) => {
        expect(await ask(command)).toBe('card');
      },
    );

    it('свои правила `ask` человека в авторежиме — по-прежнему карточка', async () => {
      store.updateSettings({ autoApproveRules: { gitHistory: false, gitWrite: true } });
      expect(await ask('git reset --hard HEAD~1')).toBe('card');
    });
  });
});
