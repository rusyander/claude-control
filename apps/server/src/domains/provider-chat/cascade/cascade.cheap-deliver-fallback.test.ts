import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { getProvider } from '../../../providers/registry.ts';
import { createForeignStagePlanner, type ForeignStagePlannerDeps } from './cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';
import type { TreeStartGate } from '../../chat/tree-pause/tree-pause.ts';

/**
 * Откат дешёвой доставки (C2): аккаунт или маршрут отверг младшую ступень —
 * доставка заново на модели работы. Провайдер — настоящая запись каталога,
 * разговоры и связи — настоящие файлы хранилища, планировщик — настоящий;
 * подменён только запуск CLI. Тексты отказа — НАСТОЯЩИЕ ответы codex-cli
 * 0.155.1 через `ProviderChatRun` (заглушка модели отвечала 404 / 400).
 */

/** codex 0.155.1, ключ API: модель не существует или нет доступа (404 model_not_found). */
const REFUSED_404 =
  'unexpected status 404 Not Found: The model `gpt-5.3-codex-spark` does not exist or you do ' +
  'not have access to it., url: http://127.0.0.1:50473/v1/responses';
/** codex 0.155.1, вход аккаунтом ChatGPT: модель не входит в подписку (400). */
const REFUSED_CHATGPT =
  '{"detail":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}';

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.3-codex',
    name: 'codex',
    family: 'gpt-codex',
    vendor: 'openai',
    releaseDate: '2026-02',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'spark',
    family: 'gpt-codex-spark',
    vendor: 'openai',
    releaseDate: '2026-02',
  },
];

const FIX: ProviderChatCascade = {
  stage: 'fix',
  group: 'Переименование',
  branch: 'split/rename',
  kind: 'implementation',
  lowered: true,
  workModel: 'gpt-5.3-codex',
  workEffort: 'xhigh',
};

const LINK: ChatLink = {
  parentChatId: 'p:parent',
  title: 'Переименование',
  branch: 'split/rename',
  groupIndex: 0,
  createdAt: '2026-10-22T10:00:00.000Z',
  stage: 'fix',
};

