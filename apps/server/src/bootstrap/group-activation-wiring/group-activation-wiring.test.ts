import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ConfigProvider } from '../../providers/types/types.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import type { ProviderChatRunLike } from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { createChat, readChat } from '../../domains/provider-chat/store/store.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { getProvider } from '../../providers/registry.ts';
import { wireGroupActivation } from './group-activation-wiring.ts';

/**
 * Чужой CLI: выбранная группа родителя НЕ включается тумблером Claude — CLI
 * файлов Claude не читает, а `~/.claude` человека менялся бы зря (X2). У CLI
 * без слоя (goose) в ленте одна заметка «группа не действует», у Codex группа
 * едет его накладкой на прогон — и тоже без записи в Claude.
 */
describe('группа Claude у чужого CLI без слоя', () => {
  let dir: string;
  let store: AppStore;
  let enabledAtStart: string[] | undefined;
  let service: ProviderChatService;
  const appData = () => join(dir, 'agentdeck');

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
    for (const cli of ['codex', 'goose']) {
      store.setChatLink(foreignChatKey(cli, 'child'), {
        parentChatId: 'parent',
        createdAt: '2026-09-26T00:00:00Z',
      });
    }
    enabledAtStart = undefined;
    // Прогон отвечает сразу: следующее сообщение в тот же разговор принимается.
    const run: ProviderChatRunLike = {
      start: (_options, emit) => {
        enabledAtStart = enabled();
        emit({ type: 'done', reply: 'ok', transport: 'stream' });
        return Promise.resolve();
      },
      stop: () => undefined,
    };
    service = new ProviderChatService(() => run);
    wireGroupActivation({
      store,
      paths: {
        root: dir,
        appData: appData(),
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

  const send = (cli: string) =>
    service.send(
      appData(),
      cli,
      'child',
      { text: 'Вопрос' },
      { provider: { id: cli, name: cli } as ConfigProvider },
    );
  const notices = (cli: string) =>
    (readChat(appData(), cli, 'child')?.messages ?? [])
      .filter((item) => item.role === 'notice')
      .map((item) => item.content);

  it('codex: группа едет накладкой, в Claude не включается, заметка без «не действует»', () => {
    createChat(appData(), 'codex', { id: 'child', workdir: dir });
    expect(send('codex').ok).toBe(true);
    expect(enabledAtStart).toEqual([]);
    expect(store.getGroups().find((group) => group.id === 'x')?.isEnabled).toBe(false);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    const said = notices('codex');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('«Набор X»');
    expect(said[0]).not.toContain(
      serverText('group-layer-none', { cli: getProvider('codex').name }),
    );
  });

  it.each(['goose'])(
    '%s: группа родителя не включается в Claude, в ленте — заметка «не действует»',
    (cli) => {
      createChat(appData(), cli, { id: 'child', workdir: dir });
      expect(send(cli).ok).toBe(true);
      expect(enabledAtStart).toEqual([]);
      expect(store.getGroups().find((group) => group.id === 'x')?.isEnabled).toBe(false);
      // Ни одного файла Claude: тумблер писал бы settings.json и каталоги.
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
      const said = notices(cli);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('«Набор X»');
      expect(said[0]).toContain(serverText('group-layer-none', { cli: getProvider(cli).name }));
    },
  );

  it('та же группа на втором сообщении заметку не повторяет', () => {
    createChat(appData(), 'goose', { id: 'child', workdir: dir });
    expect(send('goose').ok).toBe(true);
    expect(send('goose').ok).toBe(true);
    expect(notices('goose')).toHaveLength(1);
  });

  it('группа, привязанная к проекту, тоже даёт заметку и тоже без записи в Claude', () => {
    store.setChatGroupSettings('parent', { groupChoice: 'auto' });
    store.saveGroup({ ...store.getGroups()[0]!, projectPaths: [dir] });
    createChat(appData(), 'goose', { id: 'child', workdir: dir });
    expect(send('goose').ok).toBe(true);
    expect(enabledAtStart).toEqual([]);
    expect(notices('goose')[0]).toContain('«Набор X»');
  });

  it('разговор без рабочего каталога группу не трогает и молчит', () => {
    createChat(appData(), 'codex', { id: 'child' });
    expect(send('codex').ok).toBe(true);
    expect(enabledAtStart).toEqual([]);
    expect(notices('codex')).toEqual([]);
  });
});

/**
 * Qwen каталогов Claude не читает: тумблер группы Claude ему ничего не дал бы.
 * Группа едет слоем на прогон — файлом системных настроек в окружении, а
 * каталоги Claude остаются как были.
 */
describe('группа Claude у Qwen — слоем на прогон', () => {
  let dir: string;
  let store: AppStore;
  let envAtStart: Record<string, string> | undefined;
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-group-wiring-qwen-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    mkdirSync(join(dir, 'skills', 'ladder'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: Review rounds\n---\n\nTwo rounds.\n',
    );
    store = new AppStore(join(dir, 'agentdeck'));
    store.saveGroup({
      id: 'x',
      name: 'Набор X',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ladder' }],
      env: {},
      isEnabled: false,
      order: 0,
      projectPaths: [],
    });
    store.setChatGroupSettings('parent', { groupChoice: 'global:x' });
    store.setChatLink(foreignChatKey('qwen', 'child'), {
      parentChatId: 'parent',
      createdAt: '2026-10-06T00:00:00Z',
    });
    envAtStart = undefined;
    const run: ProviderChatRunLike = {
      start: (options) => {
        envAtStart = options.platformEnv;
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

  it('ребёнок Qwen получает слой группы родителя, группа Claude не включается', () => {
    createChat(join(dir, 'agentdeck'), 'qwen', { id: 'child', workdir: dir });
    const sent = service.send(
      join(dir, 'agentdeck'),
      'qwen',
      'child',
      { text: 'Вопрос' },
      { provider: { id: 'qwen', name: 'Qwen Code' } as ConfigProvider },
    );
    expect(sent.ok).toBe(true);
    const settings = envAtStart?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(settings && existsSync(settings)).toBe(true);
    // Скилл — нативно, корнем `skills.directories` (P5), а не перечнем в QWEN.md.
    const layer = dirname(settings!);
    const written = JSON.parse(readFileSync(settings!, 'utf8')) as {
      skills?: { directories?: string[] };
    };
    expect(written.skills?.directories).toEqual([join(layer, 'skills')]);
    expect(readFileSync(join(layer, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain(
      'Two rounds.',
    );
    expect(store.getGroups().find((group) => group.id === 'x')?.isEnabled).toBe(false);
  });
});
