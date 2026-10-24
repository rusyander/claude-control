import { AUTONOMOUS_PICK_MARKER } from '@agentdeck/contracts/chat-group-settings';
import { GROUP_PLAN_FREE_ANSWER, GROUP_SELF_FIRST_LINE } from '@agentdeck/contracts/task-split';
import type { SplitAutoNotice } from '../../../lib/app-store/app-store.types.ts';
import type { GroupNoticeStore } from '../group-permissions.ts';

/**
 * Вопрос группы разделения под «Развилки группы: по плану» (`groupQuestions:
 * 'plan'`) — ответ панели сразу, без человека (владелец, 23.10).
 *
 * Автовыбор автономии (`pickRecommended`) отвечал только тогда, когда у КАЖДОГО
 * вопроса есть «(Recommended)» в подписи; вопрос «Сессия стенда не обновлена…
 * Когда можно продолжать?» с вариантами «Сессия обновлена — продолжай» / «MR без
 * живой проверки» метки не имел и простоял до клика человека. Здесь ответ есть
 * всегда, на каждый вопрос вызова:
 *
 * - вариант с рекомендацией (подпись или описание, ru/en, в любом месте списка),
 *   а без неё — первый;
 * - такой вариант просит человека сделать что-то или утверждает, что человек
 *   уже сделал, — брать его нельзя (утверждение было бы ложью): берётся первый,
 *   что продолжает работу без человека, а агенту сказано сперва сделать шаг
 *   самому, одной попыткой;
 * - не годится ни один — свободный ответ `GROUP_PLAN_FREE_ANSWER`.
 *
 * Состояния нет: тот же вопрос, заданный снова, получает ответ снова.
 */

interface OptionLike {
  label?: unknown;
  description?: unknown;
}

interface QuestionLike {
  question?: unknown;
  header?: unknown;
  options?: unknown;
}

export interface PlanAnswer {
  question: string;
  /** Что получает агент: подпись варианта или `GROUP_PLAN_FREE_ANSWER`. */
  label: string;
  /** Вопрос помечен заголовком `critical` — выбор сообщается главному чату. */
  critical: boolean;
  /** Ни один вариант не подошёл — ответ свободным текстом. */
  free: boolean;
  /** Рекомендованный (или первый) вариант звал человека: сперва попробовать самому. */
  selfFirst?: string;
}

const RECOMMEND_WORD =
  '(?:recommended|recommend|рекомендую|рекомендуем|рекомендуется|рекомендовано|рекомендован[аоы]?|рекомендуемый)';
/**
 * Отрицание за два слова до рекомендации (F-48): «we don't recommend this»,
 * «not really recommended», «не очень рекомендую» — не метка, а отказ от варианта.
 * Противительный союз обрывает отрицание (RF-EF-01): «Not ideal but recommended»,
 * «Не идеально но рекомендую» — рекомендация, а не отказ.
 */
const NEGATION =
  "(?:(?<![\\p{L}])(?:не|not|never|no)|n't)\\s+(?:(?!(?:but|yet|though|although|however|но|однако|зато|а)(?![\\p{L}']))[\\p{L}']+\\s+){0,2}";
/** Рекомендация: «(Recommended)», «(рекомендую)», «рекомендуется»… — без отрицания. */
const RECOMMENDED = new RegExp(`(?<![\\p{L}])(?<!${NEGATION})${RECOMMEND_WORD}(?![\\p{L}])`, 'iu');
/** Вариант, от которого автор сам отговаривает, — не берётся ни первым, ни запасным. */
const DISCOURAGED = new RegExp(`${NEGATION}${RECOMMEND_WORD}(?![\\p{L}])`, 'iu');
/**
 * Разрушительное (F-48): запасной вариант вместо рекомендованного «для человека»
 * не должен им быть — перезапись ветки, сброс, удаление. Сама команда всё равно
 * идёт через брокер, но ответ панели не должен её предлагать.
 */
const DESTRUCTIVE =
  /force[- ]?push|push\s+(?:-f\b|--force)|reset\s+--hard|rm\s+-rf|drop\s+(?:table|database)|\b(?:delete|wipe|discard|overwrite|erase)\b|(?<![\p{L}])(?:удал\p{L}*|снест\p{L}*|снести|затер\p{L}*|перезапис\p{L}*|сброс\p{L}*)/iu;

const CRITICAL = /^\s*\[?critical\]?\s*$/i;

/**
 * Действие человека: подпись — реплика ЧЕЛОВЕКА агенту, поэтому первое лицо
 * («войду», «я обновил», «I'll log in») и утверждение о сделанном («сессия
 * обновлена», «logged in», «done») значат «это делает или сделал человек».
 * Повелительное агенту («перелогинься», «log in with the project account») —
 * действие агента и сюда не попадает.
 */
