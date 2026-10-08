import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeTextFile } from '../../../lib/safe-io/safe-io.ts';
import type {
  PanelAgentConversation,
  PanelAgentConversationSummary,
  PanelAgentMessage,
  PanelAgentOpenTurn,
  PanelAgentPageContext,
  PanelAgentSeal,
  PanelAgentSealReason,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_CONVERSATION_ID } from '@agentdeck/contracts/panel-agent';
import { sealFooter } from '@agentdeck/contracts/panel-agent-feed';
import { panelAgentMaskTolerantEquals } from '../data-mask/data-mask.ts';

/**
 * Разговоры агента панели: файл на разговор в `<appData>/panel-agent/<id>.json`.
 *
 * Файлом панели, а не транскриптом CLI: прогон идёт с `--no-session-persistence`,
 * иначе каждый ход агента ложился бы в `~/.claude/projects` и всплывал в списке
 * чатов человека как чужой разговор. История здесь — ровно то, что видело окно.
 */

const DIR = 'panel-agent';
const TITLE_LIMIT = 80;
/** Потолок запечатанного ответа: окно шлёт историю обратно, а реплика там не длиннее 50 000. */
const SEALED_LIMIT = 20_000;

/**
 * Метка этого процесса панели. Идущий ход пишет её в файл; ход с чужой меткой
 * умер вместе с прежним процессом (перезапуск посреди хода) и запечатывается
 * при первом чтении.
 */
const BOOT = randomUUID();

type StoredMessage = PanelAgentConversation['messages'][number];
type IncomingMessage = PanelAgentMessage & { interrupted?: true; seal?: PanelAgentSeal };

export function conversationsDir(appDataDir: string): string {
  return join(appDataDir, DIR);
}

function fileOf(appDataDir: string, id: string): string | undefined {
  // Идентификатор уходит в имя файла: всё, что не прошло шаблон, до диска не доходит.
  return PANEL_AGENT_CONVERSATION_ID.test(id)
    ? join(conversationsDir(appDataDir), `${id}.json`)
    : undefined;
}

function readRaw(file: string): PanelAgentConversation | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PanelAgentConversation;
    return parsed && Array.isArray(parsed.messages) ? parsed : undefined;
  } catch {
    // Битый файл — «разговора нет», а не падение хода: начнётся заново.
    return undefined;
  }
}

/** Через временный файл и переименование: оборванная запись оставляет прежнюю версию. */
function writeRaw(appDataDir: string, file: string, conversation: PanelAgentConversation): void {
  mkdirSync(conversationsDir(appDataDir), { recursive: true });
  // С повтором переименования: ход пишет файл на каждом блоке, а на Windows
  // переименование поверх файла, который читает вторая вкладка, падает EPERM —
  // и сказанное молча не записывалось.
  writeTextFile(file, `${JSON.stringify(conversation, null, 2)}\n`, { preserveForm: false });
}

export function readPanelAgentConversation(
  appDataDir: string,
  id: string,
): PanelAgentConversation | undefined {
  const file = fileOf(appDataDir, id);
  if (!file) return undefined;
  const conversation = readRaw(file);
  if (conversation?.openTurn && conversation.openTurn.boot !== BOOT) {
    // Ход прежнего процесса панели: дописать его уже некому.
    const closed = sealed(conversation, 'restart');
    writeRaw(appDataDir, file, closed);
    return closed;
  }
  return conversation;
}

/**
 * Закрыть ход без ответа модели. Сказанное и выполненное до обрыва становится
 * репликой агента с пометкой: иначе после перезапуска панели или остановки от
 * хода оставалась только просьба человека, а одобренные и уже сделанные
 * действия пропадали и из ленты, и из памяти следующего хода.
 *
 * Текст реплики модель прочтёт следующим ходом — он английский (D-E,
 * `sealFooter`); человеку окно рисует пометку своим языком по коду `seal`.
 */
