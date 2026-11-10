import { BOARD_DEFAULTS, type ConfigView } from '@agentdeck/contracts/core/config';
import type { InboxSource } from '@agentdeck/contracts/core/inbox';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgeInbox } from '../../adapters/forge/index.ts';
import { createBoardPort } from '../../conductor/board/board.ts';
import { createBoardStore } from '../../conductor/board/store.ts';
import { createInboxPoller, type InboxPollerDeps } from '../../conductor/inbox/poller.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import { closeWorlds, linesOf, tasksBesides, tick, world } from './__fixtures__/answer-world.ts';

/**
 * Свой MR двумя дорогами (этап 12, W2-D, решение родителя): опрос форжа ведёт MR, который ядро
 * опубликовало (`forge-wiring`, набор `watched`), и по заметке ревьюера открывает задачу ответов.
 * Источник входящих GitLab с «мои MR с открытыми обсуждениями» читает тот же MR — и без правила
 * положил бы запись «мой MR» (пресет answer-reviewers): второй дорогой вторую задачу ответов.
 * Правило: такой «мой MR» пропускается и считается «уже ведётся». Настоящее всё: стенд ответов
 * (публикация, голый «сервер», заглушка форжа по HTTP), входящие GitLab по HTTP, хранилище доски.
 */

afterEach(closeWorlds);

function configOf(repo: string): { value: ConfigView } {
  const source: InboxSource = {
    id: 'gl',
    system: 'gitlab',
    enabled: true,
    repos: { 'acme/app': repo },
    gitlab: {
      issues: { labels: [], assignedToMe: false },
      reviewerMrs: false,
      ownMrsWithThreads: true,
    },
  } as InboxSource;
  return {
    value: {
      doc: { v: 1, inbox: { sources: [source] } },
      digest: 'd',
      issues: [],
    } as unknown as ConfigView,
  };
}

function boardAt() {
  const store = createBoardStore({ root: tempDir('own-mr-board-') });
  const port = createBoardPort({
    store,
    tasks: { states: () => ({ states: [] }) } as never,
    section: () => BOARD_DEFAULTS,
    now: () => 1_000,
    onWrite: () => undefined,
  });
  return { store, port };
}

describe('own MR: one road (W2-D)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('the same MR from the forge poll and the inbox: exactly one answer task, the inbox entry is skipped as watched', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    expect((await poller.tick()).requested).toBe(1);
    const answers = tasksBesides(w, [w.source.taskId]);
    expect(answers).toHaveLength(1);

    const mrUrl = String(linesOf(w.source, 'publish.mr')[0]!.url);
    const notes: string[] = [];
    const board = boardAt();
    const deps: InboxPollerDeps = {
      config: () => configOf(w.st.main),
      tracker: () => ({ unknown: 'no tracker in this stand' }),
      forgeInbox: () => ({
        port: createForgeInbox({
          kind: 'gitlab',
          baseUrl: w.stub.url,
          token: w.stub.tokens['publisher']!,
        }),
      }),
      board: () => board.port,
      autoQueueCmd: () => null,
      now: Date.now,
      note: (m) => notes.push(m),
      watchedMrs: () => poller.watchedMrUrls(),
    };
    const reports = await createInboxPoller(deps).poll();
    expect(reports).toEqual([
      expect.objectContaining({ id: 'gl', created: [], watched: [expect.stringMatching(/!\d+$/)] }),
    ]);
    expect(board.store.read().entries).toEqual([]);
    expect(notes.join('\n')).toContain('уже ведётся');
    expect(tasksBesides(w, [w.source.taskId])).toEqual(answers);
    // Тот же MR, тот же адрес: набор опроса называет MR задачи-источника.
    expect([...(await poller.watchedMrUrls())]).toEqual([mrUrl.replace(/\/+$/, '')]);

    // Контроль: без набора опроса тот же круг кладёт запись «мой MR» — вторую дорогу.
    const control = boardAt();
    const without = { ...deps, board: () => control.port };
    delete without.watchedMrs;
    const second = await createInboxPoller(without).poll();
    expect(second).toEqual([expect.objectContaining({ created: [expect.any(String)] })]);
    expect(control.store.read().entries).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ kind: 'forge' }) }),
    ]);
  });
});
