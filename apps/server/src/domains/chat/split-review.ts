import {
  fixStagePrompt,
  reviewPushPrompt,
  scanReviewBlocks,
} from '@agentdeck/contracts/model-cascade';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import type { SplitReviewOutcome, SplitReviewView } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, ChatReviewState } from '../../lib/app-store/app-store.types.ts';
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
  /** Завести прогон стадии в копии группы; `false` — реестр отказал. */
  start: (input: {
    chatId: string;
    prompt: string;
    cwd: string;
    model?: string;
    effort?: string;
    stage: 'fix' | 'push';
    /** Ключи закончившегося разговора: от них наследуются тумблеры и дерево. */
    fromAliases: string[];
    title?: string;
  }) => boolean;
  /** Заметка в ленту родителя; `false` — родителя никто не слушает. */
  emit?: (parentChatId: string, event: ChatEvent) => boolean;
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

/** Связь под ключом `chatId` и все ключи того же разговора. */
function keysOf(links: Record<string, ChatLink>, chatId: string): string[] {
  const link = links[chatId];
  if (!link) return [];
  // Связь копируется на `sessionId` как есть — одинаковое содержимое и есть
  // признак одного разговора. Тот же приём, что и в дереве чатов.
  const identity = JSON.stringify(link);
  return Object.keys(links).filter((key) => JSON.stringify(links[key]) === identity);
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
  }): ChatEvent | undefined {
    const { link, ok, text } = input;
    const review = link.review;
    if (!review) return undefined;
    const at = this.now().toISOString();

    // Правки по ревью кончились — предлагаем отправить их в MR. Отдельным
    // кликом: push в чужую ветку панель сама не делает никогда.
    if (link.stage === 'fix') {
      if (!ok || review.pushOffer || review.pushedAt) return undefined;
      this.save(input.aliases, link, { ...review, pushOffer: true });
      return {
        kind: 'review',
        chatId: input.chatId,
        url: review.url,
        findings: [],
        pushOffer: true,
      };
    }

    if (link.stage !== 'review' || review.findings) return undefined;
    // Прогон упал или остановлен — читать нечего: замечания появятся, когда
    // человек перезапустит ревью, а пустой список закрыл бы группу как чистую.
    if (!ok) return undefined;

    const findings = scanReviewBlocks(text).findings ?? [];
    // Пустой список — законный и лучший ответ: группа закрыта, карточки нет.
    const decided = findings.length === 0;
    this.save(input.aliases, link, {
      ...review,
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

    const chats = input.applyToAll ? this.pending(links, target.parentChatId) : [input.chatId];
    const outcome: SplitReviewOutcome = { applied: [], skipped: [] };

    for (const chatId of chats) {
      const link = this.deps.store.all()[chatId];
      const review = link?.review;
      // Решённое не перерешиваем: «применить ко всем» не должно переписывать
      // чужой уже сделанный выбор, а повтор того же клика — заводить вторые правки.
      if (!link || !review || review.decidedAt || (review.findings ?? []).length === 0) {
        outcome.skipped.push(chatId);
        continue;
      }
      // Номер в решении — часть ключа заводимого чата: «применить ко всем»
      // проходит цикл быстрее миллисекунды, и голого `new-<ts>` на десять групп
      // хватило бы на один чат, десятикратно перезаписанный.
      outcome.applied.push(
        await this.applyOne(chatId, link, review, input.decision, outcome.applied.length),
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

    const chatId = `new-${Date.now()}-push`;
    const aliases = keysOf(links, input.chatId);
    const at = this.now().toISOString();
    this.save(aliases, link, { ...review, pushedAt: at, pushOffer: false });
    this.deps.store.set(chatId, {
      ...link,
      createdAt: at,
      stage: 'push',
      review: { ...review, pushedAt: at, pushOffer: false },
    });

    const started = this.deps.start({
      chatId,
      prompt: reviewPushPrompt({
        url: review.url,
        ...(review.branch ? { branch: review.branch } : {}),
      }),
      cwd: review.path ?? '',
      ...(link.model ? { model: link.model } : {}),
      ...(link.effort ? { effort: link.effort } : {}),
      stage: 'push',
      fromAliases: aliases,
      ...(link.title ? { title: link.title } : {}),
    });
    if (!started) this.deps.log('split review: push run refused', input.chatId);

    return {
      applied: [{ chatId: input.chatId, ...(started ? { pushChatId: chatId } : {}) }],
      skipped: [],
    };
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

  /** Ревью-группы дерева, которые ещё ждут решения. */
  private pending(links: Record<string, ChatLink>, parentChatId: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [chatId, link] of Object.entries(links)) {
      if (link.parentChatId !== parentChatId) continue;
      const review = link.review;
      if (!review || review.decidedAt || (review.findings ?? []).length === 0) continue;
      // Один разговор двумя ключами — одно решение: без этого «применить ко
      // всем» заводило бы по двое правок на каждую группу.
      const identity = JSON.stringify(link);
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(chatId);
    }
    return out;
  }

  /** Одно решение по одной группе: запись в MR и/или правки. */
  private async applyOne(
    chatId: string,
    link: ChatLink,
    review: ChatReviewState,
    decision: TaskSplitReviewDecision,
    index: number,
  ): Promise<SplitReviewOutcome['applied'][number]> {
    const findings = review.findings ?? [];
    const at = this.now().toISOString();
    const aliases = keysOf(this.deps.store.all(), chatId);
    const result: SplitReviewOutcome['applied'][number] = { chatId, decision };
    const next: ChatReviewState = { ...review, decision, decidedAt: at };

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

    if (decision === 'fix' || decision === 'both') {
      const fixChatId = `new-${Date.now()}-fix${index}`;
      this.deps.store.set(fixChatId, {
        ...link,
        createdAt: at,
        stage: 'fix',
        review: next,
      });
      const started = this.deps.start({
        chatId: fixChatId,
        prompt: fixStagePrompt(findings, review.branch ? { branch: review.branch } : {}),
        cwd: review.path ?? '',
        ...(link.model ? { model: link.model } : {}),
        ...(link.effort ? { effort: link.effort } : {}),
        stage: 'fix',
        fromAliases: aliases,
        ...(link.title ? { title: link.title } : {}),
      });
      if (started) result.fixChatId = fixChatId;
      else this.deps.log('split review: fix run refused', chatId);
    }

    this.save(aliases, link, next);
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