const HUMAN_ACTION_RU =
  /(?<![\p{L}])(?<!(?:не|без)\s)(?:я|мы|(?:за|пере)?логин(?:ил|юсь|усь)\p{L}*|авторизовал\p{L}*|вош[её]л|вошла|вошли|войду|зайду|заш[её]л|зашла|обновил\p{L}*|обновлю|перезапустил\p{L}*|запустил\p{L}*|запущу|сделал\p{L}*|сделаю|подтверждаю|подтвердил\p{L}*|пришлю|прислал\p{L}*|выдам|выдал\p{L}*|дам|дал[аи]?|добавлю|настрою|настроил\p{L}*|проверю|исправлю|поправлю|подожд\p{L}*|жди|ждать|жду|вручную|руками|готово)(?![\p{L}])/iu;

const HUMAN_ACTION_EN =
  /\b(?:we'(?:ll|ve)|me|my|myself|logged\s+in|signed\s+in|re-?logged|wait\s+for\s+me|manually|by\s+hand|done|(?:is|are|was|were|been|has\s+been|have\s+been)\s+(?:updated|refreshed|renewed|fixed|restarted|done)|already\s+(?:ran|run|did|done|logged|signed|updated|refreshed|restarted))\b/i;
/**
 * «I» одно — только заглавной (F-48): под флагом `i` оно ловило «i.e.» и номер
 * пункта «Option i:». Сокращения «i'll / i've / i'm / i'd» — первое лицо в любом
 * регистре: другого прочтения у них нет.
 */
const HUMAN_ACTION_EN_CASED = /\bI(?:['’](?:ll|ve|m|d))?(?![\w/.])|\bi['’](?:ll|ve|m|d)\b/;

/** То, что есть только у человека: вход, ключи, доступы, стенд (RF-EF-01). */
const HUMAN_RESOURCE =
  '(?:sessions?|logins?|tokens?|credentials|creds|cookies?|passwords?|keys?|secrets?|access|permissions?|auth|accounts?|vpn|stand|certs?|certificates?|2fa|mfa|otp|licen[cs]es?|quotas?' +
  '|сесси\\p{L}*|логин\\p{L}*|токен\\p{L}*|ключ\\p{L}*|парол\\p{L}*|доступ\\p{L}*|прав[аоы]?|куки|секрет\\p{L}*|уч[её]тк\\p{L}*|аккаунт\\p{L}*|стенд\\p{L}*|сертификат\\p{L}*|лицензи\\p{L}*|квот\\p{L}*)';
/** Состояние «сделано»: английское причастие, русское — только краткое («обновлена», не «обновлённым»). */
const HUMAN_STATE =
  '(?:updated|refreshed|renewed|restarted|fixed|rotated|granted|restored|reset|reissued|extended|unlocked' +
  '|(?:обновл[её]н|перезапущен|исправлен|выдан|продл[её]н|восстановлен|сброшен|разблокирован)[аоы]?)';
/**
 * Утверждение о сделанном человеком без связки (F-48, RF-EF-01): «Session
 * refreshed — continue», «Токен доступа обновлён». Форма «<что-то> <причастие>»
 * сама по себе — не утверждение: «Mark as fixed», «Continue with dependencies
 * updated», «Keep the snapshot updated» — работа агента, и по ней автовыбор
 * отвечал «Revert the change». Поэтому: (1) подлежащее — то, что есть только у
 * человека (`HUMAN_RESOURCE`), (2) оно стоит в начале фразы — перед ним самое
 * большее одно определение («API key», «The token»), но не глагол-повеление
 * («Keep session refreshed»), (3) до причастия — не больше двух слов и ни одного
 * отрицания («Сессия не обновлена» — не утверждение).
 */
const HUMAN_CLAIMED_STATE = new RegExp(
  '(?:^|[\\n—–:;,.!?(]|\\s-\\s)\\s*(?:(?!(?:keep|mark|leave|make|get|set|treat|consider|have|use|with|without|оставь\\p{L}*|остав\\p{L}*|пометь\\p{L}*|помет\\p{L}*|сделай\\p{L}*|используй\\p{L}*|использ\\p{L}*)(?![\\p{L}]))[\\p{L}\\d-]+\\s+)?' +
    `${HUMAN_RESOURCE}(?:\\s+(?!(?:not|no|never|yet|не|без|ещё|еще)(?![\\p{L}]))[\\p{L}\\d:-]+){0,2}\\s+${HUMAN_STATE}(?![\\p{L}])`,
  'iu',
);

function textOf(option: OptionLike): string {
  const label = typeof option.label === 'string' ? option.label : '';
  const description = typeof option.description === 'string' ? option.description : '';
  return `${label}\n${description}`;
}

/** Просит ли вариант действия человека или утверждает сделанное им. */
export function needsHuman(option: OptionLike): boolean {
  const text = textOf(option);
  return (
    HUMAN_ACTION_RU.test(text) ||
    HUMAN_ACTION_EN.test(text) ||
    HUMAN_ACTION_EN_CASED.test(text) ||
    HUMAN_CLAIMED_STATE.test(text)
  );
}

function discouraged(option: OptionLike): boolean {
  return DISCOURAGED.test(textOf(option));
}

/** Рекомендованный вариант: сперва по подписи, потом по описанию; нет — `-1`. */
export function recommendedIndex(options: readonly OptionLike[]): number {
  const byLabel = options.findIndex(
    (option) => typeof option.label === 'string' && RECOMMENDED.test(option.label),
  );
  if (byLabel >= 0) return byLabel;
  return options.findIndex(
    (option) => typeof option.description === 'string' && RECOMMENDED.test(option.description),
  );
}

/** Ответ на один вопрос вызова. */
export function planAnswerFor(raw: QuestionLike): PlanAnswer {
  const question = typeof raw.question === 'string' ? raw.question : '';
  const critical = typeof raw.header === 'string' && CRITICAL.test(raw.header);
  const options = (Array.isArray(raw.options) ? raw.options : []).filter(
    (option): option is OptionLike =>
      Boolean(option) && typeof (option as OptionLike).label === 'string',
  );
  const free = (selfFirst?: string): PlanAnswer => ({
    question,
    label: GROUP_PLAN_FREE_ANSWER,
    critical,
    free: true,
    ...(selfFirst ? { selfFirst } : {}),
  });
  if (options.length === 0) return free();
  const marked = recommendedIndex(options);
  // Без метки — первый, от которого автор не отговаривает (F-48).
  const preferred = (options[marked] ??
    options.find((option) => !discouraged(option)) ??
    options[0]) as OptionLike;
  const label = (option: OptionLike): string => String(option.label);
  if (!needsHuman(preferred)) return { question, label: label(preferred), critical, free: false };
  const fallback = options.find(
    (option) =>
      option !== preferred &&
      !needsHuman(option) &&
      !discouraged(option) &&
      !DESTRUCTIVE.test(textOf(option)),
  );
  if (!fallback) return free(label(preferred));
  return {
    question,
    label: label(fallback),
    critical,
    free: false,
    selfFirst: label(preferred),
  };
}

/** Ответы на все вопросы вызова `AskUserQuestion`; вопросов нет — `null`. */
export function planAnswers(input: unknown): PlanAnswer[] | null {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  return (questions as QuestionLike[]).map((raw) => planAnswerFor(raw ?? {}));
}

/**
 * Отказ брокера с ответами — результат вызова для модели. Метка и строки
 * `- "<вопрос>" → "<ответ>"` — те же, что у автовыбора автономии: по ним лента
 * рисует строку на месте вопроса, реестр снимает «ждёт человека», сводка
 * ожиданий считает вопрос закрытым (`auto-pick.ts`, `transcript-tail.ts`).
 * Строки «For …» разбор пропускает — они только для модели.
 */
export function planAnswerMessage(answers: readonly PlanAnswer[]): string {
  const lines = answers.map(
    (answer) => `- ${JSON.stringify(answer.question)} → ${JSON.stringify(answer.label)}`,
  );
  const selfFirst = answers.flatMap((answer) =>
    answer.selfFirst
      ? [
          `For ${JSON.stringify(answer.question)}: the option ${JSON.stringify(answer.selfFirst)} ` +
            'needs the human, who will not act. If you can take that step yourself, do it first and ' +
            `then continue as that option says; otherwise take the answer above. ${GROUP_SELF_FIRST_LINE}`,
        ]
      : [],
  );
  return [
    `${AUTONOMOUS_PICK_MARKER}: this split group decides its forks by plan — the human does not ` +
      'answer its questions, the panel answered them right away. Take these answers, record each ' +
      'decision and its reason in the MR description and continue; do not ask the same again:',
    ...lines,
    ...selfFirst,
  ].join('\n');
}

/** Сколько отметок держит группа — тот же предел, что у разрешений «с отметкой». */
const AUTO_NOTICES_MAX = 20;
const SUMMARY_MAX = 160;

/**
 * Отметка «ответ дан автоматически» в записи разделения — рядом с отметками
 * разрешений «с отметкой»: хаб открывают позже, чем прошёл вопрос, и человек
 * обязан видеть, что за него ответили. `kind: 'answer'` отличает её от
 * разрешения; `free` — ответ свободным текстом, а не вариантом.
 */
export function recordGroupAnswerNotice(
  store: GroupNoticeStore,
  group: { parentChatId: string; groupIndex: number },
  answers: readonly PlanAnswer[],
  now: () => Date = () => new Date(),
): void {
  const plan = store.getSplitPlan(group.parentChatId);
  const target = plan?.groups.find((entry) => entry.index === group.groupIndex);
  if (!plan || !target) return;
  const at = now().toISOString();
  const notices: SplitAutoNotice[] = answers.map((answer) => ({
    at,
    summary: cut(answer.label),
    kind: 'answer',
    ...(answer.free ? { free: true } : {}),
  }));
  // Окно — своё у ответов (F-46): двадцать автоответов вытесняли отметки
  // разрешений, которые человек обязан видеть. Разрешения держит их запись.
  const merged = [...(target.autoNotices ?? []), ...notices];
  const kept = new Set(
    merged.filter((notice) => notice.kind === 'answer').slice(-AUTO_NOTICES_MAX),
  );
  target.autoNotices = merged.filter((notice) => notice.kind !== 'answer' || kept.has(notice));
  store.setSplitPlan(plan);
}

function cut(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}
