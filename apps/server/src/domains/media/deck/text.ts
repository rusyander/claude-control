/**
 * Текст колоды перед укладкой в файл.
 *
 * Колоду пишет модель, а открывают её PowerPoint и браузер. Контракт следит за
 * ДЛИНОЙ строк и ничего не делает со знаками внутри, поэтому управляющий символ
 * из ответа модели доезжает до отрисовщика как есть. В HTML это в худшем случае
 * невидимая грязь, а в OOXML — сломанный XML: PowerPoint отвечает на такой файл
 * словом «восстановить», из которого человек перед залом не узнает ничего.
 *
 * Отсюда одна общая чистка на оба отрисовщика: то, что нельзя записать в XML
 * 1.0, не попадает и на страницу — иначе HTML и PPTX показывали бы разный текст.
 *
 * Выражения собраны конструктором из escape-последовательностей нарочно: в
 * исходнике не должно быть невидимых знаков, иначе правка этой строки вслепую
 * ломает чистку.
 */

// eslint-disable-next-line no-control-regex -- управляющие знаки здесь и есть предмет чистки
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
/** Непечатные точки, которые XML 1.0 запрещает прямо. */
const NONCHARS = new RegExp('[\\uFFFE\\uFFFF]', 'g');
/** Половинка суррогатной пары без второй половины — в XML такой знак не записать. */
const LONE_SURROGATE = new RegExp(
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g',
);
/** Знак «здесь был непечатный знак». */
const REPLACEMENT = '�';

/**
 * Строка, которую можно положить и в разметку, и в OOXML. Только чистка знаков:
 * ни обрезки по длине (её держит контракт), ни экранирования (оно у формата
 * своё).
 */
export function deckText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(NONCHARS, '')
    .replace(LONE_SURROGATE, REPLACEMENT);
}

/** Есть ли что показывать: пустое и из одних пробелов — это «нет». */
export function hasText(value: unknown): boolean {
  return deckText(value).trim().length > 0;
}

/** Чистый и подрезанный по краям текст. */
export function deckLine(value: unknown): string {
  return deckText(value).trim();
}

/** Непустые строки списка, по порядку. */
export function deckLines(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((item) => deckLine(item)).filter((item) => item.length > 0);
}
