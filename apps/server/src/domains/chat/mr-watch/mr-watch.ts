import { LEARN_SIEVES_LINE } from '@agentdeck/contracts/sieves';
import type {
  SplitMrWatch,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import type {
  MrReview,
  MrReviewFailedJob,
  MrReviewPipeline,
  MrReviewThread,
} from '../../integrations/mr-review/mr-review.ts';
import type { SplitConveyorStore } from '../split-conveyor/split-conveyor.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { noteRelayed, pendingThreads, REVIEW_REPLY_LINES, threadLines } from './review-threads.ts';

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

/**
 * Причины падения задания GitLab (`failure_reason`), за которыми стоит машина
 * CI, а не код ветки: умер раннер, не ответил API GitLab, сломался
 * планировщик. `script_failure` и прочие — дело кода, их читает группа.
 */
export const INFRA_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'runner_system_failure',
  'api_failure',
  'scheduler_failure',
  'data_integrity_failure',
]);

/**
 * Задания, которые повторит панель: только если ВСЕ упавшие задания упали на
 * инфраструктуре. Хоть одно с причиной кода или без причины (GitHub, задания
 * не прочлись) — `undefined`, и красный судится группой как прежде.
 */
export function infraJobs(red: MrReviewPipeline): MrReviewFailedJob[] | undefined {
  const jobs = red.failedJobs;
  if (!jobs || jobs.length === 0) return undefined;
  return jobs.every((job) => job.reason !== undefined && INFRA_FAILURE_REASONS.has(job.reason))
    ? jobs
    : undefined;
}

/** Снимок полей наблюдения до продолжения — вернуть, если продолжить не вышло. */
type Previous = Pick<SplitMrWatch, 'relayed' | 'pipeline' | 'resumes'>;

function restoreField<K extends 'relayed' | 'pipeline' | 'resumes' | 'infraRetried' | 'redRelay'>(
  watch: SplitMrWatch,
  field: K,
  value: SplitMrWatch[K],
): void {
  if (value === undefined) delete watch[field];
  else watch[field] = value;
}

export interface MrWatchDeps {
  store: Pick<SplitConveyorStore, 'get' | 'set' | 'all'>;
  /** MR по ссылке; `undefined` — прочитать нечем (нет токена, не тот фордж). */
  read: (mrUrl: string) => Promise<MrReview | undefined>;
  /** Продолжить доставленную группу словом панели (`SplitConveyor.resumeDelivered`). */
  resume: (parentChatId: string, index: number, prompt: string) => 'sent' | 'queued' | 'refused';
  /**
   * Повторить задание конвейера MR (E3). `true` — фордж повтор принял. Нет —
   * красный конвейер судится группой, как до E3.
   */
  retryJob?: (mrUrl: string, jobId: string) => Promise<boolean>;
  /**
   * Лог задания конвейера MR как текст (P8). Нет — продолжение уходит без хвоста лога,
   * как раньше; `undefined` — лога нет (не GitLab, нет токена).
   */
  jobLog?: (mrUrl: string, jobId: string) => Promise<string | undefined>;
  schedule?: (run: () => void, ms: number) => unknown;
  now?: () => Date;
  /**
   * Заметка в ленту родителя: наблюдатель сдался (журнал 81). Без неё новые
   * ветки ревьюера молча ждали человека, который о них не знал.
   */
  notify?: (parentChatId: string, event: ChatEvent) => void;
  /**
   * Конвейер группы, ждущей человека из-за красного (`mr-red`), позеленел (g1 26.10, F2):
   * панель сама сверяет доставку (`SplitConveyor.pipelineGreen`). Нет — ожидание не смотрится.
   */
  settleGreen?: (parentChatId: string, index: number, pipelineId: string) => boolean;
  log: (message: string, error?: unknown) => void;
}

export {
  noteRelayed,
  pendingThreads,
  reviewThreadsGap,
  threadLines,
  threadLink,
} from './review-threads.ts';

