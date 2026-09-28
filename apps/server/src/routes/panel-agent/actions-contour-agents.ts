import { z } from 'zod';
import type {
  PlatformAgentAnswer,
  PlatformAgentSession,
  PlatformEmbeddingResult,
  PlatformsInfo,
  PlatformStatus,
} from '@agentdeck/contracts';
import { platformIdPattern } from '@agentdeck/contracts/platform';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { card, encode, readRoute, textWindow } from './action-kit.ts';
import { dataField, textField } from './texts.ts';

/**
 * Опубликованные агенты контура и его эмбеддинги (P3) — то, что человек делает
 * на карточке контура: спросить агента, прочитать и сбросить его сессию,
 * посчитать эмбеддинги. Всё настоящими маршрутами `routes/platform-routes.ts`.
 *
 * Инвариант раздела тот же, что у `actions-contour.ts`: агент панели ключа не
 * видит и не передаёт — в контур ходит маршрут, ключ он берёт сам. Ни одна
 * схема входа не называет его даже словом: проверка раздела ищет такие слова
 * во всех схемах входа контура.
 */

const contourId = z
  .string()
  .trim()
  .regex(platformIdPattern)
  .describe('Contour id from list_contours');

const sessionId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:@-]+$/)
  .describe('Session name at the contour: the same name continues one conversation with the agent');

async function contourStatus(inject: InjectRoute, id: string): Promise<PlatformStatus> {
  const info = await readRoute<PlatformsInfo>(inject, '/api/platforms');
  const status = info.platforms.find((item) => item.platform.id === id);
  if (!status) throw new Error(`Contour «${id}» not found. Call list_contours.`);
  return status;
}

/**
 * Контур, в который маршрут пойдёт: активный и с ключом. Маршрут требует того
 * же (`requireConnected`) и отказал бы 404 уже после одобрения — карточка на
 * заведомый отказ человеку не нужна.
 */
async function connectedContour(inject: InjectRoute, id: string): Promise<PlatformStatus> {
  const status = await contourStatus(inject, id);
  const title = status.platform.title;
  if (!status.hasToken) {
    throw new Error(
      `Contour «${title}» has no key yet: the human enters it in the contour wizard (Contour page).`,
    );
  }
  if (!status.active) {
    throw new Error(
      `Contour «${title}» is not the active one: agents and embeddings go only through the active ` +
        'contour. Enabling it (enable_contour) moves CLI requests there too — ask the human first.',
    );
  }
  return status;
}

/**
 * Контур, через который можно спрашивать агентов. Отказ — до карточки и до
 * сети: одобрять вызов, который маршрут всё равно отвергнет, человеку незачем.
 */
async function agentsContour(inject: InjectRoute, id: string): Promise<PlatformStatus> {
  const status = await contourStatus(inject, id);
  if (!status.agents) {
    throw new Error(
      `Contour «${status.platform.title}» (${status.platform.driver}) declares no published agents.`,
    );
  }
  return connectedContour(inject, id);
}

/** Имя агента в списке, который ведёт человек; нет в списке — только id. */
function agentName(status: PlatformStatus, agent: string): string {
  const known = status.platform.agents.find((item) => item.id === agent);
  return known ? `${known.title} (${agent})` : agent;
}

/** Карточка контура для отпечатка: без учёта расхода, который меняется сам. */
const contourPrint = (status: PlatformStatus) => ({
  platform: status.platform,
  active: status.active,
  hasToken: status.hasToken,
  agents: status.agents,
});

const askInput = z.object({
  contour: contourId,
  agent: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Published agent id at the contour (from contour_status agents, or the human)'),
  message: z.string().trim().min(1).max(20_000).describe('What to ask the agent'),
  session: sessionId.optional(),
});

