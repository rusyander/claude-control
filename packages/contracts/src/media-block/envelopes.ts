import type { Deck } from '../media-deck-model.ts';
import { legacyBlockLang } from '../brand.ts';
import { DECK_BLOCK_LANG } from './deck-parse.ts';
import { PICTURE_BLOCK_LANG } from './picture.ts';

/**
 * Конверты просьб: чем ответить и о чём.
 *
 * Сами ПРАВИЛА здесь не переписываются — они живут в каталоге промптов
 * (`prompts/catalog`), единственном месте, где человек их правит. Конверт
 * добавляет к ним то, чего человек не пишет: язык блока, право на один вопрос и
 * прежнюю колоду при правке.
 *
 * Правила приезжают двумя способами, и оба проходят здесь: у агента разговора —
 * внутри того же сообщения, у контура и эндпоинта — системным сообщением, и тогда
 * в конверт передаётся пустая строка (отсюда `trimStart` на выходе).
 *
 * Текст конверта читает только модель, поэтому он английский (владелец
 * 26.09.2026: встроенные промпты — на английском); язык колоды и рисунка задаёт
 * тема человека, об этом говорит строка `IN_TOPIC_LANGUAGE`.
 */

/** Строки конверта, по которым просьбу узнают обратно (`mediaRequestOf`). */
interface EnvelopeMarkers {
  deckAnswer: string;
  deckReviseOpener: string;
  pictureAnswer: string;
  deckTopic: string;
  reviseAsk: string;
  pictureTopic: string;
  reviseKeep: string;
}

const MARKERS: EnvelopeMarkers = {
  deckAnswer: `The finished answer is EXACTLY ONE code block with the language ${DECK_BLOCK_LANG}`,
  deckReviseOpener: 'The deck is already built; its structure is below.',
  pictureAnswer: `The answer is EXACTLY ONE code block with the language ${PICTURE_BLOCK_LANG}`,
  deckTopic: 'Topic: ',
  reviseAsk: 'Request: ',
  pictureTopic: 'Drawing: ',
  reviseKeep: 'Change only what is asked.',
};

/**
 * Конверт до перевода (по 26.09.2026). Им написаны просьбы в уже сохранённых
 * разговорах: без него они снова звались бы первой строкой правил.
 */
const LEGACY_MARKERS: EnvelopeMarkers = {
  deckAnswer: `Готовый ответ — РОВНО ОДИН блок кода с языком ${DECK_BLOCK_LANG}`,
  deckReviseOpener: 'Колода уже собрана — её структура ниже.',
  pictureAnswer: `Ответ — РОВНО ОДИН блок кода с языком ${PICTURE_BLOCK_LANG}`,
  deckTopic: 'Тема: ',
  reviseAsk: 'Просьба: ',
  pictureTopic: 'Рисунок: ',
  reviseKeep: 'Меняй только то, о чём просят.',
};

/**
 * Тот же русский конверт с меткой под прежним именем: просьбы, сохранённые
 * до переименования (14.09–17.09), несут её, и без этого не узнавались (F-329).
 */
const LEGACY_SLUG_MARKERS: EnvelopeMarkers = {
  ...LEGACY_MARKERS,
  deckAnswer: `Готовый ответ — РОВНО ОДИН блок кода с языком ${legacyBlockLang('deck')}`,
  pictureAnswer: `Ответ — РОВНО ОДИН блок кода с языком ${legacyBlockLang('svg')}`,
};

const IN_TOPIC_LANGUAGE =
  'Write all human-readable text in the language of the topic line, whatever language these ' +
  'instructions are in.';

/**
 * Просьба к агенту надиктовать колоду.
 *
 * `canAsk` — это разница между разговором и одиночным запросом, а не настройка:
 * там, где ответить на вопрос некому, вопрос превращается в отказ («модель
 * ответила не колодой»).
 */
export function deckBlockRequest(rules: string, topic: string, canAsk = true): string {
  return [
    rules.trim(),
    '',
    canAsk ? ASK_FIRST : NOBODY_TO_ASK,
    '',
    `${MARKERS.deckAnswer}, containing that JSON. ` +
      'Not a word before or after the block: the panel builds the presentation itself and ' +
      'shows it as a card. ' +
      IN_TOPIC_LANGUAGE,
    '',
    `${MARKERS.deckTopic}${topic.trim()}`,
  ]
    .join('\n')
    .trimStart();
}

/**
 * Дорога агента: спросить есть у кого, и спросить НУЖНО.
 *
 * Владелец 13.09.2026: «пускай агент спрашивает, насколько развёрнуто должно быть,
 * даёт какие-то варианты». Один вопрос дешевле неудачной колоды: человек называет
 * форму словом, а не переделывает двадцать слайдов. Вопрос ровно один и с готовыми
 * вариантами — открытый «а что вы хотите?» вернул бы работу человеку.
 */
const ASK_FIRST =
  'IF the person has not said how detailed the deck should be, first ask ONE short question, in ' +
  'the language of the topic, and wait for the answer; do not output the block in this message. ' +
  'Offer three options in words: full (14–18 slides: sections, diagrams, numbers, comparison, ' +
  'risks, conclusion), medium (8–10 slides: the backbone of the story, two or three diagrams), ' +
  'short (5–6 slides: one claim per slide, almost no lists). Say that they may also name their ' +
  'own slide count, and add one line saying which option you recommend for THIS topic and why. ' +
  'If the shape is already named, ask nothing and build right away.';

