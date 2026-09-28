import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ConfigProvider } from '../providers/types.ts';
import { AppStore } from '../lib/app-store.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ProviderChatRunLike } from '../domains/provider-chat/ProviderChatRun.ts';
import { createChat } from '../domains/provider-chat/store.ts';
import { wireGroupActivation } from './group-activation-wiring.ts';

/**
 * Чужой CLI: выбранная группа включается на отправке службы, а не в маршруте, —
 * иначе ребёнок разделения под codex стартовал бы без правил родителя.
 * Сторона Claude проверена на маршруте разделения и в планировщике конвейера.
 */
describe('включение выбранной группы у чужого CLI', () => {
  let dir: string;
  let store: AppStore;
  let enabledAtStart: string[] | undefined;
  let service: ProviderChatService;

  const enabled = () =>
    store
      .getGroups()
      .filter((group) => group.isEnabled)
      .map((group) => group.id);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-group-wiring-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
    store.saveGroup({
      id: 'x',
      name: 'Набор X',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: false,
      order: 0,
      projectPaths: [],
    });
    store.setChatGroupSettings('parent', { groupChoice: 'global:x' });
    store.setChatLink(foreignChatKey('codex', 'child'), {
      parentChatId: 'parent',
      createdAt: '2026-09-26T00:00:00Z',
    });
    enabledAtStart = undefined;
    const run: ProviderChatRunLike = {
      start: () => {
        enabledAtStart = enabled();
        return Promise.resolve();
      },
      stop: () => undefined,
    };
    service = new ProviderChatService(() => run);
    wireGroupActivation({
      store,
      paths: {
        root: dir,
        appData: join(dir, 'agentdeck'),
        settings: join(dir, 'settings.json'),
        settingsLocal: join(dir, 'settings.local.json'),
        claudeMd: join(dir, 'CLAUDE.md'),
        secretsEnv: join(dir, 'secrets.env'),
        skills: join(dir, 'skills'),
        hooks: join(dir, 'hooks'),
        mcpConfig: join(dir, '.claude.json'),
      },
      chatRuns: { setGroupActivation: () => undefined },
      providerChats: service,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = () =>
    service.send(
      join(dir, 'agentdeck'),
      'codex',
      'child',
      { text: 'Вопрос' },
      { provider: { id: 'codex', name: 'Codex' } as ConfigProvider },
    );

  it('ребёнок с рабочим каталогом стартует с группой родителя', () => {
    createChat(join(dir, 'agentdeck'), 'codex', { id: 'child', workdir: dir });
    expect(send().ok).toBe(true);
    expect(enabledAtStart).toEqual(['x']);
  });

  it('разговор без рабочего каталога группу не трогает', () => {
    createChat(join(dir, 'agentdeck'), 'codex', { id: 'child' });
    expect(send().ok).toBe(true);
    expect(enabledAtStart).toEqual([]);
  });
});
