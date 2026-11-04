import type { PushDevice } from '@agentdeck/contracts';
import type { RelayNotice } from '@agentdeck/contracts/core/relay';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { PANEL_LINK_HOST, essenceLine, headLine } from './telegram-answers/compose.ts';
import { escapeHtml } from './telegram-answers/html.ts';

/**
 * Вопрос ядра задач человеку — уведомление и ссылка, НЕ место ответа (этап 10, Q2/Q9). Ответ
 * `answer` у ядра — суд `human-strict` (`policy/authority`): его доказывают число страницы
 * панели с чистым пиром или подпись ключом телефона. Telegram не доказывает ни того, ни другого,
 * поэтому сообщение без кнопок, а ответ на него reply-ем получает отказ с той же ссылкой
 * (`telegram-answers/service.ts`).
 *
 * Наружу (Expo, Telegram) уходят заголовок задачи и строка вопроса под маской секретов — как у
 * вопросов чата панели; ни путей, ни журнала.
 */

/** Ссылка панели на задачу ядра с открытым вопросом (`/core?id=…&ask=…`, раздел задач ядра). */
export function coreTaskLink(
  taskId: string,
  askId: string | null,
  port = process.env.WEB_PORT ?? '8888',
): string {
  const ask = askId ? `&ask=${encodeURIComponent(askId)}` : '';
  return `http://${PANEL_LINK_HOST}:${port}/core?id=${encodeURIComponent(taskId)}${ask}`;
}

/** Предел строки вопроса в Telegram: суть, а не весь текст. */
const QUESTION_LIMIT = 300;

/** Строка-ссылка на задачу — текстом: кнопкой Telegram адрес loopback не принимает. */
function taskLinkLine(url: string): string {
  const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${href}">Открыть задачу →</a>`;
}

/** Сообщение Telegram о вопросе ядра: заголовок задачи, суть вопроса, где ответить, ссылка. */
export function coreAskTelegramText(notice: RelayNotice, question: string): string {
  return [
    headLine('Ядро ждёт ответа', escapeHtml(notice.title)),
    essenceLine(maskSecretsInText(question), QUESTION_LIMIT),
    escapeHtml('Ответить можно в панели или с телефона — Telegram ответ ядру не передаёт.'),
    '',
    taskLinkLine(notice.deepLink),
  ].join('\n');
}

/** Отказ на reply к сообщению о вопросе ядра: ответ не принят, названо где ответить. */
export function coreAskRefusalText(deepLink: string): string {
  return [
    escapeHtml(
      'Ответ из Telegram ядру не передан: вопрос ядра принимает ответ только в панели ' +
        'или с телефона (подпись ключом устройства).',
    ),
    '',
    taskLinkLine(deepLink),
  ].join('\n');
}

export interface CorePushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: string;
}

/**
 * Push о вопросе ядра на каждое спаренное устройство. По `data` приложение открывает экран
 * задачи ядра (`app/core-task.tsx`) на нужной панели (`machineId`).
 */
export function corePushMessages(
  notice: RelayNotice,
  devices: readonly PushDevice[],
  machineId: string | undefined,
): CorePushMessage[] {
  return devices.map((device) => ({
    to: device.token,
    title: 'Ядро ждёт ответа',
    body: notice.title,
    data: {
      kind: 'core-ask',
      taskId: notice.taskId,
      askId: notice.askId ?? '',
      ...(machineId ? { machineId } : {}),
    },
    sound: 'default',
    priority: 'high',
    channelId: 'runs',
  }));
}