describe('cascade cheap deliver fallback', () => {
  let dir: string;
  let links: Record<string, ChatLink>;
  let send: ReturnType<typeof vi.fn>;
  let ended: Mock<NonNullable<ForeignStagePlannerDeps['onChainEnded']>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pcheap-fb-'));
    links = {};
    ended = vi.fn();
    // Как настоящая служба: реплика задания ложится в разговор перед ходом.
    send = vi.fn(
      (appDataDir: string, providerId: string, chatId: string, input: { text: string }) => {
        appendMessage(appDataDir, providerId, chatId, { role: 'user', content: input.text });
        return { ok: true };
      },
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function planner(extra: Partial<ForeignStagePlannerDeps> = {}) {
    const deps: ForeignStagePlannerDeps = {
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? getProvider(id) : undefined),
      models: () => MODELS,
      settings: () => ({
        taskSplitInitiative: false,
        handoffInitiative: false,
        groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, sonnetDeliver: true },
      }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => true,
      sonnetDeliverOf: () => undefined,
      contourRoute: () => ({ routed: false }),
      onChainEnded: ended,
      ...extra,
    };
    return createForeignStagePlanner(deps);
  }

  const finish = (chatId: string, over: { ok?: boolean; error?: string } = {}) => ({
    providerId: 'codex',
    appDataDir: dir,
    startedAt: 0,
    chatId,
    ok: over.ok ?? true,
    text: over.ok === false ? '' : 'Поправил.',
    ...(over.error ? { error: over.error } : {}),
  });

  /** Правки закончились — заведена доставка на младшей ступени; её id. */
  async function cheapDelivery(cascade: ProviderChatCascade = FIX): Promise<string> {
    createChat(dir, 'codex', { id: 'fix', title: 'Переименование', workdir: dir, cascade });
    appendMessage(dir, 'codex', 'fix', { role: 'user', content: 'Поправь по замечаниям' });
    links['codex:fix'] = { ...LINK };
    await planner()(finish('fix'));
    const id = send.mock.calls.at(-1)?.[2] as string;
    expect(readChatCascade(dir, 'codex', id)?.stage).toBe('deliver');
    expect(readChat(dir, 'codex', id)?.model).toBe('gpt-5.3-codex-spark');
    return id;
  }

  const sentChats = () => send.mock.calls.map((call) => call[2] as string);

  it('tier 0 refused (404 model_not_found) re-delivers on the work model', async () => {
    const cheap = await cheapDelivery();
    const task = readChat(dir, 'codex', cheap)?.messages[0]?.content;

    await planner()(finish(cheap, { ok: false, error: REFUSED_404 }));

    const again = sentChats().at(-1) ?? '';
    expect(again).not.toBe(cheap);
    const created = readChat(dir, 'codex', again);
    expect(created?.model).toBe('gpt-5.3-codex');
    expect(created?.effort).toBe('xhigh');
    expect(readChatCascade(dir, 'codex', again)).toMatchObject({
      stage: 'deliver',
      workModel: 'gpt-5.3-codex',
    });
    // То же задание доставки, тем же текстом.
    expect(send.mock.calls.at(-1)?.[3]).toEqual({ text: task });
    expect(links[`codex:${again}`]).toMatchObject({
      stage: 'deliver',
      parentChatId: 'p:parent',
      model: 'gpt-5.3-codex',
      effort: 'xhigh',
    });
    // Цепочка группы не кончилась — она продолжается новой доставкой.
    expect(ended).not.toHaveBeenCalled();
    // Упавшая доставка называет, куда ушла работа.
    const notice = readChat(dir, 'codex', cheap)?.messages.at(-1);
    expect(notice?.role).toBe('notice');
    expect(notice?.content).toContain('«gpt-5.3-codex-spark»');
    expect(notice?.content).toContain('на модели работы «gpt-5.3-codex»');
  });

  it('tier 0 refused by a ChatGPT-account subscription (400) re-delivers on the work model', async () => {
    const cheap = await cheapDelivery();
    await planner()(finish(cheap, { ok: false, error: REFUSED_CHATGPT }));

    expect(readChat(dir, 'codex', sentChats().at(-1) ?? '')?.model).toBe('gpt-5.3-codex');
  });

  it('a second refusal on the work model does not loop', async () => {
    const cheap = await cheapDelivery();
    await planner()(finish(cheap, { ok: false, error: REFUSED_404 }));
    const again = sentChats().at(-1) ?? '';
    const calls = send.mock.calls.length;

    await planner()(finish(again, { ok: false, error: REFUSED_404.replace('-spark', '') }));

    expect(send.mock.calls.length).toBe(calls);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a failure that is not about the model does not re-deliver', async () => {
    const cheap = await cheapDelivery();
    const calls = send.mock.calls.length;
    for (const error of [
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      'Rate limit reached for gpt-5.3-codex-spark in organization org-x on tokens per min',
      'CLI завершился с кодом 1',
    ]) {
      await planner()(finish(cheap, { ok: false, error }));
    }

    expect(send.mock.calls.length).toBe(calls);
  });

  it('a retry already scheduled by the supervisor goes first', async () => {
    const cheap = await cheapDelivery();
    const calls = send.mock.calls.length;
    await planner()({
      ...finish(cheap, { ok: false, error: REFUSED_404 }),
      retry: { attempt: 1, at: 0 },
    });

    expect(send.mock.calls.length).toBe(calls);
  });

  it('work on the CLI ceiling re-delivers with no model flag', async () => {
    const { workModel: _model, workEffort: _effort, ...ceiling } = FIX;
    const cheap = await cheapDelivery(ceiling);
    await planner()(finish(cheap, { ok: false, error: REFUSED_404 }));

    const again = sentChats().at(-1) ?? '';
    expect(again).not.toBe(cheap);
    expect(readChat(dir, 'codex', again)?.model).toBeUndefined();
    expect(readChat(dir, 'codex', again)?.effort).toBeUndefined();
    expect(links[`codex:${again}`]?.model).toBeUndefined();
    expect(readChat(dir, 'codex', cheap)?.messages.at(-1)?.content).toMatch(/на модели работы\.$/);
  });

  it('a paused tree queues the re-delivery instead of starting it', async () => {
    const cheap = await cheapDelivery();
    const calls = send.mock.calls.length;
    const defer = vi.fn().mockReturnValue(true);
    await planner({ gate: { defer } as unknown as TreeStartGate })(
      finish(cheap, { ok: false, error: REFUSED_404 }),
    );

    expect(send.mock.calls.length).toBe(calls);
    expect(defer).toHaveBeenCalledTimes(1);
    expect(defer.mock.calls[0]?.[0]).toBe('stage');
  });
});
