import type {
  SplitMrWatch,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewPipeline, MrReviewThread } from '../integrations/mr-review.ts';
import type { SplitConveyorStore } from './split-conveyor.ts';
import type { ChatEvent } from './ChatRunner.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Наблюдатель MR после «готово» (WP1j; живой прогон 24.09, журнал 104, 114).
 *
 * Группа закрывается `done`, когда MR заведён, — а ревьюер пишет потом. Из
 * восьми MR прогона у четырёх висели не прочитанные никем ветки (старейшая —
 * три часа), и одна 🔴 пришла, пока группа дописывала итог. Красный конвейер
 * после «готово» тоже не видел никто: «следить за конвейером» стояло в `next`
 * передачи, а следить было некому.
 *
 * Теперь панель смотрит в MR доставленной группы по РАСПИСАНИЮ, а не циклом:
 * фиксированные паузы от `doneAt`, после последней — всё. Раньше конец — MR
 * влит или закрыт. Нашлось, что ждёт группу, — она продолжается своей сессией
 * со списком веток; новое «готово» после этого начинает новый круг.
 *
 * Два правила.
 *
 * 1. ЗАМЕЧАНИЕ — это нерешённая ветка, последняя реплика которой не от автора
 *    MR и не от бота. Ответила группа — ветка ждёт ревьюера, а не её; ответил
 *    ревьюер снова — это новая реплика и новое замечание. Переданное не
 *    передаётся второй раз (`relayed`), и круги это помнят.
 * 2. КОНВЕЙЕР — ОДИН ВЗГЛЯД на каждый конвейер: первый увиденный исход
 *    записывается, красный (`failed`) продолжает группу. Идущий конвейер
 *    смотрится на следующей проверке; тот же конвейер второй раз не судится.
 *
 * Фордж и продолжение — снаружи (`read`, `resume`): тесты гоняют расписание на
 * данных форджа, без сети и без прогонов.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Паузы проверок от `doneAt`. После последней наблюдение круга кончено. */
export const MR_WATCH_OFFSETS_MS: readonly number[] = [
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  4 * HOUR,
  8 * HOUR,
  24 * HOUR,
];
/** Не чаще раза в минуту — и после перезапуска, когда сроки уже прошли. */
export const MR_WATCH_MIN_GAP_MS = MINUTE;
/** Сколько раз наблюдатель сам продолжает одну группу; дальше — только человек. */
export const MAX_MR_WATCH_RESUMES = 5;
/** Сколько переданных реплик помним: больше — у MR другие беды. */
const MAX_RELAYED = 500;

/** Исход, после которого конвейер уже не изменится сам. */
const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);

export interface MrWatchDeps {
  store: Pick<SplitConveyorStore, 'get' | 'set' | 'all'>;
  /** MR по ссылке; `undefined` — прочитать нечем (нет токена, не тот фордж). */
  read: (mrUrl: string) => Promise<MrReview | undefined>;
  /** Продолжить доставленную группу словом панели (`SplitConveyor.resumeDelivered`). */
  resume: (parentChatId: string, index: number, prompt: string) => 'sent' | 'queued' | 'refused';
  schedule?: (run: () => void, ms: number) => unknown;
  now?: () => Date;
  /**
   * Заметка в ленту родителя: наблюдатель сдался (журнал 81). Без неё новые
   * ветки ревьюера молча ждали человека, который о них не знал.
   */
  notify?: (parentChatId: string, event: ChatEvent) => void;
  log: (message: string, error?: unknown) => void;
}

/** Ключ реплики, на которую группа должна ответить. */
function relayKey(thread: MrReviewThread): string {
  return `${thread.id}:${thread.notes[thread.notes.length - 1]?.id ?? ''}`;
}

/**
 * Ветки, которые ждут группу: нерешённые, последняя реплика — не автора MR и
 * не бота, и её ещё не передавали.
 */
export function pendingThreads(review: MrReview, relayed: readonly string[]): MrReviewThread[] {
  return review.threads.filter((thread) => {
    if (!thread.resolvable || thread.resolved) return false;
    const last = thread.notes[thread.notes.length - 1];
    if (!last || last.bot) return false;
    if (review.author && last.author === review.author) return false;
    return !relayed.includes(relayKey(thread));
  });
}

