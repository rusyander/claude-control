import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { withoutDeferredWaitLines } from '@agentdeck/contracts/deferred-asks';
import { endsWithQuestion } from '../../chat/chain-outcome/chain-outcome.ts';

/**
 * Чтение итога хода для карточки Telegram: закрыта ли задача, ждёт ли агент
 * решения и какими словами это сказать человеку.
 *
 * Слова, а не разметка: в карточку идут одна-две фразы, без блоков кода,
 * таблиц, ссылок и стандартной строки «/clear, затем „продолжай по PROGRESS.md“»
 * — её владелец видит в чате, в телефоне она только съедает место.
 */

/** Предел итога закрытой задачи в карточке. */
export const SUMMARY_LIMIT = 220;
/** Предел того, что решить. */
export const ASK_LIMIT = 300;
/** Вариантов в карточке не больше — остальное в чате. */
export const OPTIONS_MAX = 5;
const OPTION_LIMIT = 60;
/** Вопросов в «Нужно решить» не больше — остальные названы числом. */
const QUESTIONS_MAX = 3;

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** Текст без блоков кода — вопрос внутри кода не вопрос человеку. Маска — до всякой обрезки. */
function proseOf(text: string): string {
  return maskSecretsInText(text)
    .replace(/```[\s\S]*?(```|$)/g, '')
    .trim();
}

const paragraphsOf = (body: string): string[] =>
  body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

