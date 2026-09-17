import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_IDS } from '@agentdeck/contracts/prompts';
import { builtinPromptText } from './prompts/catalog.ts';

/**
 * Сторож одного правила: текст промпта не живёт нигде, кроме каталога.
 *
 * Ради него раздел и заведён. Как только прослойка инструментов, режим картинки
 * или режим презентации заведут свою копию текста — «встроенную по умолчанию»,
 * «на всякий случай», «пока каталог не готов», — правка человека в панели станет
 * менять половину поведения, а вторая половина продолжит работать текстом из
 * кода. Объяснить такое человеку нечем: он видит свой текст в карточке и чужой
 * ответ модели.
 *
 * Проверяется механически, по исходникам: приметная строка каждого встроенного
 * промпта не должна встречаться ни в одном модуле, а читать `catalog/*.md` имеет
 * право ровно один файл.
 */

const SERVER_SRC = fileURLToPath(new URL('..', import.meta.url));
const WEB_SRC = fileURLToPath(new URL('../../../web/src', import.meta.url));
/**
 * Не только приложения: свипы в `tools/` воспроизводят протокол скриптованной
 * моделью — самое вероятное место для второй копии грамматики, а телефон и
 * контракты — такие же исходники (ревью Т4, MINOR-3). Читатель каталога
 * по-прежнему ищется только на сервере — фильтр ниже.
 */
const OTHER_SOURCES = [
  '../../../../tools',
  '../../../mobile/src',
  '../../../mobile/app',
  '../../../../packages/contracts/src',
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

/** Кто имеет право читать файлы каталога. Один модуль, и он назван здесь. */
const CATALOG_READER = join('domains', 'prompts', 'catalog.ts');

describe('текст промпта живёт в одном месте', () => {
  const sources = [SERVER_SRC, WEB_SRC, ...OTHER_SOURCES].flatMap((root) => walk(root));

  it('исходников для проверки нашлось достаточно', () => {
    // Без этой строки пустой обход (переехал каталог, сменилось расширение)
    // выглядел бы как зелёная проверка, ничего не проверяющая.
    expect(sources.length).toBeGreaterThan(500);
  });

  // Исходники читаются ОДИН раз: проверок пять, файлов под тысячу, и чтение на
  // каждую пару «промпт × файл» превращало бы сторожа в самый долгий тест набора.
  const texts = sources.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it.each([...PROMPT_IDS])('ни одна строка промпта «%s» не скопирована в код', (id) => {
    const sentinels = distinctiveLines(builtinPromptText(id));
    expect(sentinels.length).toBeGreaterThan(2);

    // Проверяется КАЖДАЯ содержательная строка, а не одна приметная: копию
    // делают абзацем, и попадись под сторожа только самая длинная строка —
    // уехавший в код кусок протокола прошёл бы мимо.
    const guilty = texts
      .filter(({ text }) => sentinels.some((sentinel) => text.includes(sentinel)))
      .map(({ file }) => file);

    expect(guilty, `текст промпта «${id}» найден в: ${guilty.join(', ')}`).toEqual([]);
  });

  it('файлы каталога читает ровно один модуль', () => {
    // Ищется именно ПУТЬ к файлу каталога, а не два слова по отдельности:
    // «catalog» и «.md» в одном модуле встречаются и без всякого чтения
    // промптов (реестр провайдеров, документация рядом с кодом).
    //
    // Смотрим при этом только на сервер. Прочитать файл, лежащий в его каталоге,
    // фронт не может физически, а путь к нему он называет по делу: справка
    // показывает человеку, где лежит встроенный текст и где — его правка.
    // Считать такую строку «вторым читателем» значило бы запретить справке
    // называть файл, о котором она рассказывает.
    const readers = sources.filter(
      (file) =>
        file.startsWith(SERVER_SRC) &&
        !file.endsWith('.test.ts') &&
        /catalog\/[^'"`\n]*\.md/.test(readFileSync(file, 'utf8')),
    );

    expect(readers.map((file) => file.slice(SERVER_SRC.length))).toEqual([CATALOG_READER]);
  });
});

/**
 * Содержательные строки текста: длинные, словами, без разметки и примеров —
 * именно их скопировал бы тот, кто решил «пусть текст будет и здесь тоже».
 * Короткие и служебные (теги, скобки JSON) отсеяны: они встречаются в коде сами
 * по себе, и сторож краснел бы на чужой ни в чём не повинной строке.
 */
function distinctiveLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.length >= 40 && !item.startsWith('<') && !item.startsWith('{'));
  if (lines.length === 0) throw new Error('во встроенном промпте нет ни одной длинной строки');
  return lines;
}

/** Все исходники под каталогом: код, а не данные. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__fixtures__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}
