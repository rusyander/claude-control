import {
  fixStagePrompt,
  reviewPushPrompt,
  reviewRetryPrompt,
  scanReviewBlocks,
} from '@agentdeck/contracts/model-cascade';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import type { SplitReviewOutcome, SplitReviewView } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, ChatReviewState } from '../../lib/app-store/app-store.types.ts';
import {
  carriedLink,
  conversationKeys as keysOf,
  linkIdentity,
} from '../../lib/app-store/chat-links.ts';
import type { ChatEvent } from './ChatRunner.ts';

/**
 * Ревью запроса на слияние по ссылке (Т7): замечания в связь, решение — человеку.
 *
 * Конвейер подбора после ревью заводит правки сам, и это правильно там, где
 * панель проверяет СВОЮ работу в своей ветке. Здесь всё иначе: ветка чужая, MR
 * чужой, и оба действия, которые напрашиваются после замечаний, — написать в
 * чужой MR и переписать чужую ветку — человек должен разрешить поимённо. Поэтому
 * автоматики здесь нет вовсе: панель считает замечания, показывает карточку и
 * ждёт клика.
 *
 * Три правила, которые здесь держатся.
 *
 * 1. ПУСТОЙ СПИСОК ЗАКРЫВАЕТ ГРУППУ. Карточка «что делать с замечаниями», под
 *    которой замечаний нет, — работа человека на пустом месте.
 * 2. ЗАПИСЬ В MR — ОДНИМ КОММЕНТАРИЕМ. Не по комментарию на замечание: чужой MR
 *    не место для ленты панели, а сводка читается целиком и отвечается один раз.
 * 3. ОТКАЗ ФОРДЖА НЕ ОТМЕНЯЕТ ПРАВОК. «И то и другое» с упавшей записью всё
 *    равно заводит правки, а причина отказа остаётся на карточке: заново
 *    отписать можно, заново решать — незачем.
 *
 * Домен НИЧЕГО не запускает сам: прогоны заводит колбэк маршрута, запись в MR —
 * колбэк интеграции. Поэтому он целиком проверяется тестами без прогонов и без
 * сети.
 */

/** Связи панели: домен ищет по ним ключи одного разговора и соседей по дереву. */
export interface SplitReviewStore {
  /** Все связи разом — по ним же находятся вторые ключи одного разговора. */
  all(): Record<string, ChatLink>;
  set(chatId: string, link: ChatLink): void;
  /**
   * Убрать связь под ключом, которого не будет: звено чужого CLI переехало на
   * настоящий ключ своего хранилища (см. `settle`).
   */
  remove(chatId: string): void;
}

/** Что домен просит снаружи, чтобы решение человека что-то изменило. */
export interface SplitReviewDeps {
  store: SplitReviewStore;
  /**
   * Записать ОДИН сводный комментарий в MR. Отсутствует — интеграции нет вовсе,
   * и кнопка «отписать» на карточке недоступна с причиной.
   */
  post?: (url: string, body: string) => Promise<void>;
  /**
   * Почему записать в MR нельзя прямо сейчас (нет токена, ссылку не разобрать).
   * Пусто — можно. Спрашивается на каждый показ карточки: интеграцию включают и
   * выключают, а кнопка, которая заведомо откажет, хуже отсутствующей.
   */
  postBlocked?: (url: string) => string | undefined;
  /**
   * Завести прогон стадии в копии группы. `started: false` — запустить не
   * вышло (реестр или CLI отказали).
   *
   * `chatId` в ответе — НАСТОЯЩИЙ ключ заведённого разговора, когда он не
   * совпал с запрошенным. Так отвечает чужой CLI: идентификатор разговору
   * выдаёт его собственное хранилище, и до создания его не существует, а связь
   * домен обязан написать раньше запуска.
   */
  start: (input: {
    chatId: string;
    prompt: string;
    cwd: string;
    model?: string;
    effort?: string;
    stage: 'fix' | 'push' | 'review' | 'tell';
    /** Ключи закончившегося разговора: от них наследуются тумблеры и дерево. */
    fromAliases: string[];
    title?: string;
    /**
     * Продолжить ЭТОТ разговор, а не заводить новый (Д8, Д4): push идёт в
     * сессию правок, которая их и сделала, повтор итога — в сессию ревью.
     */
    resume?: { sessionId: string };
  }) => { started: boolean; chatId?: string; busy?: boolean };
  /** Заметка в ленту родителя; `false` — родителя никто не слушает. */
  emit?: (parentChatId: string, event: ChatEvent) => boolean;
  /**
   * Решение человека закрыло группу без нового прогона («ничего не делать»,
   * «только отписать»): конвейер отмечает её готовой и отпускает ждавших (Д3).
   */
  closeGroup?: (link: ChatLink) => void;
  log: (message: string, error?: unknown) => void;
  now?: () => Date;
}

