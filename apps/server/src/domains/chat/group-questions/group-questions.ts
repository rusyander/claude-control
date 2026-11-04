/**
 * Эвристики варианта вопроса `AskUserQuestion`: рекомендован ли он (метка в
 * подписи или описании, ru/en, без отрицания) и зовёт ли он человека или
 * утверждает сделанное им. Читает их разбор прежнего автовыбора
 * (`auto-pick.ts`) — лента прежних транскриптов. Ответ группы «по плану»
 * (`planAnswers`) снят 02.11.2026: развилки групп решает ядро.
 */

interface OptionLike {
  label?: unknown;
  description?: unknown;
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
