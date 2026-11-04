import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunNotice } from '../../domains/notify/run-notice.types.ts';
import { writeToken } from '../../domains/integrations/store/store.ts';
import { TURN_SETTLE_MS } from '../../domains/notify/telegram.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Карточка конца хода в Telegram — через сборку панели (`createRuntime`), а не
 * через отправителя в одиночку. Отправитель судит ход по двум справкам, которые
 * ему подаёт только сборка: «чат снова работает» (`busy` — реестр прогонов своего
 * CLI или сервис чужого по ключу `провайдер:чат`) и «чат — звено группы»
 * (`subtask` — связь с родителем в хранилище). Тест отправителя подставляет их
 * сам и потому не видит, что сборка их не подала или подала не те.
 *
 * Настоящие здесь: хранилище, настройки, токен в зашифрованном хранилище,
 * реестр, сервис чужих чатов, отправитель и его 20 секунд ожидания. Подменены
 * только сеть (`fetch`) и часы ожидания (поддельный `setTimeout`).
 */

const CLOSED = 'Задача закрыта. Вход снова работает: токен обновляется сам, тесты зелёные.';

describe('сборка панели: конец хода в Telegram судится по занятости и звену группы', () => {
  let root: string;
  let store: AppStore;
  let runtime: Runtime;
  let sent: string[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-tg-turn-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    store = new AppStore(appData);
    const integrations = store.getSettings().integrations;
    store.updateSettings({
      integrations: {
        ...integrations,
        telegram: { enabled: true, chatId: '42', events: ['runError'], doneAfterMinutes: 5 },
      },
    });
    writeToken(appData, 'telegram', '123456:test-token');
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    sent = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/sendMessage')) {
        sent.push(String((JSON.parse(String(init.body)) as { text: string }).text));
      }
      return Promise.resolve(
        new Response('{"ok":true,"result":{"message_id":7}}', { status: 200 }),
      );
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  /**
   * Конец хода — тем путём, каким его сообщает реестр (`setNotifier` сборки),
   * затем 20 с ожидания на поддельных часах. Сколько карточек ушло.
   */
  async function endTurn(chatId: string): Promise<string[]> {
    const notify = (runtime.chatRuns as unknown as { notify: (notice: RunNotice) => void }).notify;
    const before = sent.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    notify({
      kind: 'done',
      chatId,
      projectPath: join(root, 'shop'),
      durationMs: 12 * 60_000,
      answer: CLOSED,
      turnKey: chatId,
    });
    // До срока отправитель молчит: суд — после паузы, а не в миг конца хода.
    vi.advanceTimersByTime(TURN_SETTLE_MS - 1);
    expect(sent.length).toBe(before);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return sent.slice(before);
  }

  it('свободный чат своего CLI — карточка «Задача закрыта» (контроль: путь до Telegram цел)', async () => {
    const cards = await endTurn('run-free');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('✅ Задача закрыта');
  });

  it('чат своего CLI снова занят — тишина: справка взята у реестра прогонов', async () => {
    runtime.chatRuns.isRunning = (chatId: string) => chatId === 'run-busy';
    expect(await endTurn('run-busy')).toEqual([]);
    // Тот же реестр о другом чате говорит «свободен» — и карточка уходит.
    expect(await endTurn('run-other')).toHaveLength(1);
  });

  it('звено группы (связь с родителем) — тишина: итог скажет группа', async () => {
    store.setChatLink('run-child', {
      parentChatId: 'parent-1',
      groupIndex: 0,
      branch: 'feature/g1',
      stage: 'work',
      createdAt: '2026-10-30T00:00:00.000Z',
    });
    expect(await endTurn('run-child')).toEqual([]);
    expect(await endTurn('run-top')).toHaveLength(1);
  });
});