/** Что стало с решением — ответ маршруту, панели и телефону; форма в контракте. */
export type { SplitReviewOutcome };

/** Сколько замечаний уезжает в комментарий: столько же, сколько в задание правок. */
const MAX_FINDINGS = 40;

/**
 * Сводный комментарий в MR: только замечания и их число.
 *
 * Ни подписи, ни рассказа о том, как он получен: это текст в чужом обсуждении,
 * и всё, что в нём не по делу, читают люди, которым панель ничего не обещала.
 */
export function reviewSummaryComment(findings: readonly string[]): string {
  const list = findings.slice(0, MAX_FINDINGS);
  return [
    `**Замечания ревью (${list.length})**`,
    '',
    ...list.map((finding, index) => `${index + 1}. ${finding}`),
  ].join('\n');
}

/** Что стало с замечаниями по решению человека — словами, по одному на исход. */
const DECISION_WORDS: Record<TaskSplitReviewDecision, string> = {
  fix: 'заведены правки в копии',
  post: 'сводка замечаний отписана в MR',
  both: 'заведены правки в копии, сводка отписана в MR',
  none: 'решено ничего не делать',
};

/**
 * Событие ревью словами — для ленты, у которой карточки нет.
 *
 * Лента Claude рисует событие сама: у неё есть и карточка, и поля. У чужого
 * CLI лента — реплики хранилища, и единственный способ что-то в ней сказать —
 * сказать это по-русски одной строкой. Текст живёт здесь, а не у чужого
 * провайдера: словарь ревью один, и вторая его копия разошлась бы с первой.
 */
export function reviewNoticeText(event: Extract<ChatEvent, { kind: 'review' }>): string {
  if (event.pushOffer) {
    return 'Правки по замечаниям сделаны — отправить их в MR можно кнопкой на карточке решения.';
  }
  if (event.noChanges) {
    return 'Правки по замечаниям кончились, а копия не изменилась — отправлять в MR нечего.';
  }
  if (event.pushBlocked) {
    return 'Правки по замечаниям сделаны, но отправить их в MR панель не может: ветка MR неизвестна.';
  }
  const head = `Ревью ${event.url}`;
  if (event.missing) {
    return `${head}: ответ кончился без блока итога — замечания неизвестны. Повторить итог можно кнопкой на карточке.`;
  }
  if (event.decision) {
    const tail = event.postError ? ` Комментарий не записан: ${event.postError}.` : '';
    return `${head}: ${DECISION_WORDS[event.decision]}.${tail}`;
  }
  // «Проверено», а не «сделано»: ревью ничего не меняло (Д5).
  if (event.findings.length === 0) return `${head}: проверено, замечаний нет — правок не было.`;
  return `${head}: замечаний ${event.findings.length} — решение за вами, карточка ниже.`;
}

/**
 * Повторная отписка в MR: решение принято, но запись сорвалась и замечания в MR
 * так и не попали.
 *
 * Запрет на перерешивание бережёт не запись, а ЗАВЕДЁННЫЕ ПРАВКИ — вторых быть
 * не должно. Записи же второй попытки не хватает совсем: отказал фордж (токен
 * протух, сеть легла), человек починил — и панель отвечала ему «решение уже
 * принято», навсегда оставляя замечания непереданными, при том что обходного
 * пути в ней нет. Поэтому повтор разрешён ровно там, где писать ещё некуда: в
 * связи стоит причина отказа и нет отметки об удавшейся записи.
 */
function isPostRetry(review: ChatReviewState, decision: TaskSplitReviewDecision): boolean {
  if (decision !== 'post' && decision !== 'both') return false;
  return Boolean(review.postError) && !review.postedAt;
}

/**
 * Настоящий ключ сессии разговора: не временный `new-…`, под которым звено
 * заводилось, а тот, под которым CLI его хранит и умеет продолжить.
 */
