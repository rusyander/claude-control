import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import { SplitReview } from '../../domains/chat/split-review/split-review.ts';
import { COLD_RESUME_INTRO } from '../../domains/chat/split-continue.ts';
import { TASK_NOTEBOOK } from '../../domains/chat/task-notebook/task-notebook.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { createReviewStarter } from './review-starter.ts';

/**
 * Холодное продолжение звена ревью (находка F-01 ревью П1): человек часами у
 * карточки, сессия ревью остыла — «отписать» идёт НОВЫМ разговором. Раньше
 * холодная ветка запуска брала только общую вводную и теряла задание звена:
 * новая сессия публикации не знала ни MR, ни что в нём проверять. Путь —
 * настоящий: решение `SplitReview` → `createReviewStarter` → реестр прогонов;
 * подменён только сам процесс CLI.
 */
describe('холодное продолжение звена ревью несёт его задание', () => {
  let root: string;
  let copy: string;
  let store: AppStore;
  let started: { prompt: string; sessionId?: string }[];
  let review: SplitReview;

  const TASK = 'Review MR 42: TASK-MARKER check the login flow and the token refresh.';
  const URL = 'https://gitlab.com/team/app/-/merge_requests/42';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cold-review-'));
    copy = mkdtempSync(join(tmpdir(), 'cc-cold-copy-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          prompt: options.prompt,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        });
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    review = new SplitReview({
      store: {
        all: () => store.getChatLinks(),
        set: (chatId, link) => store.setChatLink(chatId, link),
        remove: (chatId) => store.clearChatLink(chatId),
      },
      start: createReviewStarter(ctx, {
        runs: registry,
        providerChats: new ProviderChatService(),
        session: new ChatSession(registry),
        log: { warn: () => undefined },
      }),
      publishInSession: true,
      log: () => undefined,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  });

  /** Транскрипт сессии ревью: база 40k, последний вызов `last`, простой `idleMs`. */
  function transcript(id: string, last: number, idleMs: number): void {
    const dir = join(root, 'projects', 'C--copy');
    mkdirSync(dir, { recursive: true });
    const call = (context: number, text: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text }],
          usage: {
            input_tokens: 0,
            output_tokens: 10,
            cache_read_input_tokens: context,
            cache_creation_input_tokens: 0,
          },
        },
      });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${call(40_000, 'Начал.')}\n${call(last, 'Два замечания.')}\n`, 'utf8');
    const at = (Date.now() - idleMs) / 1000;
    utimesSync(file, at, at);
  }

  function waitingReview(): ChatLink {
    return {
      parentChatId: 'parent',
      title: 'MR 42',
      branch: 'feature/login',
      createdAt: '2026-10-21T10:00:00.000Z',
      stage: 'review',
      task: TASK,
      review: {
        url: URL,
        branch: 'feature/login',
        path: copy,
        findings: ['src/a.ts:10 — забыт await'],
      },
    };
  }

  it('остывшая сессия: «отписать» — новый разговор с заданием звена и вводной панели', async () => {
    store.setChatLink('sess-review', waitingReview());
    transcript('sess-review', 120_000, 2 * 60 * 60_000);
    // F-06: блокнот, который панель велит группе вести, едет в вводную.
    mkdirSync(join(copy, '.agent', 'run'), { recursive: true });
    writeFileSync(join(copy, TASK_NOTEBOOK), 'NOTEBOOK-MARKER: решение стадии\n');

    await review.decide({ chatId: 'sess-review', decision: 'post' });

    const run = started.at(-1)!;
    expect(run.sessionId).toBeUndefined();
    expect(run.prompt.startsWith(COLD_RESUME_INTRO)).toBe(true);
    expect(run.prompt).toContain('TASK-MARKER');
    expect(run.prompt).toContain(`## Notebook ${TASK_NOTEBOOK}\nNOTEBOOK-MARKER`);
    // Вводная остывшего — не «транскрипт удалён»: он на месте, его путь в фактах.
    expect(run.prompt).not.toContain('deleted outside the panel');
  });

  it('потерянный транскрипт — прежняя вводная «потерян» с тем же заданием', async () => {
    store.setChatLink('sess-gone', waitingReview());

    await review.decide({ chatId: 'sess-gone', decision: 'post' });

    const run = started.at(-1)!;
    expect(run.sessionId).toBeUndefined();
    expect(run.prompt).toContain('deleted outside the panel');
    expect(run.prompt).toContain('TASK-MARKER');
  });

  it('тёплая сессия продолжается как есть — без вводной', async () => {
    store.setChatLink('sess-warm', waitingReview());
    transcript('sess-warm', 120_000, 10 * 60_000);

    await review.decide({ chatId: 'sess-warm', decision: 'post' });

    const run = started.at(-1)!;
    expect(run.sessionId).toBe('sess-warm');
    expect(run.prompt).not.toContain('TASK-MARKER');
  });
});