/** Сколько упавших заданий и строк лога каждого продолжение несёт (P8): хвост, а не лог. */
export const MR_WATCH_LOG_JOBS = 2;
export const MR_WATCH_LOG_LINES = 40;
const LOG_LINE_MAX = 400;

/** Хвост лога упавшего задания — что панель уже прочла у форджа. */
export interface MrWatchJobLog {
  name: string;
  /** Номер задания у форджа: по нему группа открывает весь лог одним чтением (N1). */
  id?: string;
  lines: readonly string[];
}

/** Метка времени раннера GitLab в начале строки: `2026-10-26T13:55:04.680226Z 00E `, `…Z 00O+`. */
const LOG_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z \d+[EO]\+?\s?/;
/** Сколько последних разных строк смотрит свёртка повторов: ожидание раннера чередует две-три строки. */
const LOG_FOLD_WINDOW = 4;

/**
 * Последние строки лога задания без шума терминала: цвета ANSI, метки разделов GitLab
 * (`section_start:…`), перезапись строки возвратом каретки. Пустые строки не в счёт.
 * Повтор строки (та же без метки времени) среди последних разных сворачивается в «(×N)»:
 * g1 26.10 — 25 минут «Waiting for pod … Insufficient cpu» дали 13 тыс. знаков из 26
 * тыс. вводной, а сказали одну строку.
 */
export function jobLogTail(trace: string, max = MR_WATCH_LOG_LINES): string[] {
  const ESC = String.fromCharCode(27);
  const ansi = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
  const lines: Array<{ line: string; key: string; count: number }> = [];
  for (const raw of trace.replace(ansi, '').split('\n')) {
    // Возврат каретки перезаписывает строку: видно то, что после последнего.
    const line = (
      raw
        .split('\r')
        .filter((part) => part.trim())
        .at(-1) ?? ''
    ).trimEnd();
    const key = line.replace(LOG_STAMP, '').trim();
    if (!key || /^section_(?:start|end):\d+:/.test(key)) continue;
    const seen = lines.slice(-LOG_FOLD_WINDOW).find((entry) => entry.key === key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    lines.push({
      line: line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line,
      key,
      count: 1,
    });
  }
  return lines.slice(-max).map(({ line, count }) => (count > 1 ? `${line} (×${count})` : line));
}

/** Причины-таймауты GitLab: машина CI или код — решает, начался ли скрипт задания. */
const TIMEOUT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'job_execution_timeout',
  'stuck_or_timeout_failure',
]);

/**
 * Скрипт задания так и не начался: раннер пишет разделы (`section_start:`), а раздела
 * `step_script` нет — срок ушёл на подготовку (под не получил узел, образ не скачался),
 * код ветки не запускался. g1 26.10, конвейер 12035: semgrep-scan 25 минут ждал узел
 * («0/30 nodes are available: 30 Insufficient cpu») и упал `job_execution_timeout`.
 */
export function scriptNeverStarted(trace: string): boolean {
  return /section_start:\d+:/.test(trace) && !/section_start:\d+:step_script\b/.test(trace);
}

/**
 * Все упавшие задания — на машине CI: по причине (`infraJobs`) или таймаут, за который
 * скрипт так и не начался (`scriptNeverStarted`). Лог таймаута не прочёлся — не доказано,
 * красный судит группа, как прежде.
 */
export async function infraFailures(
  read: ((mrUrl: string, jobId: string) => Promise<string | undefined>) | undefined,
  mr: string,
  red: MrReviewPipeline,
  log: (message: string, error?: unknown) => void,
): Promise<MrReviewFailedJob[] | undefined> {
  const byReason = infraJobs(red);
  if (byReason || !read) return byReason;
  const jobs = red.failedJobs ?? [];
  const infraReason = (job: MrReviewFailedJob) =>
    job.reason !== undefined && INFRA_FAILURE_REASONS.has(job.reason);
  const timeout = (job: MrReviewFailedJob) =>
    job.reason !== undefined && TIMEOUT_FAILURE_REASONS.has(job.reason);
  if (jobs.length === 0 || !jobs.every((job) => infraReason(job) || timeout(job))) {
    return undefined;
  }
  for (const job of jobs.filter((one) => !infraReason(one))) {
    let trace: string | undefined;
    try {
      trace = await read(mr, job.id);
    } catch (error) {
      log(`mr watch: job log ${job.id} read failed`, error);
      return undefined;
    }
    if (!trace || !scriptNeverStarted(trace)) return undefined;
  }
  return jobs;
}

