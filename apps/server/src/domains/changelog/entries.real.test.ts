import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changelogEntryFileSchema } from '@agentdeck/contracts/changelog';
import { ENTRY_ID } from './entries.ts';

/**
 * Проверка НАСТОЯЩИХ описаний из `changelog/entries` — гейт держит их в порядке:
 * схема, имя файла, снимки на месте и не тяжелее 400 КБ, ссылки только https и
 * ничего, чего нельзя в публичном репозитории. Это не тест кода, а страж данных:
 * описание пишет человек, и ошибка в нём иначе всплыла бы пустым местом на вкладке.
 */

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
// `CHANGELOG_DIR` — только чтобы показать, что страж умеет краснеть, на заведомо плохом каталоге.
const DIR = process.env.CHANGELOG_DIR ?? join(ROOT, 'changelog');
const ENTRIES = join(DIR, 'entries');
const ASSETS = join(DIR, 'assets');
const MAX_IMAGE_BYTES = 400 * 1024;

/** Названия компании и контура, локальные пути, почта, логин владельца. */
const FORBIDDEN: [string, RegExp][] = [
  // Имя собрано из частей — так же, как в brand.mjs: литерал прежнего имени в дереве не допускается.
  ['название компании или контура', new RegExp(`${'gor'}gona|${'гор'}гон`, 'i')],
  ['абсолютный путь Windows', /\b[A-Za-z]:[\\/]/],
  ['домашний путь', /\/(Users|home)\/[^\s"']+/],
  ['почтовый адрес', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['логин владельца', /rusyander|urmanov/i],
];

const files = existsSync(ENTRIES)
  ? readdirSync(ENTRIES)
      .filter((name) => name.endsWith('.json'))
      .sort()
  : [];

describe('описания «Что нового» в репозитории', () => {
  it('описания на месте', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files)('%s', (name) => {
    const id = name.slice(0, -'.json'.length);
    const text = readFileSync(join(ENTRIES, name), 'utf8');

    it('имя вида ГГГГ-ММ-ДД-имя', () => {
      expect(id).toMatch(ENTRY_ID);
    });

    it('проходит схему', () => {
      const result = changelogEntryFileSchema.safeParse(JSON.parse(text));
      expect(result.success ? [] : result.error.issues).toEqual([]);
    });

    it('в тексте нет запрещённого для публичного репозитория', () => {
      const found = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
      expect(found).toEqual([]);
    });

    it('снимки лежат в changelog/assets/<имя>/ и не тяжелее 400 КБ', () => {
      const parsed = changelogEntryFileSchema.parse(JSON.parse(text));
      const referenced = [
        ...(parsed.images ?? []).map((image) => image.file),
        ...parsed.items.flatMap((item) => item.images ?? []),
      ];
      const problems = referenced.flatMap((file) => {
        const path = join(ASSETS, id, file);
        if (!existsSync(path)) return [`${file}: файла нет`];
        const size = statSync(path).size;
        return size > MAX_IMAGE_BYTES ? [`${file}: ${size} байт, больше 400 КБ`] : [];
      });
      expect(problems).toEqual([]);
    });
  });
});
