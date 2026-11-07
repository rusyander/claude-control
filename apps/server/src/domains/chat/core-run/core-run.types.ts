import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';
import type { AskFields } from '@agentdeck/contracts/core/ask';
import type { CommandKind, CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { ChatAttachment, EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { ChatPermissionReply } from '../ChatPermissions/ChatPermissions.ts';
import type { CarryOutcome } from './session-carry.ts';

/** Оценка ядра: задача заведена и ждёт запуска, или отказ с причиной ядра дословно. */
export type CoreEstimateOutcome =
  { ok: true; taskId: string } | { ok: false; code: string; message: string; taskId?: string };

/**
 * Ручки ядра, которыми ход чата идёт как человек панели (этап 10, F2, проход 3). Каждая — звонок
 * через `CoreCaller` (запись ядра, проверка слушателя, число загрузки); тесты подставляют свою.
 */
export interface CoreChatPort {
  /**
   * `env` — значения переменных `fields.session.env` (этап 10, F6): в тело оценки рядом с полями,
   * ядро держит их только в памяти до конца задачи.
   */
  estimate(
    fields: EstimateFields,
    env?: Record<string, string>,
    /** Вложения первого слова чата (s10 G11): ядро кладёт копии в задачу и называет их пути. */
    attachments?: ChatAttachment[],
  ): Promise<CoreEstimateOutcome>;
  /**
   * Вложение следующего хода (s10 G11): копия ядра в каталоге вложений задачи; ответ — её путь, который
   * ход называет в тексте `message-to-step`.
   */
  attach(
    taskId: string,
    attachment: ChatAttachment,
  ): Promise<{ ok: true; file: string } | { ok: false; code: string; message: string }>;
  /** Отказ ядра — исход `rejected` с кодом, а не исключение; исключение — ядро недоступно. */
  command(
    taskId: string,
    kind: CommandKind,
    fields: Record<string, unknown>,
  ): Promise<CommandOutcome>;
  /** `null` — задачи у ядра нет (404). */
  view(taskId: string): Promise<TaskView | null>;
  /** Вид сеанса целиком с `from` (без ожидания): по `next` ход начинается с конца. */
  page(taskId: string, sessionId: string, from: number): Promise<SessionStreamPage>;
  follow(
    taskId: string,
    sessionId: string,
    from: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamPage>;
  /** Поток журнала задачи (SSE `/v1/tasks/:id/events`): оттуда вопросы права. */
  taskEvents(taskId: string, signal: AbortSignal): AsyncIterable<JournalLine>;
}

/** Задача ядра, которая ведёт разговор, и её шаг `chat`. */
export interface CoreChatEntry {
  taskId: string;
  stepId: string;
  /** CLI, которым разговор начат (W3-17a); нет — прежняя запись, а все они начаты Claude. */
  cli?: string;
  /** Папка разговора (волна 3): по ней список чатов ставит разговор не-Claude CLI в его проект. */
  cwd?: string;
}

/** Книга разговоров: id разговора CLI → задача ядра. Переживает перезапуск панели. */
export interface CoreChatBook {
  /** Живая задача разговора; кончилась (`forget`) — `undefined`, хотя CLI разговора помнится. */
  get(conversationId: string): CoreChatEntry | undefined;
  /** CLI разговора — переживает конец задачи: продолжение идёт тем же CLI. */
  cliOf(conversationId: string): string | undefined;
  set(conversationId: string, entry: CoreChatEntry): void;
  forget(conversationId: string): void;
}

/**
 * Карточка права в чате: тот же брокер, что у прежнего моста прав (`ChatSession`), — ради сводки
 * ожиданий и статуса «ждёт вас». Отвечает на вопрос не брокер: ответ `answer` у ядра — класс
 * human-strict (06 §Authority), его шлёт браузер командой ядра с числом страницы. Ответ, записанный
 * ядром (`human.answered`), снимает карточку с брокера через `settle`.
 */
export interface CorePermissionDesk {
  request(
    runId: string,
    card: { toolName: string; input: unknown; toolUseId: string; core?: CorePermitAsk },
  ): Promise<ChatPermissionReply>;
  settle(runId: string, toolUseId: string, reply: ChatPermissionReply): void;
}

export interface CoreChatRunDeps {
  port: CoreChatPort;
  book: CoreChatBook;
  /** Нет — карточку показать некому: вопрос права остаётся ждать ответа в ядре. */
  desk?: CorePermissionDesk;
  pollMs?: number;
  /** Сколько ждать сеанса шага после запуска или после смены сеанса. */
  waitMs?: number;
  now?: () => number;
  /**
   * Маршрут контура потребителя «Чат» на этот ход для CLI разговора (`coreContourRoutes(store,
   * 'chat', cli)`):
   * читается заново на каждую новую задачу — выбор человека на карточке контура меняется между
   * ходами. Нет или `undefined` — набор ядра по умолчанию, как у чата без контура. `asked` — модель
   * хода: шаблон маршрута несёт её перевод контуром, и `set-model` шлёт его (s10 G7).
   */
  routes?: (asked: string, cli: string) => AskFields['routes'];
  /**
   * Активный провайдер панели (`getActiveProviderId`, W3-17a): CLI нового разговора. Своего выбора
   * CLI у чата нет — переключатель провайдера в боковой панели и есть этот выбор. Нет — `claude`.
   */
  activeCli?: () => string;
  /**
   * Слой панели разговору не-Claude CLI (G6, `createForeignCarry`): строка о тестах и набор ЭТОГО
   * CLI. Сборка реестра (`RunOptions`) — слой Claude: плагин, источники и флаги чужому CLI ядро
   * отказало бы. Нет — разговор чужого CLI идёт без слоя панели.
   */
  foreignCarry?: (input: {
    cli: string;
    cwd: string;
    routes?: NonNullable<AskFields['routes']>;
  }) => CarryOutcome;
  /**
   * Где панель кладёт вложения чата (`sandboxRoot()` по умолчанию): файлы под ним уходят ядру
   * байтами, остальные пути остаются в тексте хода (s10 G11).
   */
  uploadsRoot?: string;
}