/** Дороги контура и эндпоинта: разговора нет, и вопрос ушёл бы в пустоту. */
const NOBODY_TO_ASK =
  'Ask no questions: this is a single request and nobody is there to answer. The person did not ' +
  'name the shape, so take the medium option: 8–10 slides, the backbone of the story, two or ' +
  'three diagrams.';

/**
 * Правка готовой колоды: та же просьба, но со СТРУКТУРОЙ прежней колоды внутри.
 *
 * Владелец 13.09.2026: «агент не потеряется, а будет помнить о том, что он сделал».
 * Помнить нечем — разговор мог быть перезапущен, а колоду собирал вообще контур,
 * поэтому память здесь не у модели, а у панели: структура лежит в записи на диске
 * и уезжает обратно целиком. Ответ тоже ПОЛНЫЙ, а не разница: панель заменяет
 * файлы целиком, и «поправь третий слайд» не должно означать, что остальные
 * тридцать девять надиктованы заново по памяти.
 */
export function deckReviseRequest(rules: string, previous: Deck, instruction: string): string {
  return [
    rules.trim(),
    '',
    `${MARKERS.deckReviseOpener} The person asks to REVISE it, not to make a new one.`,
    '',
    `${MARKERS.reviseAsk}${instruction.trim()}`,
    '',
    `${MARKERS.reviseKeep} Return every other slide VERBATIM, exactly as it came: the panel ` +
      'replaces the files as a whole, and silently rewritten text on a neighbouring slide is ' +
      'something the person discovers only during the talk. Keep the stored fields as well ' +
      '(layouts, diagrams, numbers, sources, the `pictureId` of drawn pictures) — except the ' +
      'ones the request asks to change. Keep the language the deck is written in.',
    '',
    `${MARKERS.deckAnswer}: it holds the WHOLE deck after the revision, not a diff. ` +
      'Not a word before or after the block.',
    '',
    'Previous deck:',
    '```json',
    JSON.stringify(previous, null, 1),
    '```',
  ]
    .join('\n')
    .trimStart();
}

/** То же для рисунка: правила из каталога, конверт и тема. */
export function pictureBlockRequest(rules: string, topic: string): string {
  return [
    rules.trim(),
    '',
    `${MARKERS.pictureAnswer}, containing the \`<svg>\` element itself. ` +
      'Not a word before or after the block: the panel saves the drawing as a file and shows ' +
      'it as a card. ' +
      IN_TOPIC_LANGUAGE,
    '',
    `${MARKERS.pictureTopic}${topic.trim()}`,
  ]
    .join('\n')
    .trimStart();
}

/** Что человек попросил режимом «Презентация» или «Картинка». */
export interface MediaRequestView {
  kind: 'deck' | 'deck-revise' | 'picture';
  /** Слова человека: тема, просьба о правке или описание рисунка. */
  topic: string;
}

/**
 * Узнать просьбу режима в реплике разговора.
 *
 * Реплику пишет панель, а не человек: правила из каталога плюс конверт. В ленте и
 * в названии чата она показывалась целиком, и разговор звался первой строкой
 * правил («Ты собираешь презентацию…»), одинаковой у всех колод. Узнаём её по
 * КОНВЕРТУ — его строки живут здесь, рядом со сборкой, — а не по правилам:
 * правила человек правит в каталоге, и узнавание по ним сломалось бы первой же
 * правкой. Текущий конверт и прежний русский узнаются оба.
 */
export function mediaRequestOf(text: string): MediaRequestView | undefined {
  const body = text.replace(/\r\n/g, '\n');
  return (
    requestBy(body, MARKERS) ??
    requestBy(body, LEGACY_MARKERS) ??
    requestBy(body, LEGACY_SLUG_MARKERS)
  );
}

function requestBy(body: string, markers: EnvelopeMarkers): MediaRequestView | undefined {
  // Слова человека стоят ПОСЛЕ строки конверта: строка правил с тем же началом
  // («Topic:», «Request:») раньше неё, а тема в несколько строк — целиком.
  const after = (marker: string, head: string): string | undefined => {
    const at = body.indexOf(marker);
    if (at < 0) return undefined;
    const line = body.indexOf(`\n${head}`, at + marker.length);
    return line < 0 ? undefined : body.slice(line + 1 + head.length);
  };
  const revise = after(markers.deckReviseOpener, markers.reviseAsk);
  if (revise !== undefined) {
    // Просьба о правке стоит до прежней колоды: до строки, что идёт за ней.
    const end = revise.indexOf(`\n\n${markers.reviseKeep}`);
    const topic = (end < 0 ? revise : revise.slice(0, end)).trim();
    return topic ? { kind: 'deck-revise', topic } : undefined;
  }
  if (body.includes(markers.deckReviseOpener)) return undefined;
  const deck = after(markers.deckAnswer, markers.deckTopic)?.trim();
  if (deck) return { kind: 'deck', topic: deck };
  const picture = after(markers.pictureAnswer, markers.pictureTopic)?.trim();
  if (picture) return { kind: 'picture', topic: picture };
  return undefined;
}
