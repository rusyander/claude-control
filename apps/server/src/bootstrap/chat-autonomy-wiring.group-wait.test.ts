import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunLike,
} from '../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../domains/chat/ChatRunner/ChatRunner.ts';
import { WAIT_RESUME_MAX } from '../domains/chat/group-questions/group-wait.ts';
import { RBAC_WAIT_TEXT } from '../domains/chat/group-questions/group-wait.fixture.ts';
import { removeWhenFree } from '../lib/remove-when-free.ts';
import { wireChatAutonomy, type ChatAutonomyWiring } from './chat-autonomy-wiring.ts';

/**
 * F-87: счёт продолжений группы «по плану» переживает перезапуск панели. Две
 * НАСТОЯЩИЕ сборки (`wireChatAutonomy` + реестр прогонов) над двумя экземплярами
 * хранилища на одном каталоге — как панель до и после перезапуска. Подменён
 * только процесс CLI: ход кончается сразу. В памяти перезапуск обнулял счёт, и
 * упорно ждущая модель получала новые `WAIT_RESUME_MAX` продолжений после
 * каждого git pull или сторожа.
 */

const PARENT = 'родитель-счёт';
const CHILD = 'чат-группы-счёт';
const SESSION = 'sess-count';

describe('сборка: счёт продолжений группы «по плану» — в state.json, не в памяти (F-87)', () => {
  let root: string;
  let appData: string;
  let started: RunOptions[];

  /** Панель с нуля над тем же каталогом: новое хранилище, новый реестр, новая сборка. */
  function boot(): { store: AppStore; wiring: ChatAutonomyWiring } {
    const store = new AppStore(appData);
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push(options);
      },
      stop: () => undefined,
    }));
    const wiring = wireChatAutonomy({
      store,
      chatRuns: registry,
      say: (chatId, event) => registry.emitExternal(chatId, event),
      broadcast: () => undefined,
    });
    // Как в `runtime.ts`: каждый старт реестра — в сборку (свой старт счёт не снимает).
    registry.setStartListener((keys) => wiring.started(keys));
    return { store, wiring };
  }

  const finished = (): RunFinished => ({
    chatId: CHILD,
    sessionId: SESSION,
    text: RBAC_WAIT_TEXT,
    ok: true,
    startedAt: Date.now(),
    options: { prompt: 'Работай по плану' } as RunOptions,
    contextTokens: 0,
  });

  /** Конец хода — и пауза, пока продолжение (отложенный старт) не заведено. */
  async function end(wiring: ChatAutonomyWiring): Promise<boolean> {
    const resumed = wiring.resumeWaiting(finished());
    await new Promise((done) => setTimeout(done, 30));
    return resumed;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-wait-count-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    started = [];
    const store = new AppStore(appData);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: root,
      createdAt: new Date().toISOString(),
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [{ index: 0, branch: 'feat/count', status: 'running', chatId: CHILD }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(CHILD, {
      parentChatId: PARENT,
      groupIndex: 0,
      branch: 'feat/count',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await removeWhenFree(root);
  });

  it('предел выбран до перезапуска — после него панель не продолжает снова', async () => {
    const before = boot();
    for (let turn = 1; turn <= WAIT_RESUME_MAX; turn += 1) {
      expect(await end(before.wiring)).toBe(true);
    }
    expect(await end(before.wiring)).toBe(false);
    expect(started).toHaveLength(WAIT_RESUME_MAX);

    const after = boot();
    expect(after.store.getGroupWaitResume(SESSION)).toMatchObject({
      count: WAIT_RESUME_MAX,
      parentChatId: PARENT,
      groupIndex: 0,
    });
    expect(await end(after.wiring)).toBe(false);
    expect(started).toHaveLength(WAIT_RESUME_MAX);
  });

  it('счёт посреди петли: после перезапуска — продолжение со следующим номером, не с первым', async () => {
    const before = boot();
    expect(await end(before.wiring)).toBe(true);

    const after = boot();
    expect(await end(after.wiring)).toBe(true);
    // Второе продолжение называет решения поимённо — первое так не пишет.
    expect(started.at(-1)?.prompt).toContain('ended waiting for an answer again');
    expect(after.store.getGroupWaitResume(SESSION)?.count).toBe(2);
  });

  it('слово человека снимает счёт и на диске: следующее ожидание — снова продолжение', async () => {
    const before = boot();
    for (let turn = 1; turn <= WAIT_RESUME_MAX; turn += 1) await end(before.wiring);
    before.wiring.started([CHILD, SESSION]);

    const after = boot();
    expect(after.store.getGroupWaitResume(SESSION)).toBeUndefined();
    expect(await end(after.wiring)).toBe(true);
  });
});