const askContourAgent = definePanelAction({
  name: 'ask_contour_agent',
  section: 'contour',
  risk: 'danger',
  title: 'journal-ask-contour-agent',
  description:
    'Ask a published agent of a contour (the same call as the agent card on the Contour page). ' +
    'The agent runs at the contour and spends its budget; it may use the tools the company gave it. ' +
    'Pass session to continue one conversation. Always answers with an outcome ' +
    '(ok / unavailable / not-ready / unauthorized / failed) and a reason. Needs confirmation.',
  input: askInput,
  route: async (input, inject) => {
    await agentsContour(inject, input.contour);
    return {
      method: 'POST',
      url: `/api/platforms/${encode(input.contour)}/agents/ask`,
      body: {
        agent: input.agent,
        message: input.message,
        ...(input.session ? { session: input.session } : {}),
      },
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({ contour: contourPrint(await agentsContour(inject, input.contour)) }),
  preview: async (input, inject) => {
    const status = await agentsContour(inject, input.contour);
    return {
      ...card('summary-ask-contour-agent', {
        name: agentName(status, input.agent),
        title: status.platform.title,
      }),
      fields: [
        dataField('label-contour-agent', agentName(status, input.agent)),
        dataField('label-contour-question', maskSecretsInText(input.message)),
        input.session
          ? dataField('label-contour-session', input.session)
          : textField('label-contour-session', 'value-contour-session-none'),
        textField('label-what-happens', 'value-contour-agent-spends'),
      ],
    };
  },
  shape: (_input, body) => {
    const answer = body as PlatformAgentAnswer;
    const window = textWindow(maskSecretsInText(answer.text ?? ''));
    return {
      outcome: answer.outcome,
      detail: answer.detail,
      agentId: answer.agentId,
      ...(answer.sessionId ? { sessionId: answer.sessionId } : {}),
      ...(answer.sessionRecorded !== undefined ? { sessionRecorded: answer.sessionRecorded } : {}),
      text: window.text,
      ...(window.nextOffset !== undefined
        ? { textTruncated: true, textLength: window.length }
        : {}),
    };
  },
});

const readContourAgentSession = definePanelAction({
  name: 'read_contour_agent_session',
  section: 'contour',
  risk: 'read',
  description:
    'What the contour remembers of an agent session: messages it can show, the total number of ' +
    'turns it keeps (tool turns included), which agents took part. Empty = never used or reset.',
  input: z.object({
    contour: contourId,
    session: sessionId,
    agent: z.string().trim().min(1).max(200).optional().describe('Only this agent’s turns'),
  }),
  route: async (input, inject) => {
    await agentsContour(inject, input.contour);
    const query = input.agent ? `?agent=${encode(input.agent)}` : '';
    return {
      method: 'GET',
      url: `/api/platforms/${encode(input.contour)}/agents/sessions/${encode(input.session)}${query}`,
    };
  },
  shape: (_input, body) => {
    const session = body as PlatformAgentSession;
    // Длинная переписка режется с головы: последние реплики нужнее первых.
    const MAX_MESSAGES = 40;
    const shown = session.messages.slice(-MAX_MESSAGES);
    return {
      sessionId: session.sessionId,
      agentIds: session.agentIds,
      total: session.total,
      empty: session.empty,
      ...(shown.length < session.messages.length
        ? { olderOmitted: session.messages.length - shown.length }
        : {}),
      messages: shown.map((message) => ({
        role: message.role,
        content: maskSecretsInText(
          message.content.length > 4_000 ? `${message.content.slice(0, 4_000)}…` : message.content,
        ),
      })),
    };
  },
  summary: 'journal-read-contour-agent-session',
});

const resetContourAgentSession = definePanelAction({
  name: 'reset_contour_agent_session',
  section: 'contour',
  risk: 'danger',
  title: 'journal-reset-contour-agent-session',
  description:
    'Make the contour forget an agent session (its whole conversation, every agent in it). Cannot ' +
    'be undone; resetting an empty session is also success. Needs confirmation.',
  input: z.object({ contour: contourId, session: sessionId }),
  route: async (input, inject) => {
    await agentsContour(inject, input.contour);
    return {
      method: 'DELETE',
      url: `/api/platforms/${encode(input.contour)}/agents/sessions/${encode(input.session)}`,
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({ contour: contourPrint(await agentsContour(inject, input.contour)) }),
  preview: async (input, inject) => {
    const status = await agentsContour(inject, input.contour);
    return {
      ...card('summary-reset-contour-agent-session', {
        name: input.session,
        title: status.platform.title,
      }),
      fields: [
        dataField('label-contour-session', input.session),
        textField('label-what-happens', 'value-contour-session-forget'),
      ],
    };
  },
  shape: (input) => ({ reset: input.session }),
});

const EMBED_TEXTS_MAX = 64;

const embeddingsInput = z.object({
  contour: contourId,
  model: z.string().trim().min(1).max(200).describe('Embedding model name at the contour'),
  texts: z
    .array(z.string().min(1).max(20_000))
    .min(1)
    .max(EMBED_TEXTS_MAX)
    .describe('Texts to embed, one vector each'),
});

const contourEmbeddings = definePanelAction({
  name: 'contour_embeddings',
  section: 'contour',
  risk: 'change',
  title: 'journal-contour-embeddings',
  description:
    'Compute embeddings at a contour (checks that its embedding model answers and what vector ' +
    'size it gives). Spends the contour budget. Returns the count, dimensions and tokens counted — ' +
    'not the numbers themselves. Needs confirmation.',
  input: embeddingsInput,
  route: async (input, inject) => {
    await connectedContour(inject, input.contour);
    return {
      method: 'POST',
      url: `/api/platforms/${encode(input.contour)}/embeddings`,
      body: { model: input.model, input: input.texts },
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({ contour: contourPrint(await connectedContour(inject, input.contour)) }),
  preview: async (input, inject) => {
    const status = await connectedContour(inject, input.contour);
    const sample = input.texts
      .slice(0, 3)
      .map((text) => (text.length > 200 ? `${text.slice(0, 200)}…` : text))
      .join('\n');
    return {
      ...card('summary-contour-embeddings', { name: input.model, title: status.platform.title }),
      fields: [
        dataField('label-contour-model', input.model),
        dataField('label-contour-texts', maskSecretsInText(sample)),
        textField('label-what-happens', 'value-contour-embeddings-spend'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as PlatformEmbeddingResult;
    return {
      model: result.model,
      vectors: result.vectors.length,
      dimensions: result.dimensions,
      promptTokens: result.promptTokens,
      totalTokens: result.totalTokens,
    };
  },
});

/** Агенты и эмбеддинги контура в порядке показа. */
export const CONTOUR_AGENT_ACTIONS: readonly AnyPanelAction[] = [
  askContourAgent,
  readContourAgentSession,
  resetContourAgentSession,
  contourEmbeddings,
];
