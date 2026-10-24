import { basename } from 'node:path';
import type { ChatInbox, InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import type { ForeignPendingAsk } from '../../provider-chat/ProviderChatService/ProviderChatService.ts';
import type { AskSourceInfo, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Причина D-n человеку — по-русски, как всё сообщение Telegram: `reason`
 * записи написан для агента по-английски. Кода нет (запись старше) — как есть.
 */
function deferredReasonRu(item: NonNullable<ChatInbox['deferred']>[number]): string {
  switch (item.reasonCode) {
    case 'group-rows':
      return 'правила прав группы отдают этот вызов человеку';
    case 'not-auto-approved':
      return 'вызов не покрыт правилами автоподтверждения';
    case 'main-copy':
      return 'правка в основной копии проекта: где писать, решаете вы';
    case 'backend-guard':
      return `защита бэкенда (${item.reasonParams?.rule ?? '?'}): ${item.reasonParams?.match ?? ''}`;
    default:
      return item.reason;
  }
}

/**
 * Что сейчас ждёт человека — из тех же источников, что видят окно и телефон:
 * сводка ожиданий (`GET /api/chat/inbox`: права, ворота ветки, вопросы,
 * хук сессий вне панели, отложенные D-n) и просьбы чужих CLI.
 *
 * Чистая функция: на входе снимки, на выходе ожидания с устойчивыми ключами.
 * По ключу ожидание не уходит в Telegram дважды и находит своё сообщение, когда
 * пропадает из сводки.
 */

const SUMMARY_MAX = 400;

/** Что именно будет сделано — одной строкой, секреты под маской. */
export function summaryOf(input: unknown): string {
  const body = (input ?? {}) as Record<string, unknown>;
  const pick = [
    'command',
    'file_path',
    'path',
    'notebook_path',
    'url',
    'query',
    'sql',
    'description',
  ]
    .map((key) => body[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const raw = pick ?? (typeof input === 'string' ? input : JSON.stringify(input ?? {}));
  const flat = maskSecretsInText(raw).replace(/\s+/g, ' ').trim();
  const text = flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
  return text === '{}' ? '' : text;
}

function sourceOfChat(chat: InboxChat, defaultCli: string): AskSourceInfo {
  const source = chat.source;
  return {
    project: chat.project,
    chatTitle: chat.title,
    cli: source?.cli ?? defaultCli,
    app: source?.app ?? (chat.outside ? 'outside' : 'agentdeck'),
    ...(source?.background ? { background: true } : {}),
    ...(source?.group ? { group: { ...source.group } } : {}),
  };
}

/** Вопросы одного вызова `AskUserQuestion` — одним ожиданием: ответ на них один. */
function questionCallKey(ask: Extract<InboxAsk, { kind: 'question' }>): string {
  return ask.key.replace(/:\d+$/, '');
}

function chatItems(chat: InboxChat, defaultCli: string): PendingAskItem[] {
  const source = sourceOfChat(chat, defaultCli);
  // Группа разделения ждёт сразу: агент стоит, пока человек не ответит, а
  // `afterMinutes` — пауза для того, кто сидит у окна, а не для группы.
  const immediate = Boolean(source.group);
  const base = { openId: chat.id, source, immediate };
  const items: PendingAskItem[] = [];
  const calls = new Map<string, Extract<InboxAsk, { kind: 'question' }>[]>();
  for (const ask of chat.asks) {
    if (ask.kind === 'question') {
      const key = questionCallKey(ask);
      calls.set(key, [...(calls.get(key) ?? []), ask]);
      continue;
    }
    const summary = summaryOf(ask.input);
    if (ask.kind === 'branchGate') {
      if (!chat.runKey) continue;
      items.push({
        ...base,
        key: `b:${chat.runKey}:${ask.toolUseId}`,
        target: { kind: 'branchGate', runKey: chat.runKey, toolUseId: ask.toolUseId },
        askedAt: ask.askedAt,
        toolName: ask.toolName,
        ...(summary ? { summary } : {}),
      });
      continue;
    }
    if (ask.relay) {
      items.push({
        ...base,
        key: `rp:${ask.toolUseId}`,
        target: { kind: 'relayPermission', toolUseId: ask.toolUseId },
        askedAt: ask.askedAt,
        toolName: ask.toolName,
        ...(summary ? { summary } : {}),
        ...(ask.launch ? { launch: ask.launch } : {}),
      });
      continue;
    }
    if (!chat.runKey) continue;
    items.push({
      ...base,
      key: `p:${chat.runKey}:${ask.toolUseId}`,
      target: { kind: 'permission', runKey: chat.runKey, toolUseId: ask.toolUseId },
      askedAt: ask.askedAt,
      toolName: ask.toolName,
      ...(summary ? { summary } : {}),
      ...(ask.launch ? { launch: ask.launch } : {}),
    });
  }
  for (const [callKey, asks] of calls) {
    const first = asks[0]!;
    const ordered = [...asks].sort((left, right) => left.index - right.index);
    const questions = ordered.map((ask) => ask.question);
    if (first.relay && first.toolUseId) {
      items.push({
        ...base,
        key: `rq:${first.toolUseId}`,
        target: { kind: 'relayQuestion', toolUseId: first.toolUseId },
        askedAt: first.askedAt,
        questions,
      });
      continue;
    }
    items.push({
      ...base,
      key: `${callKey}@${chat.id}`,
      target: {
        kind: 'question',
        chatId: chat.id,
        ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
        projectPath: chat.projectPath,
        ...(chat.runKey ? { runKey: chat.runKey } : {}),
      },
      askedAt: first.askedAt,
      questions,
    });
  }
  return items;
}

export interface CollectInput {
  inbox: ChatInbox;
  foreign: readonly ForeignPendingAsk[];
  /** Имя CLI по id провайдера (`Codex CLI`). */
  cliName: (providerId: string) => string;
  /** Имя основного CLI (`Claude Code`). */
  defaultCli: string;
}

export function collectPendingAsks(input: CollectInput): PendingAskItem[] {
  const items = input.inbox.chats.flatMap((chat) => chatItems(chat, input.defaultCli));
  for (const deferred of input.inbox.deferred ?? []) {
    if (deferred.state !== 'waiting') continue;
    items.push({
      // Номер и миг, когда запись открыта: запись, открытая заново под прежним
      // номером (D-L07), или номер, выданный снова после потери файла, — новый
      // вопрос, и Telegram обязан его прислать; «отправлено» по одному номеру
      // держалось семь дней и молча глушило его (RF-DL-07).
      key: `d:${deferred.id}@${deferred.askedAt}`,
      target: { kind: 'deferred', id: deferred.id },
      openId: deferred.chatId ?? '',
      source: {
        project: deferred.project ?? '',
        chatTitle: deferred.chatTitle ?? '',
        cli: input.defaultCli,
        app: 'agentdeck',
        ...(deferred.group
          ? {
              group: {
                index: deferred.group,
                ...(deferred.groupTitle ? { title: deferred.groupTitle } : {}),
              },
            }
          : {}),
      },
      askedAt: deferred.askedAt,
      // D-n ждёт с самого начала дольше любого `afterMinutes`: агент уже ушёл
      // дальше, вопрос лежит, пока человек не ответит.
      immediate: true,
      toolName: deferred.toolName,
      summary: maskSecretsInText(deferred.summary),
      reason: maskSecretsInText(deferredReasonRu(deferred)),
    });
  }
  for (const pending of input.foreign) {
    const what = [pending.ask.tool, pending.ask.title].filter(Boolean).join(': ');
    items.push({
      key: `f:${pending.chatId}:${pending.ask.id}`,
      target: { kind: 'foreign', chatId: pending.chatId, askId: pending.ask.id },
      openId: '',
      source: {
        project: pending.workdir ? basename(pending.workdir) : '',
        chatTitle: '',
        cli: input.cliName(pending.providerId),
        app: 'agentdeck',
      },
      askedAt: pending.ask.at,
      immediate: false,
      ...(what ? { summary: maskSecretsInText(what) } : {}),
    });
  }
  return items;
}
