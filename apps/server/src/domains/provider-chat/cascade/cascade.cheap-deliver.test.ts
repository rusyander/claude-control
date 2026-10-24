import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { getProvider } from '../../../providers/registry.ts';
import { createForeignStagePlanner, type ForeignStagePlannerDeps } from './cascade.ts';
import type { DeliverContourRoute } from './cheap-deliver.ts';
import { appendMessage, createChat, readChat, readChatCascade } from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';

/**
 * Доставка группы чужого CLI на младшей ступени его лестницы (C2 — аналог
 * «Доставки на Sonnet» у Claude). Провайдеры — НАСТОЯЩИЕ записи каталога (их
 * лестницы и способы передать модель), разговоры и шапки — настоящие файлы
 * хранилища; подменён только запуск CLI.
 */

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.2-codex',
    name: 'codex',
    family: 'gpt-codex',
    vendor: 'openai',
    releaseDate: '2026-01',
  },
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
  {
    id: 'gemini-3-flash-lite',
    name: 'lite',
    family: 'gemini-flash-lite',
    vendor: 'google',
    releaseDate: '2026-03',
  },
  {
    id: 'gemini-3-flash',
    name: 'flash',
    family: 'gemini-flash',
    vendor: 'google',
    releaseDate: '2026-03',
  },
];

/** Работа шла на старшей ступени Codex: доставке есть куда спуститься. */
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

