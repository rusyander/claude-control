import Fastify, { type FastifyInstance } from 'fastify';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Стенд для интеграционных тестов действий агента над настройками, контуром,
 * интеграциями, переносом и аналитикой: настоящий Fastify с воротами доступа,
 * настоящие маршруты разделов (их регистрирует тест) и маршруты агента.
 *
 * Вызов идёт так, как его шлёт переходник (`x-agentdeck-panel-agent`), решение
 * по карточке — как клик в окне (Origin интерфейса). Ничего из этого не
 * подменяет слой под проверкой: подменён только ввод человека.
 */
export const HARNESS_ORIGIN = 'http://localhost:8888';

export interface ManageHarness {
  app: FastifyInstance;
  /** Вызов действия; ответ 200 обязателен, иначе исключение с телом. */
  call: (name: string, input: unknown) => Promise<PanelActionResult>;
  /** Вызов записи: дождаться карточки и решить её как человек. */
  decided: (
    name: string,
    input: unknown,
    decision?: 'approve' | 'reject',
  ) => Promise<{ card: PanelPendingAction; result: PanelActionResult }>;
  /** Карточки, ждущие решения, — отказ до карточки их не создаёт. */
  pendingCards: () => Promise<PanelPendingAction[]>;
  close: () => Promise<void>;
}

export async function manageHarness(
  ctx: ServerContext,
  registerRoutes: (app: FastifyInstance) => void,
): Promise<ManageHarness> {
  const pending = new PanelPendingActions(10_000);
  const access = {
    allowedOrigins: allowedOrigins(8888),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  const app = Fastify();
  registerAccessGate(app, access);
  registerEmptyBodyGuard(app);
  registerRoutes(app);
  registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
  await app.ready();

  const run = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-manage' },
    });

  const settle = async (answer: Awaited<ReturnType<typeof run>>): Promise<PanelActionResult> => {
    if (answer.statusCode !== 200) {
      throw new Error(`action answered ${answer.statusCode}: ${answer.body}`);
    }
    return answer.json<PanelActionResult>();
  };

  const pendingCards = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const decided: ManageHarness['decided'] = async (name, input, decision = 'approve') => {
    const running = run(name, input);
    let card: PanelPendingAction | undefined;
    for (let attempt = 0; attempt < 1000 && !card; attempt += 1) {
      [card] = await pendingCards();
      if (!card) {
        // Отказ до карточки: вызов уже кончился — ждать нечего.
        const done = await Promise.race([
          running.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10)),
        ]);
        if (done && !(await pendingCards()).length) {
          const result = await settle(await running);
          throw new Error(`no card: ${result.outcome} ${result.message ?? ''}`);
        }
      }
    }
    if (!card) throw new Error('the card never appeared');
    const answer = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: HARNESS_ORIGIN },
      payload: { decision },
    });
    if (answer.statusCode !== 200) throw new Error(`decision answered ${answer.statusCode}`);
    return { card, result: await settle(await running) };
  };

  return {
    app,
    call: async (name, input) => settle(await run(name, input)),
    decided,
    pendingCards,
    close: async () => {
      pending.cancelAll();
      await app.close();
    },
  };
}
