/**
 * Замена по потоку: обратная подстановка в ответе модели.
 *
 * Ответ приходит кусками, и заменяемая метка (`⟦ИМЯ_1⟧`) запросто разрывается
 * между двумя кусками — это главная ловушка обратной подстановки. Наивная
 * замена «кусок за куском» такую метку пропустит, и наружу уйдёт `⟦ИМЯ_` в
 * одном фрагменте и `1⟧` в следующем.
 *
 * Здесь замена ТОЧНАЯ: результат не зависит от того, как поток нарезан, и
 * побайтово совпадает с заменой в целом тексте. Достигается это удержанием
 * хвоста: пока конец накопленного текста может оказаться началом метки, этот
 * хвост не отдаётся. Длина удержания ограничена самой длинной меткой минус
 * один символ — задержка в десяток символов, невидимая на глаз.
 *
 * Модуль чистый: ни сети, ни SSE, ни знания о формате API. Разбор кадров живёт
 * отдельно (`sse.ts`), а сюда приходит уже голый текст.
 */

export interface StreamReplacer {
  /** Отдать очередной кусок; возвращает то, что уже безопасно выпустить. */
  push(chunk: string): string;
  /** Конец потока: выпустить удержанный хвост. */
  flush(): string;
}

/**
 * Замена в целом тексте — эталон, с которым обязан совпадать поток. Правило
 * выбора: самое левое вхождение, при равенстве — самая длинная метка (иначе
 * `⟦ИМЯ_1⟧` перебивала бы `⟦ИМЯ_11⟧`).
 */
export function replaceAll(text: string, pairs: ReadonlyMap<string, string>): string {
  const keys = sortedKeys(pairs);
  let out = '';
  let index = 0;

  while (index < text.length) {
    const key = longestMatchAt(text, index, keys);
    if (key === undefined) {
      out += text[index];
      index += 1;
      continue;
    }
    out += pairs.get(key) ?? '';
    index += key.length;
  }

  return out;
}

export function createStreamReplacer(pairs: ReadonlyMap<string, string>): StreamReplacer {
  const keys = sortedKeys(pairs);
  let pending = '';

  const drain = (final: boolean): string => {
    let out = '';
    let index = 0;

    while (index < pending.length) {
      // Хвост, который ЕЩЁ может стать меткой, не решается без следующего
      // куска: и полное совпадение здесь ждёт продолжения, потому что метка
      // подлиннее может начинаться с этой же строки.
      if (!final && isPrefixOfSomeKey(pending, index, keys)) break;

      const key = longestMatchAt(pending, index, keys);
      if (key === undefined) {
        out += pending[index];
        index += 1;
        continue;
      }
      out += pairs.get(key) ?? '';
      index += key.length;
    }

    pending = pending.slice(index);
    return out;
  };

  return {
    push(chunk) {
      if (!chunk) return '';
      pending += chunk;
      return drain(false);
    },
    flush() {
      const rest = drain(true);
      pending = '';
      return rest;
    },
  };
}

/** Длинные метки первыми: при равном начале побеждает более длинное совпадение. */
function sortedKeys(pairs: ReadonlyMap<string, string>): string[] {
  return [...pairs.keys()].filter((key) => key.length > 0).sort((a, b) => b.length - a.length);
}

function longestMatchAt(text: string, index: number, keys: readonly string[]): string | undefined {
  for (const key of keys) if (text.startsWith(key, index)) return key;
  return undefined;
}

/**
 * Остаток текста от `index` — незавершённое начало какой-то метки. Сравнение
 * строгое: равная строка началом не считается, иначе поток удерживал бы уже
 * состоявшееся совпадение до самого конца ответа.
 */
function isPrefixOfSomeKey(text: string, index: number, keys: readonly string[]): boolean {
  const tail = text.slice(index);
  if (!tail) return false;
  for (const key of keys) {
    if (key.length > tail.length && key.startsWith(tail)) return true;
  }
  return false;
}