describe('cascade', () => {
  let dir: string;
  let links: Record<string, ChatLink>;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pcheap-'));
    links = {};
    send = vi.fn().mockReturnValue({ ok: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  interface Knobs {
    /** Общий рычаг «Доставка на Sonnet»; нет — блока экономии в настройках нет. */
    global?: boolean;
    /** Выбор человека для группы на карточке разделения. */
    groupChoice?: boolean;
    /** Отдаёт ли сборка выбор группы вовсе (`sonnetDeliverOf`). */
    wired?: boolean;
    /** Маршрут контура следующего прогона; `'unwired'` — сборка его не отдаёт. */
    route?: DeliverContourRoute | 'unwired';
  }

  function planner(providerId: string, knobs: Knobs) {
    const deps: ForeignStagePlannerDeps = {
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === providerId ? getProvider(id) : undefined),
      models: () => MODELS,
      settings: () => ({
        taskSplitInitiative: false,
        handoffInitiative: false,
        ...(knobs.global === undefined
          ? {}
          : {
              groupEconomy: {
                ...GROUP_ECONOMY_DEFAULTS,
                sonnetDeliver: knobs.global,
              },
            }),
      }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => void (links[key] = link),
      delivers: () => true,
      ...(knobs.wired === false ? {} : { sonnetDeliverOf: () => knobs.groupChoice }),
      ...(knobs.route === 'unwired'
        ? {}
        : { contourRoute: () => (knobs.route as DeliverContourRoute) ?? { routed: false } }),
    };
    return createForeignStagePlanner(deps);
  }

  function chat(providerId: string, cascade: ProviderChatCascade): void {
    createChat(dir, providerId, { id: 'fix', title: 'Переименование', workdir: dir, cascade });
    appendMessage(dir, providerId, 'fix', { role: 'user', content: 'Поправь по замечаниям' });
    links[`${providerId}:fix`] = { ...LINK };
  }

  const finish = (providerId: string) => ({
    providerId,
    appDataDir: dir,
    startedAt: 0,
    chatId: 'fix',
    ok: true,
    text: 'Поправил.',
  });

  /** Заведённая и запущенная доставка: модель разговора, шапка, связь. */
  function delivery(providerId: string) {
    const id = send.mock.calls
      .map((call) => call[2] as string)
      .find((chatId) => readChatCascade(dir, providerId, chatId)?.stage === 'deliver');
    expect(id).toBeDefined();
    const created = readChat(dir, providerId, id ?? '');
    return {
      model: created?.model,
      effort: created?.effort,
      cascade: readChatCascade(dir, providerId, id ?? ''),
      link: links[`${providerId}:${id}`],
    };
  }

  it('foreign deliver uses ladder tier 0 when sonnetDeliver', async () => {
    chat('codex', FIX);
    await planner('codex', { global: true })(finish('codex'));

    const got = delivery('codex');
    // Младшая ступень лестницы Codex, свежайшая в семействе.
    expect(got.model).toBe('gpt-5.3-codex-spark');
    // Работа шла на `xhigh` — доставка прижата к глубине младшей ступени
    // (`medium`), а не поднята/оставлена выше неё.
    expect(got.effort).toBe('medium');
    expect(got.link).toMatchObject({
      stage: 'deliver',
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
    });
    // Шапка помнит, чем шла РАБОТА: доставка не выдаёт себя за неё.
    expect(got.cascade).toMatchObject({ workModel: 'gpt-5.3-codex', workEffort: 'xhigh' });
    expect(got.cascade?.lowered).toBeUndefined();
  });

  it('foreign deliver uses ladder tier 0 when sonnetDeliver — Gemini ladder too', async () => {
    chat('gemini', { ...FIX, workModel: 'gemini-3-flash', workEffort: 'medium' });
    await planner('gemini', { global: true })(finish('gemini'));

    const got = delivery('gemini');
    expect(got.model).toBe('gemini-3-flash-lite');
    // Глубина не выше планки остаётся своей: доставка не углубляется.
    expect(got.effort).toBe('medium');
  });

  it('cheap deliver never raises effort: low work effort is kept', async () => {
    chat('codex', { ...FIX, workEffort: 'low' });
    await planner('codex', { global: true })(finish('codex'));

    const got = delivery('codex');
    expect(got.model).toBe('gpt-5.3-codex-spark');
    expect(got.effort).toBe('low');
    expect(got.link?.effort).toBe('low');
  });

  it('cheap deliver never raises effort: high work effort is capped at the tier-0 effort', async () => {
    chat('codex', { ...FIX, workEffort: 'high' });
    await planner('codex', { global: true })(finish('codex'));

    expect(delivery('codex').effort).toBe('medium');
  });

  it('work on the CLI ceiling (no workModel) still delivers on tier 0', async () => {
    const { workModel: _model, workEffort: _effort, ...ceiling } = FIX;
    chat('codex', ceiling);
    await planner('codex', { global: true })(finish('codex'));

    const got = delivery('codex');
    expect(got.model).toBe('gpt-5.3-codex-spark');
    // Глубины у работы не было — флага нет и у доставки: глубину решает
    // `config.toml` человека, как без рычага (потолок `medium` перебил бы его `low`).
    expect(got.effort).toBeUndefined();
    expect(got.link?.effort).toBeUndefined();
    expect(got.cascade?.workModel).toBeUndefined();
  });

  it('group choice false keeps workModel', async () => {
    chat('codex', FIX);
    await planner('codex', { global: true, groupChoice: false })(finish('codex'));

    const got = delivery('codex');
    expect(got.model).toBe('gpt-5.3-codex');
    expect(got.effort).toBe('xhigh');
  });

  it('group choice true wins over the global lever off', async () => {
    chat('gemini', { ...FIX, workModel: 'gemini-3-flash', workEffort: 'high' });
    await planner('gemini', { global: false, groupChoice: true })(finish('gemini'));

    expect(delivery('gemini').model).toBe('gemini-3-flash-lite');
  });

  it('global lever off keeps workModel', async () => {
    chat('codex', FIX);
    await planner('codex', { global: false })(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex');
  });

  it('no ladder (goose, kimi, opencode, continue) keeps workModel as today', async () => {
    for (const providerId of ['goose', 'kimi', 'opencode', 'continue']) {
      send.mockClear();
      chat(providerId, { ...FIX, workModel: 'own-model', workEffort: 'high' });
      await planner(providerId, { global: true, groupChoice: true })(finish(providerId));

      const got = delivery(providerId);
      expect(got.model, providerId).toBe('own-model');
      expect(got.effort, providerId).toBe('high');
    }
  });

  it('tier 0 family missing from the catalog keeps workModel (fail-closed)', async () => {
    chat('codex', FIX);
    const deps = {
      chats: { send } as unknown as ProviderChatService,
      provider: (id: string) => (id === 'codex' ? getProvider(id) : undefined),
      models: () => MODELS.filter((model) => model.family !== 'gpt-codex-spark'),
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key: string) => links[key],
      saveLink: (key: string, link: ChatLink) => void (links[key] = link),
      delivers: () => true,
      sonnetDeliverOf: () => true,
      // Мимо контура: причина отказа здесь — ТОЛЬКО каталог.
      contourRoute: () => ({ routed: false }),
    };
    await createForeignStagePlanner(deps)(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex');
  });

  it('assembly without the group-choice dep keeps workModel (per-group false must not be lost)', async () => {
    chat('codex', FIX);
    await planner('codex', { global: true, wired: false })(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex');
  });

  it('routed through the contour with a map row for tier 0 delivers on tier 0', async () => {
    chat('codex', FIX);
    await planner('codex', {
      global: true,
      route: { routed: true, modelMapKeys: ['sonnet', 'gpt-5.3-codex-spark'] },
    })(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex-spark');
  });

  it('routed through the contour without a map row for tier 0 keeps workModel', async () => {
    chat('codex', FIX);
    await planner('codex', {
      global: true,
      route: { routed: true, modelMapKeys: ['sonnet', 'gpt-5.3-codex'] },
    })(finish('codex'));

    const got = delivery('codex');
    expect(got.model).toBe('gpt-5.3-codex');
    expect(got.effort).toBe('xhigh');
  });

  it('routed through the contour with no model map keeps workModel', async () => {
    chat('codex', FIX);
    await planner('codex', { global: true, route: { routed: true } })(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex');
  });

  it('assembly without the contour-route dep keeps workModel (routing unknown)', async () => {
    chat('codex', FIX);
    await planner('codex', { global: true, route: 'unwired' })(finish('codex'));

    expect(delivery('codex').model).toBe('gpt-5.3-codex');
  });
});