function sessionKeyOf(aliases: readonly string[]): string | undefined {
  return aliases.find((key) => !key.startsWith('new-'));
}

export class SplitReview {
  private readonly deps: SplitReviewDeps;
  private readonly now: () => Date;

  constructor(deps: SplitReviewDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Вид карточки для дерева и хаба; `undefined` — этот чат не про ревью. */
  view(link: ChatLink): SplitReviewView | undefined {
    const review = link.review;
    if (!review) return undefined;
    const findings = review.findings ?? [];
    // Причину недоступности спрашиваем только там, где кнопка вообще нужна:
    // после записи и без замечаний отписывать нечего.
    const blocked =
      findings.length > 0 && !review.postedAt ? this.deps.postBlocked?.(review.url) : undefined;
    return {
      url: review.url,
      ...(review.branch ? { branch: review.branch } : {}),
      ...(review.onMrBranch === false ? { onMrBranch: false } : {}),
      findings,
      ...(review.decision ? { decision: review.decision } : {}),
      ...(review.decidedAt ? { decidedAt: review.decidedAt } : {}),
      ...(review.postedAt ? { postedAt: review.postedAt } : {}),
      ...(review.postError ? { postError: review.postError } : {}),
      ...(blocked ? { postBlocked: blocked } : {}),
      ...(review.pushOffer ? { pushOffer: true } : {}),
      ...(review.pushedAt ? { pushedAt: review.pushedAt } : {}),
      ...(review.missing ? { missing: true } : {}),
      ...(review.pushBlocked ? { pushBlocked: review.pushBlocked } : {}),
    };
  }

  /**
   * Прогон ревью-группы (или правок по нему) кончился.
   *
   * Возвращает событие для ленты родителя; `undefined` — этот чат к ревью по
   * ссылке отношения не имеет либо всё уже сказано. Замечания читаются ОДИН раз
   * (`findings` уже записан ⇒ выходим): второе сообщение человека в тот же чат
   * иначе перезаписывало бы список, по которому карточка уже принята.
   */
  finished(input: {
    chatId: string;
    aliases: string[];
    link: ChatLink;
    ok: boolean;
    text: string;
    /** Ход кончился вопросом человеку или ждёт фоновую команду (Д3, Д8). */
    paused?: boolean;
    /** Есть ли в копии правки — по git, не по словам агента (Д8). */
    hasWork?: () => boolean;
  }): ChatEvent | undefined {
    const { link, ok, text } = input;
    const review = link.review;
    if (!review) return undefined;
    const at = this.now().toISOString();

    // Правки по ревью кончились — предлагаем отправить их в MR. Отдельным
    // кликом: push в чужую ветку панель сама не делает никогда. Но только
    // когда отправлять ЕСТЬ что и КУДА (Д8, Д9): ход, кончившийся вопросом,
    // ещё не конец правок; копия без изменений — не повод для коммита; без
    // известной ветки MR push ушёл бы в новую удалённую ветку.
    if (link.stage === 'fix') {
      if (!ok || input.paused || review.pushOffer || review.pushedAt) return undefined;
      const base = { kind: 'review' as const, chatId: input.chatId, url: review.url, findings: [] };
      if (input.hasWork && !input.hasWork()) return { ...base, noChanges: true };
      if (!review.branch) {
        const pushBlocked = 'branch-unknown' as const;
        this.save(input.aliases, link, { ...review, pushBlocked });
        return { ...base, pushBlocked };
      }
      const { pushBlocked: _blocked, ...rest } = review;
      this.save(input.aliases, link, { ...rest, pushOffer: true });
      return { ...base, pushOffer: true };
    }

    if (link.stage !== 'review' || review.findings) return undefined;
    // Прогон упал или остановлен — читать нечего: замечания появятся, когда
    // человек перезапустит ревью, а пустой список закрыл бы группу как чистую.
    // Ход с вопросом человеку — тоже ещё не итог: ответ продолжит ревью.
    if (!ok || input.paused) return undefined;

    const scanned = scanReviewBlocks(text).findings;
    const { missing: _missing, ...rest } = review;
    // Блока нет — это НЕ «замечаний нет» (Д4): группа ждёт, карточка
    // предлагает повторить итог в той же сессии.
    if (!scanned) {
      this.save(input.aliases, link, { ...rest, missing: true });
      return { kind: 'review', chatId: input.chatId, url: review.url, findings: [], missing: true };
    }
    const findings = scanned;
    // Пустой список — законный и лучший ответ: группа закрыта, карточки нет.
    const decided = findings.length === 0;
    this.save(input.aliases, link, {
      ...rest,
      findings,
      ...(decided ? { decision: 'none' as const, decidedAt: at } : {}),
    });

    return {
      kind: 'review',
      chatId: input.chatId,
      url: review.url,
      findings,
      ...(decided ? { decided: true } : {}),
    };
  }

  /**
   * Решение человека по карточке. `applyToAll` — то же решение всем ревью-группам
   * этого дерева, которые ещё ждут: разбирать десять одинаковых карточек руками
   * человек не нанимался.
   */
  async decide(input: {
    chatId: string;
    decision: TaskSplitReviewDecision;
    applyToAll?: boolean;
    /**
     * Дерево, из хаба которого пришёл клик. Не совпало с родителем связи —
     * решения нет: вкладка помнит чужое разделение, а «применить ко всем»
     * прошлось бы по группам, которых человек сейчас не видит.
     */
    parentChatId?: string;
  }): Promise<SplitReviewOutcome> {
    const links = this.deps.store.all();
    const target = links[input.chatId];
    if (!target?.review) return { applied: [], skipped: [input.chatId] };
    if (input.parentChatId && !this.belongs(links, target, input.parentChatId)) {
      return { applied: [], skipped: [input.chatId] };
    }

    const chats = input.applyToAll
      ? this.pending(links, target.parentChatId, input.decision)
      : [input.chatId];
    const outcome: SplitReviewOutcome = { applied: [], skipped: [] };

    for (const chatId of chats) {
      const link = this.deps.store.all()[chatId];
      const review = link?.review;
      if (!link || !review || (review.findings ?? []).length === 0) {
        outcome.skipped.push(chatId);
        continue;
      }
      // Решённое не перерешиваем: «применить ко всем» не должно переписывать
      // чужой уже сделанный выбор, а повтор того же клика — заводить вторые
      // правки. Исключение ровно одно — сорвавшаяся запись в MR (`isPostRetry`).
      const retry = isPostRetry(review, input.decision);
      if (review.decidedAt && !retry) {
        outcome.skipped.push(chatId);
        continue;
      }
      // Номер в решении — часть ключа заводимого чата: «применить ко всем»
      // проходит цикл быстрее миллисекунды, и голого `new-<ts>` на десять групп
      // хватило бы на один чат, десятикратно перезаписанный.
      outcome.applied.push(
        await this.applyOne(chatId, link, review, input.decision, outcome.applied.length, retry),
      );
    }
    return outcome;
  }

  /**
   * «Закоммитить и отправить в MR» — единственная запись в чужую ветку, и она
   * идёт только отсюда: отдельным кликом по отдельной карточке.
   */
  push(input: { chatId: string; parentChatId?: string }): SplitReviewOutcome {
    const links = this.deps.store.all();
    const link = links[input.chatId];
    const review = link?.review;
    if (!link || !review?.pushOffer || review.pushedAt) {
      return { applied: [], skipped: [input.chatId] };
    }
    if (input.parentChatId && !this.belongs(links, link, input.parentChatId)) {
      return { applied: [], skipped: [input.chatId] };
    }

    // Ветка MR неизвестна — push ушёл бы в новую удалённую ветку, а не в MR (Д9).
    if (!review.branch) {
      return { applied: [{ chatId: input.chatId, refused: 'branch-unknown' }], skipped: [] };
    }

    // Push — продолжение СЕССИИ ПРАВОК (Д8), а не новый чат в той же копии:
    // только она знает, что и зачем правила, и только так в копии не
    // оказывается двух агентов разом.
    const aliases = keysOf(links, input.chatId);
    const session = sessionKeyOf(aliases);
    if (!session) {
      return {
        applied: [{ chatId: input.chatId, refused: 'no-session' }],
        skipped: [],
      };
    }
    const outcome = this.deps.start({
      chatId: session,
      prompt: reviewPushPrompt({
        url: review.url,
        branch: review.branch,
        ...(review.remote ? { remote: review.remote } : {}),
        ...(review.detached ? { detached: true } : {}),
      }),
      cwd: review.path ?? '',
      ...(link.model ? { model: link.model } : {}),
      ...(link.effort ? { effort: link.effort } : {}),
      stage: 'push',
      fromAliases: aliases,
      ...(link.title ? { title: link.title } : {}),
      resume: { sessionId: session },
    });
    if (!outcome.started) {
      this.deps.log('split review: push run refused', input.chatId);
      return {
        applied: [
          {
            chatId: input.chatId,
            refused: outcome.busy ? 'busy' : 'start-failed',
          },
        ],
        skipped: [],
      };
    }
    // Отметка — после старта: отказанный запуск не должен прятать кнопку.
    this.save(aliases, link, { ...review, pushedAt: this.now().toISOString(), pushOffer: false });
    return { applied: [{ chatId: input.chatId, pushChatId: session }], skipped: [] };
  }

  /**
   * «Повторить итог ревью» (Д4): ответ кончился без блока, и группа висит без
   * замечаний. Сообщение уходит в ТУ ЖЕ сессию ревью — MR она уже прочитала.
   */
  retryReview(input: { chatId: string; parentChatId?: string }): SplitReviewOutcome {
    const links = this.deps.store.all();
    const link = links[input.chatId];
    const review = link?.review;
    if (!link || !review?.missing || link.stage !== 'review') {
      return { applied: [], skipped: [input.chatId] };
    }
    if (input.parentChatId && !this.belongs(links, link, input.parentChatId)) {
      return { applied: [], skipped: [input.chatId] };
    }
    const aliases = keysOf(links, input.chatId);
    const session = sessionKeyOf(aliases);
    if (!session) {
      return {
        applied: [{ chatId: input.chatId, refused: 'no-session' }],
        skipped: [],
      };
    }
    const outcome = this.deps.start({
      chatId: session,
      prompt: reviewRetryPrompt(),
      cwd: review.path ?? '',
      ...(link.model ? { model: link.model } : {}),
      ...(link.effort ? { effort: link.effort } : {}),
      stage: 'review',
      fromAliases: aliases,
      ...(link.title ? { title: link.title } : {}),
      resume: { sessionId: session },
    });
    if (!outcome.started) {
      return {
        applied: [
          {
            chatId: input.chatId,
            refused: outcome.busy ? 'busy' : 'start-failed',
          },
        ],
        skipped: [],
      };
    }
    // Отметка снимается, чтобы конец хода прочитал блок заново.
    const { missing: _missing, ...rest } = review;
    this.save(aliases, link, rest);
    return { applied: [{ chatId: input.chatId, retryChatId: session }], skipped: [] };
  }

  /**
   * Связь принадлежит дереву этого разговора.
   *
   * Сравнение прямое: ключ родителя клиент берёт из того же дерева, которое ему
   * отдала панель, — он же и записан в связи. Родитель, у которого связь своя
   * (вложенное разделение), известен двумя ключами сразу, и хаб мог открыться
   * под вторым — этот случай разбирается по его собственным ключам.
   */
  private belongs(links: Record<string, ChatLink>, link: ChatLink, parentChatId: string): boolean {
    if (link.parentChatId === parentChatId) return true;
    return keysOf(links, parentChatId).includes(link.parentChatId);
  }

  /**
   * Ревью-группы дерева, которые ещё ждут решения, — и те, чья запись в MR
   * сорвалась: отказ форджа накрывает всё дерево разом, и разбирать его
   * последствия по одной карточке человек не нанимался.
   */
  private pending(
    links: Record<string, ChatLink>,
    parentChatId: string,
    decision: TaskSplitReviewDecision,
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [chatId, link] of Object.entries(links)) {
      if (link.parentChatId !== parentChatId) continue;
      const review = link.review;
      if (!review || (review.findings ?? []).length === 0) continue;
      if (review.decidedAt && !isPostRetry(review, decision)) continue;
      // Один разговор двумя ключами — одно решение: без этого «применить ко
      // всем» заводило бы по двое правок на каждую группу.
      const identity = linkIdentity(link);
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(chatId);
    }
    return out;
  }