/** Пункт списка: «- …», «* …», «1. …», «2) …». */
const LIST_ITEM = /^([-*•]|\d+[.)])\s+/;
/** Адрес без знака препинания за ним: точка конца фразы остаётся фразе. */
const URL = /https?:\/\/[^\s`<>()[\]«»"']*[^\s`<>()[\]«»"'.,;:!?]/g;

/** Разметка Markdown — словами: ссылки до подписи, адреса и выделение прочь. */
function plainOf(text: string): string {
  return (
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(URL, '')
      .replace(/^\s*(#{1,6}|>)\s*/, '')
      .replace(LIST_ITEM, '')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\(\s*\)/g, '')
      // «MR !12» — не восклицание: пробел перед «!» с буквой или цифрой за ним остаётся.
      .replace(/\s+([,.;:?]|!(?![\p{L}\d]))/gu, '$1')
      .replace(/\s+/g, ' ')
      // Адрес в конце фразы унёс за собой текст: «создан: <адрес>.» → «создан.»
      .replace(/[,:;]+([.!?])$/, '$1')
      .trim()
  );
}

/**
 * Фразы абзаца: конец фразы — точка, «!» или «?» и пробел, или перевод строки.
 * Многоточие фразу не кончает: «`a.exe` … `b.exe`?» — один вопрос.
 */
function sentencesOf(paragraph: string): string[] {
  return paragraph
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map(plainOf)
    .filter(Boolean);
}

/**
 * Подлежащее заявления о закрытии: сама задача, а не её часть. «Зона API
 * закрыта», «Фаза 2 закрыта», «Этап закрыт» — шаг внутри задачи, агент ещё не
 * свободен (выборка 28–30.10: такие концы приходили «ГОТОВО» десятками).
 */
const SUBJECT =
  /^(?:(?:вся|все|эта|эти|текущая|основная|исходная|наша|моя|ваша|твоя|итоговая|сама)\s+)?(?:задача|задачи|задание|задания|работа|тикет)(?!\p{L})(.{0,80}?)\s(?:закрыт|выполнен|завершен|завершён|сделан|доделан|готов)(?:а|о|ы)?(?!\p{L})(.*)$/iu;
/** Часть задачи между подлежащим и сказуемым: «задача агента», «работа зоны». */
const PART_OF_TASK =
  /(?<!\p{L})(зон|фаз|этап|шаг|стади|подзадач|волн|раунд|итераци|агент|субагент|групп|звен|ревью|прогон|мутант)\p{L}*/iu;
/** Не закрыта, будет закрыта, почти закрыта. */
const NOT_YET =
  /(?<!\p{L})(не|ещё|еще|пока|будет|будут|станет|почти|можно|нельзя|осталось)(?!\p{L})/iu;
/** Закрыта не полностью, частично, на 80 %, кроме … */
const PARTLY = /^\s*[,:—–-]?\s*(не\s|частично|наполовину|на\s+\d|почти|кроме|за исключением)/iu;
/** Имя задачи в кавычках — её название, а не «часть»: «Задача «сторож групп» закрыта». */
const QUOTED = /«[^»]*»|"[^"]*"|“[^”]*”/g;
const SUBJECT_EN =
  /^(?:the\s+|this\s+|all\s+)?(?:task|tasks|work|ticket)\b(.{0,60}?)\b(?:done|closed|complete|completed|finished)\b(.*)$/i;
const NOT_YET_EN = /\b(not|almost|nearly|will|partly|partially|once)\b/i;

/** Фраза заявляет, что задача закрыта целиком. Вопрос — не заявление. */
export function claimsClosed(sentence: string): boolean {
  const text = sentence.replace(/^[-*•>\s]+/, '').trim();
  if (!text || text.endsWith('?')) return false;
  const ru = SUBJECT.exec(text);
  if (ru) {
    const [, rawMiddle = '', rest = ''] = ru;
    const middle = rawMiddle.replace(QUOTED, '');
    return !NOT_YET.test(middle) && !PART_OF_TASK.test(middle) && !PARTLY.test(rest);
  }
  if (/^all\s+done\b/i.test(text)) return true;
  const en = SUBJECT_EN.exec(text);
  if (!en) return false;
  const [, middle = '', rest = ''] = en;
  return !NOT_YET_EN.test(middle) && !/^\s*[,:]?\s*(except|but|partly)\b/i.test(rest);
}

/**
 * Ответ говорит «задача закрыта». Ищется в первом абзаце (так агенту велено
 * начинать ответ о конце задачи) и в последнем (итог после отчёта); середина —
 * перечни и цитаты, где «закрыта» относится к чему-то другому.
 */
export function closedClaim(answer: string): boolean {
  const paragraphs = paragraphsOf(proseOf(answer));
  const edges = [paragraphs[0], paragraphs.at(-1)].filter(
    (paragraph): paragraph is string => paragraph !== undefined,
  );
  return edges.some((paragraph) => sentencesOf(paragraph).some(claimsClosed));
}

/** Стандартная строка о чистой сессии — человеку в телефоне она ничего не говорит. */
const BOILERPLATE = /\/clear|продолжай по|PROGRESS\.md|чист(ого|ой)\s+(листа|сессии)/i;
/** Голое «задача закрыта»: заголовок карточки уже это сказал. */
const BARE_CLOSED =
  /^(?:вся\s+|эта\s+)?(?:задача|работа|задание)\s+(?:закрыта|выполнена|завершена|готова|сделана)[.!]?$/iu;

/**
 * Фраза без стандартной строки. В фразе о /clear остаётся только заявление о
 * закрытии, если оно в ней первое: «Задача T1 закрыта, теперь можно /clear…» →
 * «Задача T1 закрыта.»; «Чтобы продолжить, после /clear напишите…» — пусто.
 * Голое «Задача закрыта» — пусто: это уже сказал заголовок.
 */
function withoutBoilerplate(sentence: string): string {
  let kept = sentence.trim();
  if (BOILERPLATE.test(kept)) {
    const first = kept.split(/\s*[,:;—–]\s+|\s+-\s+/)[0] ?? '';
    kept =
      !BOILERPLATE.test(first) && claimsClosed(first) ? `${first.replace(/[.,;:]+$/, '')}.` : '';
  }
  return BARE_CLOSED.test(kept) ? '' : kept;
}

/**
 * Одна-две фразы итога: что было сделано. Берутся с начала ответа, без
 * стандартной строки о /clear и без голого «задача закрыта».
 */
export function summaryOf(answer: string): string {
  const picked: string[] = [];
  for (const paragraph of paragraphsOf(proseOf(answer))) {
    for (const sentence of sentencesOf(paragraph)) {
      const kept = withoutBoilerplate(sentence);
      // Заголовок раздела в одно-два слова («Итог», «Что сделано:») — не фраза итога.
      if (!kept || kept.split(/\s+/).length < 3) continue;
      // Фраза перед перечнем кончается двоеточием — в карточке перечня нет.
      picked.push(kept.replace(/:$/, '.'));
      if (picked.length === 2) break;
    }
    if (picked.length === 2) break;
  }
  const [first = '', second] = picked;
  if (!first) return '';
  const both = second ? `${first} ${second}` : first;
  return both.length <= SUMMARY_LIMIT ? both : clip(first, SUMMARY_LIMIT);
}

/** «После «да» соберу MR», «скажи «да»» — ожидание ответа без вопросительного знака. */
const AFTER_YES =
  /(?<!\p{L})(после|скажи|скажите|ответь|ответьте|напиши|напишите)\s+(?:(?:ваш\p{L}*|тво\p{L}*)\s+)?[«"„]?(да|ок|ok)[»"“]?(?!\p{L})/iu;
/**
 * Ожидание словами в последнем абзаце: «жду вашего ответа», «ждёт вашего
 * «да»», «после вашего ответа», «нужно ваше решение», «шаг за вами». Условие
 * («если жду ответа, пишу в Telegram») — рассказ о правиле, а не ожидание.
 */
const WAITS_AT_END = [
  /(?<!\p{L})(жду|ожидаю|дождусь|подожду|ждёт|ждет|ждут)\s+(?:(?:ваш\p{L}*|тво\p{L}*)\s+)?(ответ|решени|выбор|подтверждени|указани|отмашк|соглас|разрешени|«да»|"да")/iu,
  /(?<!\p{L})(ждёт|ждет|жду),?\s+пока\s+(вы|ты)(?!\p{L})/iu,
  /(?<!\p{L})после\s+(?:ваш\p{L}*|тво\p{L}*)\s+(ответ|решени|подтверждени|выбор|отмашк|соглас|разрешени)/iu,
  /(?<!\p{L})(нужн\p{L}*|требуется|необходим\p{L}*)\s+(ваш\p{L}*|тво\p{L}*)\s+(решени|ответ|выбор|подтверждени|соглас|разрешени)/iu,
  /(?<!\p{L})(он|она|оно|шаг|решение|выбор|слово)\s+за\s+(вами|тобой)(?!\p{L})/iu,
  /^(подтверди|подтвердите|выбери|выберите|ответь|ответьте|разреши|разрешите)(?!\p{L})/iu,
  /\b(waiting|wait)\s+(for|on)\s+(your|you)\b|\bawaiting\s+your\b/i,
  /\b(need|needs|require|requires)\s+your\s+(decision|answer|input|confirmation|choice)\b/i,
];
const CONDITIONAL = /(?<!\p{L})(если|при необходимости|при желании|if)(?!\p{L})/iu;
/** Пояснение к вопросу, а не новый рассказ: «Рекомендую да», «Если нет — …». */
const ANSWER_HINT =
  /(?<!\p{L})(рекоменд\p{L}*|предлага\p{L}*|по умолчанию|если да|если нет|иначе)|\b(recommend|default|if yes|if no)\b/iu;

/**
 * Абзац без фраз-условий: «если жду вашего ответа, пишу в Telegram» — рассказ о
 * правиле, а правило групп (`endsWithQuestion`) условия не видит. Вопрос с
 * условием («Если да — пушить?») остаётся вопросом.
 */
const unconditional = (paragraph: string): string =>
  paragraph
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !CONDITIONAL.test(sentence) || sentence.includes('?'))
        .join(' '),
    )
    .filter((line) => line.trim())
    .join('\n');

