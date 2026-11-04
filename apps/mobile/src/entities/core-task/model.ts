import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';
import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import type { AskView } from '@agentdeck/contracts/core/task-view';
import type { UnsignedCoreCommand } from '../../shared/api/signing/coreCommand';

/**
 * Задачи ядра на телефоне — чистая часть (этап 10, зона D): разбор потока событий задачи,
 * карточки открытых вопросов, команды на выбор человека и куда ведёт push о вопросе. Без React и
 * сети — проверяется тестом, а не глазами на устройстве.
 *
 * Модули `core/*` контрактов тянут zod — сюда они входят только типами (бандл телефона zod не
 * везёт значением).
 */

/** Вопрос, как его показывает карточка: факты строки `human.asked` журнала. */
export interface CoreAskCard {
  askId: string;
  point: number;
  source: HumanAskSource;
  question: string;
  options: string[];
  defaultAction: string | null;
  /** Деление вопроса запуска (ключ `split:<id>`) — для `approve-split`. */
  splitId: string | null;
}

export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/**
 * Кадры SSE из накопленного текста: целые (до пустой строки) — разобраны, хвост — остаток до
 * следующего куска. Комментарии (`: open`, `: ping`) кадрами не считаются.
 */
export function takeSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n');
  const parts = text.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let id: string | null = null;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) frames.push({ id, event, data: data.join('\n') });
  }
  return { frames, rest };
}

const str = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

/** Кадр `human.asked` → карточка вопроса; другой вид или кривая строка — `null`. */
export function askCardOf(frame: SseFrame): CoreAskCard | null {
  if (frame.event !== 'human.asked') return null;
  let line: { kind?: unknown; data?: unknown };
  try {
    line = JSON.parse(frame.data) as { kind?: unknown; data?: unknown };
  } catch {
    return null;
  }
  if (line.kind !== 'human.asked' || !line.data || typeof line.data !== 'object') return null;
  const d = line.data as Record<string, unknown>;
  const askId = str(d, 'askId');
  if (!askId) return null;
  const dedupe = str(d, 'dedupe');
  return {
    askId,
    point: typeof d.point === 'number' ? d.point : 0,
    source: (str(d, 'source') || 'ask_human') as HumanAskSource,
    question: str(d, 'question'),
    options: Array.isArray(d.options)
      ? d.options.filter((one): one is string => typeof one === 'string')
      : [],
    defaultAction: typeof d.defaultAction === 'string' ? d.defaultAction : null,
    splitId: dedupe.startsWith('split:') ? dedupe.slice('split:'.length) : null,
  };
}

/**
 * Открытые вопросы задачи: состояние — из вида задачи (он знает «отвечен/истёк»), текст и
 * варианты — из строки журнала. Строка ещё не дошла по потоку — вопрос всё равно показан
 * (пустой текст), отвечать можно своим текстом.
 */
export function openAskCards(
  asks: readonly Pick<AskView, 'askId' | 'state' | 'point' | 'source'>[],
  details: ReadonlyMap<string, CoreAskCard>,
): CoreAskCard[] {
  return asks
    .filter((ask) => ask.state === 'open')
    .map(
      (ask) =>
        details.get(ask.askId) ?? {
          askId: ask.askId,
          point: ask.point,
          source: ask.source,
          question: '',
          options: [],
          defaultAction: null,
          splitId: null,
        },
    );
}

export type CoreAskChoice =
  { type: 'option'; option: string; cancelReason: string } | { type: 'text'; text: string };

/** Команда без `cmdId` и подписи: их ставит отправка (`api.ts`). */
export type CoreCommandDraft = Omit<UnsignedCoreCommand, 'cmdId'>;

/**
 * Выбор на карточке → команды ядра, как у панели (`features/CoreAsk`): почти всё — `answer`
 * текстом варианта; вопрос запуска — `approve-split` по делению и `cancel` отменой задачи.
 * «edit-split» (правка деления) на телефоне нет — `null`, карточка зовёт в панель.
 */
export function commandsForChoice(
  taskId: string,
  ask: CoreAskCard,
  choice: CoreAskChoice,
): CoreCommandDraft[] | null {
  const target = { taskId };
  const answer = (text: string): CoreCommandDraft => ({
    kind: 'answer',
    target,
    fields: { askId: ask.askId, answer: text },
  });
  if (choice.type === 'text') return choice.text.trim() ? [answer(choice.text.trim())] : null;
  if (ask.source === 'launch') {
    if (choice.option === 'approve-split' && ask.splitId) {
      return [{ kind: 'approve-split', target, fields: { splitId: ask.splitId } }];
    }
    if (choice.option === 'cancel') {
      return [{ kind: 'cancel', target, fields: { reason: choice.cancelReason } }];
    }
    if (choice.option === 'edit-split') return null;
  }
  return [answer(choice.option)];
}

/**
 * Решение человека по вопросу права задачи ядра в чате (карточка «Вопрос ядра») → команды ядру,
 * как у окна панели (`pages/Chat/lib/corePermit.ts`). Ответ `answer` у ядра — human-strict:
 * маршрут прогона панели (`permission-decision`) его не передаёт, телефон шлёт команды сам, со
 * своей подписью. «Разрешить» на вопросе пункта 5 — сначала грант (проект и маска из отказа),
 * затем ответ `grant`: ядро продолжает шаг, только увидев выданное право. Вопрос пункта 3 — ответ
 * первым вариантом (`allow`). «Запретить» — ответ `refuse`. `null` — гранта собрать не из чего
 * (ядро не назвало репозиторий или путь).
 */
export function corePermitDrafts(
  card: CorePermitAsk,
  behavior: 'allow' | 'deny',
): CoreCommandDraft[] | null {
  const target = { taskId: card.taskId };
  const answer = (text: string): CoreCommandDraft => ({
    kind: 'answer',
    target,
    fields: { askId: card.askId, answer: text },
  });
  if (behavior === 'deny') return [answer('refuse')];
  if (!card.options.includes('grant')) return [answer(card.options[0] ?? 'allow')];
  if (!card.project || card.globs.length === 0) return null;
  return [
    { kind: 'grant', target, fields: { project: card.project, globs: card.globs, ops: ['edit'] } },
    answer('grant'),
  ];
}

/** Текст вопроса права ядра из тела карточки (`input.question`) — простым текстом, не JSON. */
export function corePermitQuestion(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const question = (input as { question?: unknown }).question;
  return typeof question === 'string' ? question : '';
}

/** Куда ведёт push о вопросе ядра (`domains/notify/core-notice.ts` сервера). */
export interface CoreAskTarget {
  taskId: string;
  askId: string;
  machineId: string;
}

export function coreAskTarget(data: unknown): CoreAskTarget | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (record.kind !== 'core-ask') return undefined;
  const taskId = str(record, 'taskId').trim();
  if (!taskId) return undefined;
  return { taskId, askId: str(record, 'askId'), machineId: str(record, 'machineId') };
}

/**
 * Номер команды — uuidv7, как требует ядро (`cmdId`): 48 бит времени, версия 7, вариант 10,
 * остальное случайно. Случайность подаётся снаружи (`expo-crypto` в приложении, тест — свои байты).
 */
export function uuidv7(random: Uint8Array, now: number = Date.now()): string {
  if (random.length < 10) throw new Error('uuidv7: need 10 random bytes');
  const time = now.toString(16).padStart(12, '0').slice(-12);
  const hex = Array.from(random.slice(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  const variant = ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(8, 20)}`;
}