/** Реплика в одну строку: промпт — не место для простыней ревьюера. */
function excerpt(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Продолжение группы по её MR. Кроме списка — две вещи, ради которых он и
 * пишется (журнал 104b): перечитать ВСЕ обсуждения до работы и ещё раз перед
 * новым «готово» — за время хода ревьюер мог написать ещё.
 */
export function mrWatchPrompt(input: {
  branch: string;
  mr: string;
  threads: readonly MrReviewThread[];
  red?: MrReviewPipeline;
}): string {
  const lines = [
    `Панель проверила MR группы после «готово» (${input.mr}, ветка ${input.branch}) — ` +
      'там есть то, что ждёт группу.',
  ];
  if (input.threads.length > 0) {
    lines.push('', `Нерешённые ветки ревьюеров, ждущие ответа (${input.threads.length}):`);
    for (const thread of input.threads) {
      const first = thread.notes[0];
      const last = thread.notes[thread.notes.length - 1];
      if (!first || !last) continue;
      const where = thread.path ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ''}` : '';
      const reply =
        last !== first ? ` — последняя реплика ${last.author}: «${excerpt(last.body, 200)}»` : '';
      // Ссылка на реплику — от форджа, если он её дал (GitHub), иначе якорь GitLab.
      const link = last.url ?? `${input.mr}#note_${last.id}`;
      lines.push(`- ${first.author}${where} · ${link}: «${excerpt(first.body)}»${reply}`);
    }
  }
  if (input.red) {
    lines.push(
      '',
      `Конвейер MR упал: №${input.red.id}${input.red.url ? ` (${input.red.url})` : ''}. ` +
        'Прочитай логи упавших заданий и почини в ветке. Если падение не про эту работу ' +
        '(инфраструктура, чужой флак) — докажи это строками лога и скажи человеку, ничего не правя.',
    );
  }
  lines.push(
    '',
    'Сначала перечитай ВСЕ обсуждения MR целиком, а не только перечисленные: пока ты не ' +
      'работал, могли прийти новые.',
    'Каждое замечание — поправь в ветке и ответь в той же ветке обсуждения, что сделано, ' +
      'или ответь, почему не правишь. Ветку закрывает ревьюер, не ты.',
    `Доведи доставку как прежде: закоммить, отправь ветку ${input.branch}, MR тот же. ` +
      'Прежде чем снова сказать «готово», перечитай обсуждения MR ещё раз — новое, пришедшее ' +
      'за время работы, тоже твоё.',
  );
  return lines.join('\n');
}

/** Доставленная группа со своим MR — только её MR и смотрится. */
function watchable(record: SplitPlanRecord, group: SplitPlanGroupRecord): boolean {
  // Ревью по ссылке (Т7) читает ЧУЖОЙ MR: его ветки — не замечания группе.
  if (record.proposal.groups[group.index]?.review) return false;
  return Boolean(
    group.status === 'done' && group.deliver && group.mr && group.doneAt && !group.cleaned,
  );
}

export class MrWatch {
  private readonly deps: MrWatchDeps;
  private readonly now: () => Date;
  /** Поставленные таймеры: группа → круг. Второй таймер того же круга не ставится. */
  private readonly timers = new Map<string, string>();

  constructor(deps: MrWatchDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Цепочка группы кончилась: поставить наблюдение доставленным группам записи.
   * Зовётся на каждый конец и лишнего не ставит — круг узнаётся по `doneAt`.
   */
  sync(parentChatId: string): void {
    const record = this.deps.store.get(parentChatId);
    if (!record) return;
    for (const group of record.groups) this.arm(record, group);
  }

  /** После перезапуска панели: таймеры жили в памяти прежнего процесса. */
  recover(): void {
    for (const record of Object.values(this.deps.store.all())) {
      for (const group of record.groups) this.arm(record, group);
    }
  }

  private key(parentChatId: string, index: number): string {
    return `${parentChatId}#${index}`;
  }

  private arm(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    if (!watchable(record, group) || !group.doneAt) return;
    const cycle = group.doneAt;
    if (this.timers.get(this.key(record.parentChatId, group.index)) === cycle) return;
    let watch = group.mrWatch;
    if (!watch || watch.cycle !== cycle) {
      // Новый круг: счёт проверок и стоп — заново; переданное, взгляд на
      // конвейер и потолок продолжений — помним.
      const fresh: SplitMrWatch = { cycle, checks: 0 };
      if (watch?.relayed) fresh.relayed = watch.relayed;
      if (watch?.pipeline) fresh.pipeline = watch.pipeline;
      if (watch?.resumes) fresh.resumes = watch.resumes;
      watch = fresh;
      group.mrWatch = watch;
      this.deps.store.set(record);
    }
    if (watch.stopped) return;
    this.plan(record.parentChatId, group.index, cycle, watch.checks);
  }

  private plan(parentChatId: string, index: number, cycle: string, checks: number): void {
    const offset = MR_WATCH_OFFSETS_MS[checks];
    const key = this.key(parentChatId, index);
    if (offset === undefined) {
      this.timers.delete(key);
      const current = this.current(parentChatId, index, cycle);
      if (current) {
        current.watch.stopped = 'exhausted';
        this.deps.store.set(current.record);
      }
      return;
    }
    const delay = Math.max(Date.parse(cycle) + offset - this.now().getTime(), MR_WATCH_MIN_GAP_MS);
    const schedule = this.deps.schedule ?? setTimeout;
    this.timers.set(key, cycle);
    schedule(() => {
      if (this.timers.get(key) === cycle) this.timers.delete(key);
      void this.check(parentChatId, index, cycle).catch((error) => {
        this.deps.log('mr watch: check failed', error);
      });
    }, delay);
  }

  /** Группа всё ещё в том же круге наблюдения — иначе проверка уже не про неё. */
  private current(
    parentChatId: string,
    index: number,
    cycle: string,
  ): { record: SplitPlanRecord; group: SplitPlanGroupRecord; watch: SplitMrWatch } | undefined {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || !watchable(record, group) || group.doneAt !== cycle) return undefined;
    const watch = group.mrWatch;
    if (!watch || watch.cycle !== cycle || watch.stopped) return undefined;
    return { record, group, watch };
  }