  /**
   * Одно решение по одной группе: запись в MR и/или правки.
   *
   * `retry` — повтор сорвавшейся записи: тогда идёт ТОЛЬКО ветка записи. Правки
   * первое решение уже завело, и заводить их вторыми значило бы наказать
   * человека за отказ форджа двумя агентами в одной копии.
   */
  private async applyOne(
    chatId: string,
    link: ChatLink,
    review: ChatReviewState,
    decision: TaskSplitReviewDecision,
    index: number,
    retry = false,
  ): Promise<SplitReviewOutcome['applied'][number]> {
    const findings = review.findings ?? [];
    const at = this.now().toISOString();
    const aliases = keysOf(this.deps.store.all(), chatId);
    const result: SplitReviewOutcome['applied'][number] = { chatId, decision };
    // Повтор записи решения не переписывает: решено было тогда, тем же решением
    // заведены и правки. Иначе «и то и другое» после отказа форджа превратилось
    // бы на карточке в «только отписать».
    const next: ChatReviewState = retry ? { ...review } : { ...review, decision, decidedAt: at };

    if (decision === 'post' || decision === 'both') {
      const blocked = this.deps.postBlocked?.(review.url);
      if (blocked || !this.deps.post) {
        next.postError = blocked ?? 'интеграция с форджем не настроена';
        result.postError = next.postError;
      } else {
        try {
          await this.deps.post(review.url, reviewSummaryComment(findings));
          next.postedAt = at;
          delete next.postError;
          result.posted = true;
        } catch (error) {
          // Отказ форджа не отменяет правок: ниже они всё равно заведутся, а
          // причина остаётся на карточке — отписать можно ещё раз.
          const message = error instanceof Error ? error.message : String(error);
          next.postError = message.split('\n')[0]?.slice(0, 300) ?? message;
          result.postError = next.postError;
          this.deps.log('split review: comment refused', error);
        }
      }
    }

    if (!retry && (decision === 'fix' || decision === 'both')) {
      const fixChatId = `new-${Date.now()}-fix${index}`;
      this.deps.store.set(fixChatId, {
        ...carriedLink(link),
        createdAt: at,
        stage: 'fix',
        review: next,
      });
      const outcome = this.deps.start({
        chatId: fixChatId,
        prompt: fixStagePrompt(findings, review.branch ? { branch: review.branch } : {}),
        cwd: review.path ?? '',
        ...(link.model ? { model: link.model } : {}),
        ...(link.effort ? { effort: link.effort } : {}),
        stage: 'fix',
        fromAliases: aliases,
        ...(link.title ? { title: link.title } : {}),
      });
      const realId = this.settle(fixChatId, outcome);
      if (outcome.started) result.fixChatId = realId;
      else this.deps.log('split review: fix run refused', chatId);
    }

    this.save(aliases, link, next);
    // Решение без прогона — последнее слово по группе (Д3): иначе она так и
    // висела бы «ждёт решения», держа тех, кто стоит за ней.
    if (!retry && (decision === 'none' || decision === 'post')) this.deps.closeGroup?.(link);
    this.deps.emit?.(link.parentChatId, {
      kind: 'review',
      chatId,
      url: review.url,
      findings,
      decision,
      ...(result.posted ? { posted: true } : {}),
      ...(result.postError ? { postError: result.postError } : {}),
    });
    return result;
  }

