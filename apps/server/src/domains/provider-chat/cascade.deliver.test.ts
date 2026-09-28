import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REVIEW_BLOCK_LANG } from '@agentdeck/contracts/model-cascade';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import type { ChainOutcome } from '../chat/split-conveyor.ts';
import { createForeignStagePlanner, type ForeignStagePlannerDeps } from './cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from './store.ts';
import type { ProviderChatCascade } from './store.ts';
import type { ProviderChatService } from './ProviderChatService.ts';

/**
 * Звено доставки у ЧУЖОГО CLI (W3-3, открытый вопрос 4 WP9f) — зеркало Claude:
 * группа с доставкой после правок и после чистого ревью идёт в доставку, конец
 * доставки — конец цепочки, доставка раз на круг, повтор — по просьбе человека.
 * Разговоры и шапки — настоящие файлы хранилища; подменён только запуск CLI.
 */

const FIX: ProviderChatCascade = {
  stage: 'fix',
  group: 'Переименование',
  branch: 'split/rename',
  kind: 'mechanical',
  lowered: true,
  workModel: 'gpt-5.3-codex-spark',
  workEffort: 'medium',
};

const REVIEW: ProviderChatCascade = { ...FIX, stage: 'review', lowered: false };

const LINK: ChatLink = {
  parentChatId: 'codex:parent',
  title: 'Переименование',
  branch: 'split/rename',
  groupIndex: 0,
  createdAt: '2026-09-25T10:00:00.000Z',
  stage: 'fix',
};

function reviewBlock(findings: string[]): string {
  return `Посмотрел.\n\`\`\`${REVIEW_BLOCK_LANG}\n${JSON.stringify({ findings })}\n\`\`\`\n`;
}