/**
 * Хвосты логов не больше чем `MR_WATCH_LOG_JOBS` упавших заданий: сначала задания с
 * причиной кода. Лог не прочёлся — задание без хвоста, как раньше. Общее у наблюдателя
 * MR и «Перепроверить MR»: оба задания говорят «прочитай логи упавших заданий».
 */
export async function failedJobLogs(
  read: (mrUrl: string, jobId: string) => Promise<string | undefined>,
  mr: string,
  red: MrReviewPipeline,
  log: (message: string, error?: unknown) => void,
): Promise<MrWatchJobLog[] | undefined> {
  const infra = (job: MrReviewFailedJob) =>
    job.reason !== undefined && INFRA_FAILURE_REASONS.has(job.reason) ? 1 : 0;
  const jobs = [...(red.failedJobs ?? [])]
    .sort((a, b) => infra(a) - infra(b))
    .slice(0, MR_WATCH_LOG_JOBS);
  const logs: MrWatchJobLog[] = [];
  for (const job of jobs) {
    try {
      const trace = await read(mr, job.id);
      const lines = trace ? jobLogTail(trace) : [];
      if (lines.length > 0) logs.push({ name: job.name, id: job.id, lines });
    } catch (error) {
      log(`mr watch: job log ${job.id} read failed`, error);
    }
  }
  return logs.length > 0 ? logs : undefined;
}

/** Хвосты логов в задании группы — блоком text на задание. */
export function jobLogLines(logs: readonly MrWatchJobLog[] | undefined): string[] {
  return (logs ?? []).flatMap((log) => [
    `Tail of the log of ${log.name}${log.id ? ` (job ${log.id})` : ''} (the last ` +
      `${log.lines.length} lines, read by the panel — start from them; open the whole log ` +
      'only if they do not show the cause):',
    '```text',
    ...log.lines,
    '```',
  ]);
}

/**
 * Что делать с красным конвейером (g5 25.10, N1): группа повторила 20-минутный прогон
 * CI у себя вместо одного чтения лога, а зелёный локальный прогон не доказывает ни
 * починку, ни «не из-за этой работы». Лог — первым; лога нет — сказать сразу.
 */