  /**
   * Под каким ключом звено на самом деле живёт.
   *
   * У Claude — под запрошенным: разговор заводит реестр прогонов, и связь
   * пишется ДО запуска именно потому, что настоящий `sessionId` приезжает
   * позже и связь на него переносится сама. У чужого CLI переносить нечему:
   * ключ выдаёт хранилище провайдера в момент создания, и звено сообщает его
   * ответом. Тогда связь переезжает, а временный ключ убирается — иначе он
   * остался бы в дереве строкой, за которой нет разговора.
   */
  private settle(requested: string, outcome: { started: boolean; chatId?: string }): string {
    const real = outcome.chatId;
    if (!real || real === requested) return requested;
    const link = this.deps.store.all()[requested];
    if (link) this.deps.store.set(real, link);
    this.deps.store.remove(requested);
    return real;
  }

  /** Записать состояние ревью по ВСЕМ ключам разговора: их два, и оба живые. */
  private save(aliases: readonly string[], link: ChatLink, review: ChatReviewState): void {
    const keys = aliases.length > 0 ? aliases : [];
    for (const key of keys) {
      const current = this.deps.store.all()[key];
      if (!current) continue;
      this.deps.store.set(key, { ...current, review });
    }
    // Ключей не дали (или их не нашлось) — пишем хотя бы по тому, что известно:
    // потерять решение человека дороже, чем записать его один раз.
    if (keys.length === 0) this.deps.log('split review: no aliases for link', link.parentChatId);
  }
}