  /** Одна проверка круга. Открыта для тестов; сама по себе зовётся таймером. */
  async check(parentChatId: string, index: number, cycle: string): Promise<void> {
    const before = this.current(parentChatId, index, cycle);
    if (!before?.group.mr) return;
    const mr = before.group.mr;

    let review: MrReview | undefined;
    try {
      review = await this.deps.read(mr);
    } catch (error) {
      // Фордж не ответил — факт неизвестен; следующая проверка по расписанию.
      this.deps.log('mr watch: forge read failed', error);
    }

    // За время запроса группу могли продолжить или закрыть заново.
    const now = this.current(parentChatId, index, cycle);
    if (!now) return;
    const { record, group, watch } = now;
    watch.checks += 1;

    if (!review) {
      this.deps.store.set(record);
      this.plan(parentChatId, index, cycle, watch.checks);
      return;
    }
    if (review.state !== 'open') {
      watch.stopped = review.state;
      this.deps.store.set(record);
      return;
    }

    const threads = pendingThreads(review, watch.relayed ?? []);
    const pipeline = review.pipeline;
    const looked =
      pipeline && FINISHED.has(pipeline.status) && watch.pipeline?.id !== pipeline.id
        ? pipeline
        : undefined;
    const red = looked?.status === 'failed' ? looked : undefined;
    const previous = { relayed: watch.relayed, pipeline: watch.pipeline, resumes: watch.resumes };
    if (looked) watch.pipeline = { id: looked.id, status: looked.status };

    if (threads.length === 0 && !red) {
      this.deps.store.set(record);
      this.plan(parentChatId, index, cycle, watch.checks);
      return;
    }

    const resumes = watch.resumes ?? 0;
    if (resumes >= MAX_MR_WATCH_RESUMES) {
      watch.stopped = 'limit';
      this.deps.store.set(record);
      this.deps.log(
        `mr watch: group «${group.title}» resumed ${resumes} times already — left to the human`,
      );
      const params = { group: group.title, resumes: String(resumes), mr };
      this.deps.notify?.(parentChatId, {
        kind: 'notice',
        code: 'mrWatchLimit',
        text: serverText('split-mr-watch-limit-notice', params),
        textCode: 'split-mr-watch-limit-notice',
        textParams: params,
      });
      return;
    }

    // Запись — ДО продолжения: старт прогона тут же переводит группу в
    // «работает», и после него круг уже не наш.
    watch.relayed = [...(watch.relayed ?? []), ...threads.map(relayKey)].slice(-MAX_RELAYED);
    watch.resumes = resumes + 1;
    this.deps.store.set(record);
    const sent = this.deps.resume(
      parentChatId,
      index,
      mrWatchPrompt({ branch: group.branch, mr, threads, ...(red ? { red } : {}) }),
    );
    if (sent !== 'refused') return;

    // Продолжить не вышло — ничего не передано: следующая проверка попробует снова.
    const fresh = this.current(parentChatId, index, cycle);
    if (!fresh) return;
    const restore = <K extends 'relayed' | 'pipeline' | 'resumes'>(
      field: K,
      value: SplitMrWatch[K],
    ): void => {
      if (value === undefined) delete fresh.watch[field];
      else fresh.watch[field] = value;
    };
    restore('relayed', previous.relayed);
    restore('pipeline', previous.pipeline);
    restore('resumes', previous.resumes);
    this.deps.store.set(fresh.record);
    this.plan(parentChatId, index, cycle, fresh.watch.checks);
  }
}