export const CI_RED_LINES: readonly string[] = [
  "Read the failed job's log FIRST, before any other step: the tail below is that log, read " +
    'by the panel; open the whole log by the job id only if the tail does not show the cause.',
  'A local re-run proves neither a fix nor that the failure is not about this work — only ' +
    'log lines do. Fix the cause in the branch; if it is not about this work (infrastructure, ' +
    "someone else's flake), prove it with log lines and tell the human, editing nothing.",
  'No log reachable (no tail below and the job log read fails) — report that gap to the human ' +
    'at once and run nothing: no local re-run of the CI job.',
];

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
  /** Хвосты логов упавших заданий, которые панель уже прочла (P8). */
  logs?: readonly MrWatchJobLog[];
}): string {
  const lines = [
    `The panel checked the group's MR after "done" (${input.mr}, branch ${input.branch}) — ` +
      'there is something waiting for the group.',
  ];
  if (input.threads.length > 0) {
    lines.push('', `Unresolved reviewer threads waiting for an answer (${input.threads.length}):`);
    lines.push(...threadLines(input.threads, input.mr));
  }
  if (input.red) {
    lines.push(
      '',
      `The MR pipeline failed: #${input.red.id}${input.red.url ? ` (${input.red.url})` : ''}.`,
      ...CI_RED_LINES,
    );
    const jobs = input.red.failedJobs ?? [];
    if (jobs.length > 0) {
      // Номер задания — в списке (N1): лог открывается одним чтением, без поиска по конвейеру.
      const named = jobs.map(
        (job) => `${job.name} (${job.reason ? `${job.reason}, ` : ''}job ${job.id})`,
      );
      lines.push(`Failed jobs: ${named.join(', ')}.`);
      // Где описано задание (N7): CI-конфиг живёт не только в .gitlab-ci.yml — поиск по
      // одному файлу пуст, по всему дереву отбит стражем поиска; git grep по yaml — один вызов.
      lines.push(
        `To find a job's definition: \`git grep -n '${jobs[0]!.name}:' -- '*.yml' '*.yaml'\`.`,
      );
    }
    lines.push(...jobLogLines(input.logs));
  }
  lines.push(
    '',
    ...REVIEW_REPLY_LINES,
    `Finish the delivery as before: commit, push the branch ${input.branch}, the same MR. ` +
      'Before saying "done" again, re-read the MR discussions once more — anything new that ' +
      'arrived during the work is yours too.',
  );
  // Тред ревьюера — блокер, ушедший в MR: из него учится сито (решение
  // владельца 28.09), чтобы следующая группа поймала такое до MR.
  if (input.threads.length > 0) lines.push('', LEARN_SIEVES_LINE);
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

/**
 * Группа ждёт человека из-за красного конвейера своего MR (N3) — наблюдатель смотрит, не
 * позеленел ли он (повтор задания оставляет номер конвейера прежним).
 */
function redWaiting(record: SplitPlanRecord, group: SplitPlanGroupRecord): boolean {
  if (record.proposal.groups[group.index]?.review) return false;
  return Boolean(
    group.status === 'awaiting' &&
    group.waitingFor === 'mr-red' &&
    group.deliver &&
    group.mr &&
    !group.cleaned,
  );
}

/** Круг ожидания красного — `red:<начало ожидания>`; круг «готово» — `doneAt`. */
const RED_CYCLE = 'red:';

function cycleStart(cycle: string): number {
  return Date.parse(cycle.startsWith(RED_CYCLE) ? cycle.slice(RED_CYCLE.length) : cycle);
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
    const cycle = this.cycleOf(record, group);
    if (!cycle) return;
    if (this.timers.get(this.key(record.parentChatId, group.index)) === cycle) return;
    let watch = group.mrWatch;
    if (!watch || watch.cycle !== cycle) {
      // Новый круг: счёт проверок и стоп — заново; переданное (с ссылками и
      // файлами: по ним принимается сито, сданное ходом позже), взгляд на
      // конвейер и потолок продолжений — помним.
      const fresh: SplitMrWatch = { cycle, checks: 0 };
      if (watch?.relayed) fresh.relayed = watch.relayed;
      if (watch?.relayedLinks) fresh.relayedLinks = watch.relayedLinks;
      if (watch?.relayedPaths) fresh.relayedPaths = watch.relayedPaths;
      if (watch?.pipeline) fresh.pipeline = watch.pipeline;
      if (watch?.resumes) fresh.resumes = watch.resumes;
      if (watch?.infraRetried) fresh.infraRetried = watch.infraRetried;
      // Голова «готово» этого круга: по ней конец хода после красного узнаёт «ничего не отправлено».
      if (watch?.head) fresh.head = watch.head;
      // Начало ожидания красного — ключ его круга (F2).
      if (watch?.redSince) fresh.redSince = watch.redSince;
      watch = fresh;
      group.mrWatch = watch;
      this.deps.store.set(record);
    }
    if (watch.stopped) return;
    this.plan(record.parentChatId, group.index, cycle, watch.checks);
  }

  /**
   * Круг наблюдения группы: доставленная — `doneAt`; ждущая человека из-за красного —
   * `red:<redSince>` (запись до F2 без начала — начало ставится сейчас).
   */
  private cycleOf(record: SplitPlanRecord, group: SplitPlanGroupRecord): string | undefined {
    if (watchable(record, group)) return group.doneAt;
    if (!this.deps.settleGreen || !redWaiting(record, group)) return undefined;
    if (!group.mrWatch?.redSince) {
      group.mrWatch ??= { cycle: '', checks: 0 };
      group.mrWatch.redSince = this.now().toISOString();
      this.deps.store.set(record);
    }
    return `${RED_CYCLE}${group.mrWatch.redSince}`;
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
    const delay = Math.max(cycleStart(cycle) + offset - this.now().getTime(), MR_WATCH_MIN_GAP_MS);
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
    if (!record || !group || this.cycleOf(record, group) !== cycle) return undefined;
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
      group.mrClosed = review.state;
      this.deps.store.set(record);
      return;
    }
    if (cycle.startsWith(RED_CYCLE)) {
      this.checkRed(parentChatId, index, cycle, now, review.pipeline);
      return;
    }

    const pipeline = review.pipeline;
    const looked =
      pipeline && FINISHED.has(pipeline.status) && watch.pipeline?.id !== pipeline.id
        ? pipeline
        : undefined;
    let red = looked?.status === 'failed' ? looked : undefined;
    const previous: Previous = {
      relayed: watch.relayed,
      pipeline: watch.pipeline,
      resumes: watch.resumes,
    };
    if (looked) watch.pipeline = { id: looked.id, status: looked.status };

    // Упал раннер, а не код (E3): будить модель незачем — панель повторяет
    // задания сама, один раз; вторая смерть того же задания — заметка человеку.
    let state = now;
    const failed = red;
    // Лог задания читается один раз на проверку: и для суда «машина или код», и для хвоста.
    const traces = new Map<string, Promise<string | undefined>>();
    const jobLog = this.deps.jobLog;
    const read = jobLog
      ? (url: string, jobId: string): Promise<string | undefined> => {
          const known = traces.get(jobId);
          if (known) return known;
          const next = jobLog(url, jobId);
          traces.set(jobId, next);
          return next;
        }
      : undefined;
    let infra = failed ? infraJobs(failed) : undefined;
    if (failed && !infra && read) {
      // Таймаут судится по логу — чтение ждёт сети: взгляд записан до него, круг сверен после.
      this.deps.store.set(record);
      infra = await infraFailures(read, mr, failed, this.deps.log);
      const fresh = this.current(parentChatId, index, cycle);
      if (!fresh) return;
      state = fresh;
    }
    if (failed && infra) {
      const keys = infra.map((job) => `${failed.id}:${job.name}`);
      const retried = state.watch.infraRetried ?? [];
      if (keys.some((key) => retried.includes(key))) {
        this.notifyInfra(parentChatId, 'split-mr-watch-infra-again-notice', group.title, mr, infra);
        red = undefined;
      } else if (this.deps.retryJob) {
        // Повтор оставляет конвейер прежним: взгляд на него не записывается,
        // иначе исход повтора следующая проверка уже не судила бы.
        restoreField(state.watch, 'pipeline', previous.pipeline);
        state.watch.infraRetried = [...retried, ...keys].slice(-MAX_RELAYED);
        this.deps.store.set(state.record);
        const retry = this.deps.retryJob;
        const accepted = await Promise.all(
          infra.map((job) => retry(mr, job.id).catch(() => false)),
        );
        const fresh = this.current(parentChatId, index, cycle);
        if (!fresh) return;
        state = fresh;
        if (accepted.every(Boolean)) {
          this.notifyInfra(
            parentChatId,
            'split-mr-watch-infra-retry-notice',
            group.title,
            mr,
            infra,
          );
          red = undefined;
        } else {
          // Фордж повтор не принял (нет прав, задание уже не повторить) — красный
          // судится как прежде: группа прочтёт логи и скажет человеку.
          restoreField(fresh.watch, 'infraRetried', retried.length > 0 ? retried : undefined);
          fresh.watch.pipeline = { id: failed.id, status: failed.status };
        }
      }
    }

    // Хвост лога упавших заданий (P8) — панель уже читает конвейер, и группе не надо лезть
    // за логом самой (страж форджа такое чтение отбивал). Чтение ждёт сети: перед ним
    // записываем взгляд, после — убеждаемся, что круг всё ещё наш.
    let logs: MrWatchJobLog[] | undefined;
    if (red && read && (red.failedJobs?.length ?? 0) > 0) {
      this.deps.store.set(state.record);
      logs = await failedJobLogs(read, mr, red, this.deps.log);
      const fresh = this.current(parentChatId, index, cycle);
      if (!fresh) return;
      state = fresh;
    }

    const threads = pendingThreads(review, state.watch.relayed ?? []);
    this.relay(parentChatId, index, cycle, state, threads, red, previous, logs);
  }

  /**
   * Проверка ожидания красного (F2): только конвейер. Зелёный — сверка доставки панелью,
   * без хода группы; иначе — следующая проверка. Ветки ревьюера ждут круга «готово».
   */
  private checkRed(
    parentChatId: string,
    index: number,
    cycle: string,
    state: { record: SplitPlanRecord; group: SplitPlanGroupRecord; watch: SplitMrWatch },
    pipeline: MrReviewPipeline | undefined,
  ): void {
    this.deps.store.set(state.record);
    if (pipeline?.status === 'success' && this.deps.settleGreen) {
      if (this.deps.settleGreen(parentChatId, index, pipeline.id)) return;
    }
    this.plan(parentChatId, index, cycle, state.watch.checks);
  }

  /** Заметка в ленту родителя о падении CI на инфраструктуре (E3). */
  private notifyInfra(
    parentChatId: string,
    textCode: 'split-mr-watch-infra-retry-notice' | 'split-mr-watch-infra-again-notice',
    group: string,
    mr: string,
    jobs: readonly MrReviewFailedJob[],
  ): void {
    const params = {
      group,
      mr,
      jobs: jobs.map((job) => `${job.name} (${job.reason ?? '?'})`).join(', '),
    };
    this.deps.log(`mr watch: group «${group}» — CI infrastructure failure: ${params.jobs}`);
    this.deps.notify?.(parentChatId, {
      kind: 'notice',
      code: 'mrWatchInfra',
      text: serverText(textCode, params),
      textCode,
      textParams: params,
    });
  }

  /** Передать группе то, что её ждёт, — или запланировать следующую проверку. */
  private relay(
    parentChatId: string,
    index: number,
    cycle: string,
    state: { record: SplitPlanRecord; group: SplitPlanGroupRecord; watch: SplitMrWatch },
    threads: MrReviewThread[],
    red: MrReviewPipeline | undefined,
    previous: Previous,
    logs?: readonly MrWatchJobLog[],
  ): void {
    const { record, group, watch } = state;
    const mr = group.mr ?? '';
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
    noteRelayed(watch, threads, mr);
    watch.resumes = resumes + 1;
    // Красный передан (N3): конец этого хода с той же головой — не «готово», а человек.
    const redBefore = watch.redRelay;
    if (red) {
      watch.redRelay = {
        pipeline: red.id,
        at: this.now().toISOString(),
        ...(watch.head ? { head: watch.head } : {}),
      };
    }
    this.deps.store.set(record);
    const sent = this.deps.resume(
      parentChatId,
      index,
      mrWatchPrompt({
        branch: group.branch,
        mr,
        threads,
        ...(red ? { red } : {}),
        ...(red && logs?.length ? { logs } : {}),
      }),
    );
    if (sent !== 'refused') return;

    // Продолжить не вышло — ничего не передано: следующая проверка попробует снова.
    const fresh = this.current(parentChatId, index, cycle);
    if (!fresh) return;
    restoreField(fresh.watch, 'relayed', previous.relayed);
    restoreField(fresh.watch, 'pipeline', previous.pipeline);
    restoreField(fresh.watch, 'resumes', previous.resumes);
    restoreField(fresh.watch, 'redRelay', redBefore);
    this.deps.store.set(fresh.record);
    this.plan(parentChatId, index, cycle, fresh.watch.checks);
  }
}
