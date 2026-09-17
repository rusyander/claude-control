import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  PanelAgentConversation,
  PanelAgentConversationSummary,
  PanelAgentMessage,
  PanelAgentPageContext,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_CONVERSATION_ID } from '@agentdeck/contracts/panel-agent';

/**
 * Разговоры агента панели: файл на разговор в `<appData>/panel-agent/<id>.json`.
 *
 * Файлом панели, а не транскриптом CLI: прогон идёт с `--no-session-persistence`,
 * иначе каждый ход агента ложился бы в `~/.claude/projects` и всплывал в списке
 * чатов человека как чужой разговор. История здесь — ровно то, что видело окно.
 */

const DIR = 'panel-agent';
const TITLE_LIMIT = 80;

export function conversationsDir(appDataDir: string): string {
  return join(appDataDir, DIR);
}

function fileOf(appDataDir: string, id: string): string | undefined {
  // Идентификатор уходит в имя файла: всё, что не прошло шаблон, до диска не доходит.
  return PANEL_AGENT_CONVERSATION_ID.test(id)
    ? join(conversationsDir(appDataDir), `${id}.json`)
    : undefined;
}

export function readPanelAgentConversation(
  appDataDir: string,
  id: string,
): PanelAgentConversation | undefined {
  const file = fileOf(appDataDir, id);
  if (!file || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PanelAgentConversation;
    return parsed && Array.isArray(parsed.messages) ? parsed : undefined;
  } catch {
    // Битый файл — «разговора нет», а не падение хода: начнётся заново.
    return undefined;
  }
}

/**
 * Записать разговор целиком. Через временный файл и переименование: оборванная
 * запись оставляет прежнюю версию, а не половину JSON.
 */
export function writePanelAgentConversation(
  appDataDir: string,
  id: string,
  context: PanelAgentPageContext,
  messages: PanelAgentMessage[],
): PanelAgentConversation {
  const file = fileOf(appDataDir, id);
  if (!file) throw new Error(`Недопустимый идентификатор разговора: ${id}`);
  const now = new Date().toISOString();
  const previous = readPanelAgentConversation(appDataDir, id);
  const stamps = previous?.messages ?? [];
  const conversation: PanelAgentConversation = {
    id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    context,
    // Метка времени реплики сохраняется, если реплика та же: окно присылает
    // историю целиком каждый ход, и перештамповывать её значило бы врать о времени.
    messages: messages.map((message, index) => {
      const old = stamps[index];
      const same = old && old.role === message.role && old.content === message.content;
      return { role: message.role, content: message.content, at: same ? old.at : now };
    }),
  };
  mkdirSync(conversationsDir(appDataDir), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(conversation, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return conversation;
}

/** Список разговоров, свежие первыми. Нечитаемые файлы пропускаются. */
export function listPanelAgentConversations(appDataDir: string): PanelAgentConversationSummary[] {
  const dir = conversationsDir(appDataDir);
  if (!existsSync(dir)) return [];
  const out: PanelAgentConversationSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const conversation = readPanelAgentConversation(appDataDir, name.slice(0, -'.json'.length));
    if (!conversation) continue;
    const first = conversation.messages.find((message) => message.role === 'user');
    out.push({
      id: conversation.id,
      updatedAt: conversation.updatedAt,
      title: (first?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT),
      messages: conversation.messages.length,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