describe('чужой CLI: звено доставки группы', () => {
  let dir: string;
  let links: Record<string, ChatLink>;
  let ended: { stage?: string; status: string }[];
  let send: ReturnType<typeof vi.fn>;
  const provider = { id: 'codex', name: 'Codex' } as ConfigProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pdeliver-'));
    links = {};
    ended = [];
    send = vi.fn().mockReturnValue({ ok: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function planner(delivers = true, sieves?: ForeignStagePlannerDeps['sieves']) {
    return createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => delivers,
      ...(sieves ? { sieves } : {}),
      onChainEnded: (link: ChatLink, outcome: ChainOutcome) =>
        void ended.push({ ...(link.stage ? { stage: link.stage } : {}), status: outcome.status }),
    });
  }

  function chat(id: string, cascade: ProviderChatCascade, stage: string): void {
    createChat(dir, 'codex', { id, title: 'Переименование', workdir: dir, cascade });
    appendMessage(dir, 'codex', id, { role: 'user', content: 'Поправь по замечаниям' });
    links[`codex:${id}`] = { ...LINK, stage };
  }

  const finish = (chatId: string, text = 'Поправил.') => ({
    providerId: 'codex',
    appDataDir: dir,
    startedAt: 0,
    chatId,
    ok: true,
    text,
  });

  /** Разговоры доставки, которые заведены и запущены. */
  const deliveries = (): string[] =>
    send.mock.calls
      .map((call) => call[2] as string)
      .filter((id) => readChatCascade(dir, 'codex', id)?.stage === 'deliver');

  it('правки группы с доставкой заводят доставку на модели работы', () => {
    chat('fix', FIX, 'fix');

    planner()(finish('fix'));

    const [id] = deliveries();
    expect(id).toBeDefined();
    const created = readChat(dir, 'codex', id ?? '');
    expect(created?.title).toBe('Переименование · доставка');
    expect(created?.model).toBe('gpt-5.3-codex-spark');
    const prompt = (send.mock.calls[0]?.[3] as { text: string }).text;
    expect(prompt).toContain('git push --force-with-lease origin split/rename');
    // У чужого CLI нет инструмента вопросов — задание его и не называет.
    expect(prompt).not.toContain('AskUserQuestion');
    expect(links[`codex:${id}`]).toMatchObject({ stage: 'deliver', parentChatId: 'codex:parent' });
    expect(readChatCascade(dir, 'codex', 'fix')?.deliveredAt).toBeTruthy();
    // Цепочка не кончилась на правках: итог скажет конец доставки.
    expect(ended).toEqual([]);
  });

  it('чистое ревью группы с доставкой тоже заводит доставку', () => {
    chat('review', REVIEW, 'review');

    planner()(finish('review', reviewBlock([])));

    expect(deliveries()).toHaveLength(1);
    expect(ended).toEqual([]);
  });

  // M8: работа настройкой CLI ревью не получает — группа с доставкой идёт в доставку.
  it('работа без понижения у группы с доставкой заводит доставку, без ревью', () => {
    chat('work', { ...FIX, stage: 'work', lowered: false }, 'work');

    planner()(finish('work', 'Сделал.'));

    const [id] = deliveries();
    expect(id).toBeDefined();
    const prompt = (send.mock.calls[0]?.[3] as { text: string }).text;
    expect(prompt).toContain('it has no separate review');
    expect(readChatCascade(dir, 'codex', 'work')?.deliveredAt).toBeTruthy();
    expect(ended).toEqual([]);
  });

  it('работа без понижения у группы без доставки кончается, как раньше', () => {
    chat('work', { ...FIX, stage: 'work', lowered: false }, 'work');

    planner(false)(finish('work', 'Сделал.'));

    expect(deliveries()).toEqual([]);
    expect(ended).toEqual([{ stage: 'work', status: 'done' }]);
  });

  it('правки по ревью группы с доставкой знают, что доставка идёт следом', () => {
    chat('review', REVIEW, 'review');

    planner()(finish('review', reviewBlock(['поправь a.ts:1'])));

    const prompt = (send.mock.calls[0]?.[3] as { text: string }).text;
    expect(prompt).toContain('commit, push and MR are not forbidden by it');
  });

  it('конец доставки — конец цепочки: итог уходит конвейеру, звеньев больше нет', () => {
    chat('deliver', { ...FIX, stage: 'deliver' }, 'deliver');

    planner()(finish('deliver', `MR: https://git/x/-/merge_requests/9\n${reviewBlock(['ещё'])}`));

    expect(send).not.toHaveBeenCalled();
    expect(ended).toEqual([{ stage: 'deliver', status: 'done' }]);
  });

  it('доставка раз на круг: второй конец правок её не заводит, просьба человека — заводит', () => {
    chat('fix', FIX, 'fix');
    const plan = planner();

    plan(finish('fix'));
    appendMessage(dir, 'codex', 'fix', { role: 'user', content: 'А тесты прошли?' });
    plan(finish('fix', 'Прошли.'));
    expect(deliveries()).toHaveLength(1);
    expect(ended).toEqual([{ stage: 'fix', status: 'done' }]);

    appendMessage(dir, 'codex', 'fix', { role: 'user', content: 'Доставь ещё раз' });
    plan(finish('fix', 'Хорошо.'));
    expect(deliveries()).toHaveLength(2);
  });

  it('группа без доставки после правок кончается, как раньше', () => {
    chat('fix', FIX, 'fix');

    planner(false)(finish('fix'));

    expect(send).not.toHaveBeenCalled();
    expect(ended).toEqual([{ stage: 'fix', status: 'done' }]);
  });

  // Сита перед MR (решение владельца 28.09) — тем же абзацем, что у Claude.
  it('доставка получает абзац сит; строки правок и прежних звеньев едут в её связь', async () => {
    chat('fix', FIX, 'fix');
    links['codex:fix'] = {
      ...LINK,
      sieveRows: [{ id: 'merge-tree', status: 'pass', evidence: 'git merge-tree → clean' }],
    };
    const asked: { cwd: string; stage: string; done: string[] }[] = [];
    const text = [
      'Поправил.',
      '```agentdeck:sieves',
      '{"sieves":[{"id":"consumers-repo-wide","status":"pass","evidence":"git grep oldName → 0 hits"}]}',
      '```',
    ].join('\n');

    const planned = planner(true, async (cwd, _link, stage, done) => {
      asked.push({ cwd, stage, done: done.map((row) => row.id) });
      return 'SIEVES-PARAGRAPH';
    })(finish('fix', text));
    // Абзац читается асинхронно (git не держит сервер): до него звено не стартует.
    expect(send).not.toHaveBeenCalled();
    await planned;

    const [id] = deliveries();
    const prompt = (send.mock.calls[0]?.[3] as { text: string }).text;
    expect(prompt).toContain('SIEVES-PARAGRAPH');
    expect(asked).toEqual([
      { cwd: dir, stage: 'deliver', done: ['merge-tree', 'consumers-repo-wide'] },
    ]);
    expect(links[`codex:${id}`]?.sieveRows?.map((row) => row.id)).toEqual([
      'merge-tree',
      'consumers-repo-wide',
    ]);
  });

  // Ревью сит, 28.09: без доставки отчёт сит никто не судит — абзац обещал бы ложь.
  it('без доставки абзаца сит нет: его отчёт никто не проверил бы', () => {
    // Работа на пониженной модели заводит ревью — звено, которому сита положены.
    chat('work', { ...FIX, stage: 'work' }, 'work');
    links['codex:work'] = { ...LINK, stage: 'work' };
    const asked: string[] = [];
    planner(false, async (_cwd, _link, stage) => {
      asked.push(stage);
      return 'SIEVES-PARAGRAPH';
    })(finish('work', 'Сделал.'));

    expect(send).toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(JSON.stringify(send.mock.calls)).not.toContain('SIEVES-PARAGRAPH');
  });
});
