import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { GROUP_ECONOMY_DEFAULTS, type GroupEconomy } from '@agentdeck/contracts/group-economy';
import {
  GROUP_ECONOMY_LEVERS,
  leverWorks,
  type GroupEconomyLever,
} from '@agentdeck/contracts/group-economy-support';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { getProvider } from '../../../providers/registry.ts';
import { withCodexKit } from '../../kit/codex.ts';
import { createForeignStagePlanner } from '../cascade/cascade.ts';
import { appendMessage, createChat, readChat, readChatCascade } from '../store/store.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';
import { economyRunEnv } from './economy-run.ts';

/**
 * @covers providers/catalog/codex.ts, economy-run/codex.ts, cascade/cheap-deliver.ts
 * @scenario отметка «действует» у Codex — не обещание: каждый рычаг, объявленный
 *   native/emulated, проверяется на настоящем пути — включён → ключ запуска или
 *   модель доставки есть, выключен → нет. Объявить новый действующий рычаг без
 *   проверки здесь нельзя: тест краснеет.
 */

const codex = getProvider('codex');
const BASE = { env: {}, appData: '/data' };

/** argv запуска группы Codex после настоящего `withCodexKit`. */
function argvOf(economy: GroupEconomy, compactWindow = 0): string[] {
  const env = economyRunEnv(codex.groupEconomy?.channel, {
    ...BASE,
    economy,
    ...(compactWindow ? { compactWindow } : {}),
  });
  return withCodexKit(['app-server'], env, 'appServer').args;
}

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.3-codex', name: 'c', family: 'gpt-codex', vendor: 'openai', releaseDate: '2026-02' },
  {
    id: 'gpt-5.3-codex-spark',
    name: 's',
    family: 'gpt-codex-spark',
    vendor: 'openai',
    releaseDate: '2026-02',
  },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-codex-declared-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Модель доставки после правок группы Codex, шедшей на старшей ступени. */
async function deliverModel(sonnetDeliver: boolean): Promise<string | undefined> {
  const send = vi.fn().mockReturnValue({ ok: true });
  const links: Record<string, ChatLink> = {};
  createChat(dir, 'codex', {
    id: 'fix',
    title: 'g',
    workdir: dir,
    cascade: { stage: 'fix', group: 'g', branch: 'b', workModel: 'gpt-5.3-codex' },
  });
  appendMessage(dir, 'codex', 'fix', { role: 'user', content: 'поправь' });
  links['codex:fix'] = {
    parentChatId: 'codex:p',
    title: 'g',
    createdAt: '2026-10-22',
    stage: 'fix',
  };
  await createForeignStagePlanner({
    chats: { send } as unknown as ProviderChatService,
    provider: (id) => (id === 'codex' ? codex : undefined),
    models: () => MODELS,
    settings: () => ({
      taskSplitInitiative: false,
      handoffInitiative: false,
      groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, sonnetDeliver },
    }),
    hasWork: () => true,
    linkOf: (key) => links[key],
    saveLink: (key, link) => void (links[key] = link),
    delivers: () => true,
    sonnetDeliverOf: () => undefined,
    // Как в сборке без активного контура (`runtime.ts`, проводка `contourRoute`).
    contourRoute: () => ({ routed: false }),
  })({ providerId: 'codex', appDataDir: dir, startedAt: 0, chatId: 'fix', ok: true, text: 'ok' });
  const id = send.mock.calls
    .map((call) => call[2] as string)
    .find((chatId) => readChatCascade(dir, 'codex', chatId)?.stage === 'deliver');
  return readChat(dir, 'codex', id ?? '')?.model;
}

/** Рычаг включён / выключен → есть ли его след на настоящем пути. */
const PROBES: Partial<Record<GroupEconomyLever, (on: boolean) => Promise<boolean> | boolean>> = {
  compactWindow: (on) =>
    argvOf(GROUP_ECONOMY_DEFAULTS, on ? 160_000 : 0).includes(
      'model_auto_compact_token_limit=160000',
    ),
  // Оболочка шире чтения: ключ задаёт именно она (9 600 / 4). Значения ниже
  // собственного предела Codex (2 500 токенов) — выше него ключа нет вовсе.
  bashOutputChars: (on) =>
    argvOf({
      ...GROUP_ECONOMY_DEFAULTS,
      bashOutputChars: on ? 9_600 : 0,
      readOutputTokens: 2_000,
    }).includes('tool_output_token_limit=2400'),
  readOutputTokens: (on) =>
    argvOf({
      ...GROUP_ECONOMY_DEFAULTS,
      bashOutputChars: 4_000,
      readOutputTokens: on ? 2_300 : 0,
    }).includes('tool_output_token_limit=2300'),
  sonnetDeliver: async (on) => (await deliverModel(on)) === 'gpt-5.3-codex-spark',
};

/**
 * Действующие рычаги, которые делает НЕ этот путь, — каждый со своей проверкой:
 * строка привычек — `group-run-lines.test.ts` «foreign habits note follows pinned
 * workHabits» (пакет A); новый разговор после паузы — план холодного продолжения
 * (`setColdPlan`, пакет W).
 */
const ELSEWHERE: GroupEconomyLever[] = ['workHabits', 'freshOnColdResume'];

describe('codex declared levers', () => {
  it('every lever declared native/emulated is produced by its path (on → present, off → absent)', async () => {
    const support = codex.groupEconomy?.support ?? {};
    const working = GROUP_ECONOMY_LEVERS.filter((lever) => leverWorks(support[lever]));
    expect(working.length).toBeGreaterThan(0);
    for (const lever of working) {
      if (ELSEWHERE.includes(lever)) continue;
      const probe = PROBES[lever];
      expect(probe, `${lever}: объявлен действующим, а проверки пути нет`).toBeDefined();
      expect(await probe!(true), `${lever} on`).toBe(true);
      expect(await probe!(false), `${lever} off`).toBe(false);
    }
  });

  it('a lever declared not working has no probe that would make it work', () => {
    const support = codex.groupEconomy?.support ?? {};
    for (const lever of GROUP_ECONOMY_LEVERS) {
      if (leverWorks(support[lever])) continue;
      expect(PROBES[lever], lever).toBeUndefined();
      expect(ELSEWHERE, lever).not.toContain(lever);
    }
  });
});