function sealed(
  conversation: PanelAgentConversation,
  reason: PanelAgentSealReason,
  detail?: string,
): PanelAgentConversation {
  const { openTurn, ...rest } = conversation;
  if (!openTurn || (openTurn.texts.length === 0 && openTurn.actions.length === 0)) return rest;
  const seal: PanelAgentSeal = {
    reason,
    actions: [...openTurn.actions],
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
  const footer = sealFooter(seal);
  // Потолок режет сказанное с начала, хвост остаётся целым: по нему окно узнаёт
  // пометку и рисует её языком человека.
  const room = Math.max(0, SEALED_LIMIT - footer.length - 2);
  const said = openTurn.texts.join('\n\n').slice(-room);
  const content = [said, footer].filter(Boolean).join('\n\n');
  const now = new Date().toISOString();
  return {
    ...rest,
    updatedAt: now,
    messages: [...rest.messages, { role: 'assistant', content, at: now, interrupted: true, seal }],
  };
}

/** Записать, что ход уже сказал и сделал. Файла нет — нечего и дописывать. */
export function recordPanelAgentTurnProgress(
  appDataDir: string,
  id: string,
  progress: Pick<PanelAgentOpenTurn, 'texts' | 'actions'>,
): void {
  const file = fileOf(appDataDir, id);
  const conversation = file ? readRaw(file) : undefined;
  if (!file || !conversation) return;
  writeRaw(appDataDir, file, {
    ...conversation,
    openTurn: {
      boot: BOOT,
      startedAt: conversation.openTurn?.startedAt ?? new Date().toISOString(),
      texts: [...progress.texts],
      actions: [...progress.actions],
    },
  });
}

/** Ход кончился без ответа (ошибка, остановка, закрытое окно): запечатать сделанное. */
export function closePanelAgentTurn(
  appDataDir: string,
  id: string,
  reason: PanelAgentSealReason,
  detail?: string,
): void {
  const file = fileOf(appDataDir, id);
  const conversation = file ? readRaw(file) : undefined;
  if (!file || !conversation?.openTurn) return;
  writeRaw(appDataDir, file, sealed(conversation, reason, detail));
}

/**
 * Окно, увидевшее обрыв, выкидывает из своей истории просьбу без ответа — и с ней
 * запечатанный ответ, которого у окна нет. Следующий ход переписал бы файл этой
 * историей и стёр сделанное; здесь запечатанная пара встаёт на своё место.
 */
function withSealedTurn(
  appDataDir: string,
  previous: StoredMessage[],
  incoming: IncomingMessage[],
): IncomingMessage[] {
  if (!previous.some((message) => message.interrupted)) return incoming;
  // Реплики человека сверяются с поправкой на маску: файл хранит их с маской
  // своего хода, присланное — с маской этой минуты (F-121). Ответы агента маска
  // не трогает — их текст сверяется точно.
  const masked = panelAgentMaskTolerantEquals(appDataDir);
  const same = (sent: IncomingMessage | undefined, kept: IncomingMessage | undefined): boolean =>
    !!sent &&
    !!kept &&
    sent.role === kept.role &&
    (sent.role === 'user' ? masked(kept.content, sent.content) : sent.content === kept.content);
  // Каждый оборванный ход, а не только последний: после двух обрывов в одной
  // вкладке окно не знает обеих пар, и следующий ход ложно «устаревал».
  const out: IncomingMessage[] = [];
  let at = 0;
  for (let index = 0; index < previous.length; index += 1) {
    const message = previous[index]!;
    const answer = previous[index + 1];
    if (message.role === 'user' && answer?.interrupted) {
      if (same(incoming[at], message) && same(incoming[at + 1], answer)) at += 2;
      out.push(message, answer);
      index += 1;
    } else if (same(incoming[at], message)) {
      out.push(incoming[at]!);
      at += 1;
    } else {
      // Разошлись: хвост просьб без ответа окно выбрасывает законно, всё
      // остальное — чужая история, и её судит проверка на отставание.
      if (previous.slice(index).some((rest) => rest.role !== 'user')) return incoming;
      break;
    }
  }
  return [...out, ...incoming.slice(at)];
}

/**
 * Разговор удалили (из «Истории» другой вкладки), а окно пишет в него со своей
 * историей: запись вернула бы удалённое целиком. Одна просьба без истории —
 * не удалённый разговор, а новый с заданным id: терять в нём нечего.
 */
export function isDeletedPanelAgentConversation(
  appDataDir: string,
  id: string,
  incoming: IncomingMessage[],
): boolean {
  const file = fileOf(appDataDir, id);
  return incoming.length > 1 && file !== undefined && !existsSync(file);
}

/**
 * Вкладка отстала от разговора: его продолжили в другой вкладке (или на
 * телефоне), и присланная история не знает чужого хода. Ход с такой историей
 * переписал бы файл и стёр чужие реплики — вместо этого отказ `conversation_stale`.
 *
 * Сравнивается длина, а не текст: маска данных переписывает реплики при каждом
 * ходе, и старый текст с новым мог разойтись без всякой второй вкладки. Реплики
 * человека без ответа в конце файла окно законно выбрасывает (ход не удался), а
 * запечатанный ход `withSealedTurn` возвращает на место до сравнения.
 */
export function isStalePanelAgentHistory(
  appDataDir: string,
  id: string,
  incoming: IncomingMessage[],
): boolean {
  const previous = readPanelAgentConversation(appDataDir, id);
  if (!previous) return false;
  let end = previous.messages.length;
  while (end > 0 && previous.messages[end - 1]?.role === 'user') end -= 1;
  // Пустой ответ (ход без текста) окно в историю не берёт — и не должно его знать.
  const known = previous.messages
    .slice(0, end)
    .filter((message) => message.role === 'user' || message.content.trim()).length;
  const sent = withSealedTurn(appDataDir, previous.messages, incoming).filter(
    (message) => message.role === 'user' || message.content.trim(),
  );
  // Последняя присланная реплика — новая просьба; до неё окно должно знать весь файл.
  return sent.length - 1 < known;
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
  const kept = withSealedTurn(appDataDir, stamps, messages);
  const conversation: PanelAgentConversation = {
    id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    context,
    // Метка времени реплики сохраняется, если реплика та же: окно присылает
    // историю целиком каждый ход, и перештамповывать её значило бы врать о времени.
    messages: kept.map((message, index) => {
      const old = stamps[index];
      const same = old && old.role === message.role && old.content === message.content;
      return {
        role: message.role,
        content: message.content,
        at: same ? old.at : now,
        ...(same && old.interrupted ? { interrupted: true as const } : {}),
        ...(same && old.seal ? { seal: old.seal } : {}),
      };
    }),
  };
  writeRaw(appDataDir, file, conversation);
  return conversation;
}

/**
 * Удалить разговор. `false` — такого нет (или id не прошёл шаблон). След
 * действий (`agent-actions.jsonl`) остаётся: он о том, что панель сделала, а не
 * о переписке, и удаление разговора его не отменяет.
 */
export function deletePanelAgentConversation(appDataDir: string, id: string): boolean {
  const file = fileOf(appDataDir, id);
  if (!file || !existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
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
