/**
 * Метки защиты данных внутри собранного вызова (Р11, Т5.7).
 *
 * Через контур аргументы инструмента едут дважды замаскированными. Первой
 * ложится НАША обратимая маска (`dlp/mask.ts`): наверх уходит `[ИМЯ_1]`, а не
 * фамилия. Второй — маска САМОГО контура, если его санитайзер всё-таки нашёл
 * что-то своё; её карту он присылает вендорным кадром.
 *
 * Порядок разворота обратный и он важен: карта контура разворачивается ЗДЕСЬ,
 * до синтеза `tool_use`, а наши метки — уже за границей шлюза, обратной
 * подстановкой в кадрах клиента. Свернуть оба разворота в один нельзя: карта
 * контура живёт ровно один ответ и до клиента не доезжает вовсе.
 *
 * Почему это не «заодно проверим текст»: текст с неразвёрнутой меткой человек
 * прочитает и поймёт, а `Write` с меткой вместо адреса в аргументе ЗАПИШЕТ её в
 * файл — и найдёт это человек через неделю, в чужой почте вместо своей.
 */

/**
 * Форма нашей метки: `[ИМЯ_1]`, `[ИМЯ_1.2]` (вторая форма того же лица).
 * Собрана по `mask.ts` `placeholderFor`; разойтись они не могут молча —
 * круговой тест в `aliases.test.ts` минтит метку настоящим хранилищем.
 */
const ALIAS = /\[([\p{L}\d_]+)_\d+(?:\.\d+)?\]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Пройти по строковым листьям аргументов, сохранив их форму. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}

/**
 * Развернуть карту контура в аргументах вызова.
 *
 * Замена идёт ТОЛЬКО «ключ → значение». Обратное направление выглядит
 * симметричным и было бы катастрофой: не найдя ключа, мы бы принялись
 * маскировать в аргументах то, что контур уже развернул, — и в файл уехала бы
 * метка вместо значения, ровно то, от чего эта проверка и заведена.
 */
export function expandContourAliases(
  args: Record<string, unknown>,
  map: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (map.size === 0) return args;
  const expanded = mapStrings(args, (text) => {
    let out = text;
    for (const [alias, value] of map) {
      if (alias && out.includes(alias)) out = out.split(alias).join(value);
    }
    return out;
  });
  return isRecord(expanded) ? expanded : args;
}

/**
 * Метки, которые в аргументах есть, а развернуть их нечем.
 *
 * Спрашивается только про НАШИ метки, и только про те, чей вид панель в этом
 * запросе действительно выдавала: `[ИМЯ_7]` при выданном `[ИМЯ_1]` — это
 * искажённая моделью метка, а `[TODO_1]` в тексте файла — просто текст, и
 * останавливать из-за него ход значило бы ломать работу там, где всё цело.
 * Словарь пуст (защита выключена) — останавливать нечего и не из-за чего.
 */
export function strayAliases(
  args: Record<string, unknown>,
  known: ReadonlyMap<string, string>,
): string[] {
  if (known.size === 0) return [];

  const labels = new Set<string>();
  for (const alias of known.keys()) {
    const match = new RegExp(ALIAS.source, 'u').exec(alias);
    if (match?.[1]) labels.add(match[1]);
  }
  if (labels.size === 0) return [];

  const stray: string[] = [];
  mapStrings(args, (text) => {
    for (const match of text.matchAll(ALIAS)) {
      const token = match[0];
      if (!labels.has(match[1] ?? '')) continue;
      if (known.has(token)) continue;
      if (!stray.includes(token)) stray.push(token);
    }
    return text;
  });
  return stray;
}