const waitSentence = (sentence: string): boolean =>
  WAITS_AT_END.some((pattern) => pattern.test(sentence)) && !CONDITIONAL.test(sentence);

/**
 * Вопрос в последнем абзаце не на конце строки: «Согласен …? После «да» …».
 * Правило групп (`endsWithQuestion`) смотрит только концы строк — так ему и
 * надо, там вопрос в середине часто риторический. Здесь вопрос засчитан, если
 * за ним идут только пояснения к ответу; «Почему? Потому что…» не засчитан.
 */
function asksMidParagraph(sentences: readonly string[]): boolean {
  return sentences.some(
    (sentence, index) =>
      isQuestion(sentence) &&
      sentence.split(/\s+/).length >= 3 &&
      sentences.slice(index + 1).every((after) => ANSWER_HINT.test(after) || AFTER_YES.test(after)),
  );
}

/**
 * Ход кончился тем, что агент ждёт решения человека: вопрос в конце (то же
 * правило, что у групп), ожидание словами или «после «да»» в последнем абзаце.
 * «Жду ответа» в середине отчёта не считается: там это пересказ («если жду
 * твоего ответа, сразу пишу в Telegram»), а не просьба.
 */
export function waitsInText(answer: string): boolean {
  const text = withoutDeferredWaitLines(answer);
  if (!text.trim()) return false;
  const paragraphs = paragraphsOf(proseOf(text));
  if (
    endsWithQuestion(
      [...paragraphs.slice(0, -1), unconditional(paragraphs.at(-1) ?? '')].join('\n\n'),
    )
  ) {
    return true;
  }
  const sentences = sentencesOf(paragraphs.at(-1) ?? '');
  return (
    sentences.some((sentence) => waitSentence(sentence) || AFTER_YES.test(sentence)) ||
    asksMidParagraph(sentences)
  );
}

