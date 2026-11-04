import type { AskFields } from '@agentdeck/contracts/core/ask';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import type {
  PanelAgentMessage,
  PanelAgentPageContext,
  PanelAgentRunEvent,
  PanelAgentSealReason,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_RUN_TIMEOUT_MS } from '@agentdeck/contracts/panel-agent';
import type { BridgeTokenLedger } from '../../../lib/bridge-tokens/bridge-tokens.ts';
import { attachTextCodes, serverText } from '../../../lib/server-texts/server-texts.ts';
import { runCoreAsk } from '../../core-ask/core-ask.ts';
import type { CoreAskPort } from '../../core-ask/core-ask.types.ts';
import { panelAgentPrompt, panelAgentSystemPrompt } from '../brief/brief.ts';
import { isForeignInterimNote } from '../interim-note/interim-note.ts';
import { DEFAULT_HELP_WEB_SRC, panelAgentKnowledge } from '../help-topics/help-topics.ts';

/**
 * Один ход агента панели сессией ядра «ask» (этап 10, F2, проход 2c). Своего процесса CLI у
 * панели нет: ядро запускает CLI своей дорогой (маршрут, контур, DLP, журнал), без встроенных
 * инструментов, с одним сервером MCP — мостом панели. Панели остаются бриф, токен моста этого
 * хода и чтение вида сеанса.
 *
 * Токен моста живёт ровно ход: выдан до просьбы ядру, снят на любом конце (ответ, ошибка, «Стоп»,
 * потолок). Процесс модели, переживший ход, до панели больше не дотянется (рубеж доступа).
 */

export interface PanelAgentTurnOptions {
  ask: CoreAskPort;
  bridges: BridgeTokenLedger;
  /** Адрес панели для моста: `http://127.0.0.1:<port>` (ядро пускает только loopback). */
  selfBaseUrl: string;
  conversationId: string;
  context: PanelAgentPageContext;
  messages: PanelAgentMessage[];
  /** Итоги действий прежних ходов разговора — в текст хода (`panelAgentPrompt`). */
  priorActions?: string[];
  /** Маршрут и CLI хода (`resolvePanelAgentRoute`). */
  route: Pick<AskFields, 'adapter' | 'routes' | 'model' | 'consumer'>;
  /** Картинки последней реплики человека: едут в вопрос ядру блоками `image`. */
  images?: AgentImage[];
  /** Промпт контура: дописывается к брифу агента, бриф едет в обоих случаях. */
  contourPrompt?: string;
  onEvent: (event: PanelAgentRunEvent) => void;
  /** Потолок хода; пока карточка ждёт человека, он не идёт. */
  timeoutMs?: number;
  waitingHuman?: () => boolean;
  ceilingTickMs?: number;
  helpWebSrc?: string;
  /** Опрос ядра до первой сессии — подмена для проверок. */
  pollMs?: number;
}

export interface PanelAgentTurnResult {
  ok: boolean;
  reply: string;
  error?: string;
  /** Код обрыва для запечатанного ответа (`closePanelAgentTurn`) и сырая причина. */
  seal?: { reason: PanelAgentSealReason; detail?: string };
  /** Итоги действий этого хода (`panelActionNote`) — и у оборванного: действия-то были. */
  actions: string[];
}

export interface PanelAgentTurnHandle {
  done: Promise<PanelAgentTurnResult>;
  stop: () => void;
}

const STOPPED_TEXT = serverText('panel-agent-stopped');
const TIMEOUT_TEXT = serverText('panel-agent-timeout');
const CEILING_TICK_MS = 1_000;

function errorEvent(message: string): PanelAgentRunEvent {
  return attachTextCodes<PanelAgentRunEvent>({ kind: 'error', message });
}

export function startPanelAgentTurn(options: PanelAgentTurnOptions): PanelAgentTurnHandle {
  let ended: 'stopped' | 'timeout' | undefined;
  let stopRun: (() => void) | undefined;
  const stop = (why: 'stopped' | 'timeout'): void => {
    ended ??= why;
    stopRun?.();
  };
  const done = (async (): Promise<PanelAgentTurnResult> => {
    // Справка не прочиталась — ход идёт без карты: инструменты справки у агента остаются.
    const knowledge = await panelAgentKnowledge(options.helpWebSrc ?? DEFAULT_HELP_WEB_SRC).catch(
      () => undefined,
    );
    if (ended) return sealed(options, ended, []);
    const token = options.bridges.mint(options.conversationId);
    const brief = panelAgentSystemPrompt(options.context, knowledge);
    const fields: AskFields = {
      title: `panel agent · ${options.conversationId}`,
      prompt: panelAgentPrompt(options.messages, options.priorActions),
      system: options.contourPrompt ? `${options.contourPrompt}\n\n${brief}` : brief,
      tools: 'panel-bridge',
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      panelBridge: {
        url: options.selfBaseUrl,
        token,
        conversation: options.conversationId,
      },
      ...options.route,
    };
    const userText = options.messages[options.messages.length - 1]?.content ?? '';
    const run = runCoreAsk(options.ask, fields, options.onEvent, {
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      onTask: (taskId) => options.bridges.bind(token, taskId),
      holdNote: (segment) => isForeignInterimNote(segment, userText),
    });
    stopRun = run.stop;
    if (ended) run.stop();
    const ceiling = armCeiling(options, () => stop('timeout'));
    try {
      const outcome = await run.done;
      const notes = options.bridges.revoke(token);
      const actions = notes.length > 0 ? notes : outcome.actions;
      if (ended) return sealed(options, ended, actions);
      if (outcome.ok) return { ok: true, reply: outcome.reply, actions };
      const detail = outcome.error ?? 'no answer';
      const error =
        outcome.code === 'extra-tool'
          ? serverText('panel-agent-extra-tool', { tool: detail })
          : outcome.code === 'no-answer'
            ? serverText('panel-agent-no-reply')
            : detail;
      options.onEvent(errorEvent(error));
      return { ok: false, reply: '', error, seal: { reason: 'failed', detail }, actions };
    } finally {
      clearInterval(ceiling);
      // Конец хода снимает токен при любом исходе, и брошенном тоже.
      options.bridges.revoke(token);
    }
  })();
  return { done, stop: () => stop('stopped') };
}

function sealed(
  options: PanelAgentTurnOptions,
  why: 'stopped' | 'timeout',
  actions: string[],
): PanelAgentTurnResult {
  const error = why === 'stopped' ? STOPPED_TEXT : TIMEOUT_TEXT;
  options.onEvent(errorEvent(error));
  return { ok: false, reply: '', error, seal: { reason: why }, actions };
}

/** Потолок хода считает только время без ждущей карточки: одобрение под конец не убивает ход. */
function armCeiling(
  options: PanelAgentTurnOptions,
  onCeiling: () => void,
): ReturnType<typeof setInterval> {
  const limit = options.timeoutMs ?? PANEL_AGENT_RUN_TIMEOUT_MS;
  const tick = options.ceilingTickMs ?? CEILING_TICK_MS;
  let spent = 0;
  const timer = setInterval(() => {
    if (options.waitingHuman?.()) return;
    spent += tick;
    if (spent >= limit) onCeiling();
  }, tick);
  timer.unref?.();
  return timer;
}