const isQuestion = (sentence: string): boolean => /\?[»"')\]]*$/.test(sentence);

/** Пункты списка абзаца — без маркеров. */
function listItems(paragraph: string): string[] {
  return paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => LIST_ITEM.test(line))
    .map(plainOf)
    .filter(Boolean);
}

/** Абзац целиком — перечень (строка с двоеточием над ним не в счёт). */
function isList(paragraph: string): boolean {
  const lines = paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines[0]?.endsWith(':') ? lines.slice(1) : lines;
  return body.length > 0 && body.every((line) => LIST_ITEM.test(line));
}

/** Вопросы одним текстом: первые три, остальные — числом. */
function questionsText(questions: readonly string[]): string {
  const shown = questions.slice(0, QUESTIONS_MAX).join(' ');
  const more = questions.length - QUESTIONS_MAX;
  return more > 0 ? `${shown} И ещё ${more} в чате.` : shown;
}

/**
 * Что решить и из чего выбирать.
 *
 * Вопросы — из последнего абзаца, где они есть (не дальше трёх с конца): отчёт
 * бывает и после вопроса. Нет вопросов — фраза-ожидание («Подтвердите коммит.»,
 * «жду ответа на вопрос в карточке»), иначе последняя фраза. Варианты — только
 * перечень без вопросов прямо под вопросом; перечень вопросов («4. … Исправить
 * сейчас?») — сами вопросы, перечень сделанного — не варианты.
 */
export function askOf(answer: string): { ask: string; options: string[] } {
  const paragraphs = paragraphsOf(proseOf(withoutDeferredWaitLines(answer)));
  const recent = paragraphs.slice(-3).reverse();
  for (const [index, paragraph] of recent.entries()) {
    const questions = sentencesOf(paragraph).filter(isQuestion);
    if (questions.length === 0) continue;
    const below = index > 0 ? recent[index - 1] : undefined;
    const items = below && isList(below) ? listItems(below) : [];
    const options = items.some((item) => item.includes('?')) ? [] : items;
    // Варианты тем же абзацем — только строки списка ПОСЛЕ строки с вопросом.
    const lines = paragraph.split('\n');
    const asked = lines.findLastIndex((line) => !LIST_ITEM.test(line.trim()) && line.includes('?'));
    const inline = asked < 0 ? [] : listItems(lines.slice(asked + 1).join('\n'));
    return {
      ask: clip(questionsText(questions), ASK_LIMIT),
      options: (options.length > 0 ? options : inline)
        .slice(0, OPTIONS_MAX)
        .map((option) => clip(option, OPTION_LIMIT)),
    };
  }
  const waits = (sentence: string): boolean => waitSentence(sentence) || AFTER_YES.test(sentence);
  const at = paragraphs.findLastIndex((paragraph) => sentencesOf(paragraph).some(waits));
  if (at < 0)
    return { ask: clip(paragraphs.flatMap(sentencesOf).at(-1) ?? '', ASK_LIMIT), options: [] };
  const wait = sentencesOf(paragraphs[at] ?? '').findLast(waits) ?? '';
  // «Нужно ваше решение:» и перечень под ним — перечень и есть что решить.
  const next = paragraphs[at + 1];
  const items = wait.endsWith(':')
    ? [...listItems(paragraphs[at] ?? ''), ...(next && isList(next) ? listItems(next) : [])]
    : [];
  return {
    ask: clip(wait.replace(/:$/, '.'), ASK_LIMIT),
    options: items.slice(0, OPTIONS_MAX).map((item) => clip(item, OPTION_LIMIT)),
  };
}

/** Вопрос инструментом — его же словами; маска — как у текста. */
export function askOfTool(
  question: string,
  options: readonly string[] = [],
): { ask: string; options: string[] } {
  return {
    ask: clip(plainOf(maskSecretsInText(question)), ASK_LIMIT),
    options: options
      .slice(0, OPTIONS_MAX)
      .map((option) => clip(plainOf(maskSecretsInText(option)), OPTION_LIMIT))
      .filter(Boolean),
  };
}
