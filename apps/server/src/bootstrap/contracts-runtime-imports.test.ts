import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Модуль контрактов, который СЕРВЕР грузит на старте, обязан быть загружаемым
 * `node --experimental-strip-types`.
 *
 * Это тот самый класс поломки, от которого репозиторий уже защищён с одной
 * стороны (`server-contracts-barrel-types-only` в `.dependency-cruiser.cjs`: один
 * импорт ЗНАЧЕНИЯ из бочки контрактов валит процесс). Здесь закрыта вторая
 * сторона, и она страшнее: относительный импорт значения ВНУТРИ пакета без
 * расширения `.ts`. Такой файл tsc проходит, vitest проходит, фронт собирается —
 * а сервер на нём не стартует вовсе: `ERR_MODULE_NOT_FOUND`, `node --watch`
 * переживает падение раз в секунду, и панель мертва целиком, а не одной ручкой.
 * Ровно это случилось 13.09.2026 на `media-block.ts` → `media-deck`.
 *
 * Проверка идёт от подпутей `exports`: именно ими сервер берёт значения, и именно
 * они (со всем, что тянут за собой) попадают в процесс без сборки. Тип-импорты не
 * трогаем — они стираются и до резолвера не доходят.
 */

const CONTRACTS = resolve(import.meta.dirname, '../../../../packages/contracts');

/**
 * Относительный импорт или ре-экспорт ЗНАЧЕНИЯ.
 *
 * Инструкция целиком, от `import`/`export` в начале строки до точки с запятой:
 * без этого якоря ленивый разбор перескакивает через чужой `from` и объявляет
 * нарушением соседний тип-импорт (поймано на первом же прогоне этой проверки).
 */
const STATEMENT = /^(?:import|export)\s+(?!type[\s{])([^;]*?)\s*from\s+'(\.[^']*)';/gm;

/** Стирается ли инструкция целиком: `{ type A, type B }` в рантайм не идёт. */
function typesOnly(clause: string): boolean {
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (!braces?.[1]) return false;
  return braces[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .every((part) => part.startsWith('type '));
}

/**
 * Подпути пакета, кроме бочки.
 *
 * Бочка (`.` → `index.ts`) исключена НАМЕРЕННО: она и не должна быть загружаемой,
 * её ре-экспорты нарочно без расширений, и с этой стороны репозиторий закрыт
 * соседним правилом — `server-contracts-barrel-types-only` в
 * `.dependency-cruiser.cjs` не даёт серверу взять из неё ни одного значения.
 */
function subpathEntries(): string[] {
  const manifest = JSON.parse(readFileSync(join(CONTRACTS, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports)
    .filter(([subpath]) => subpath !== '.')
    .map(([, relative]) => resolve(CONTRACTS, relative));
}

/** Все файлы, которые процесс дотянет из этого — по относительным импортам значений. */
function reachable(entry: string): Map<string, string[]> {
  const specifiers = new Map<string, string[]>();
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      // Подпуть, указывающий в несуществующий файл, — забота другой проверки.
      continue;
    }

    const found: string[] = [];
    for (const match of source.matchAll(STATEMENT)) {
      const specifier = match[2];
      if (!specifier || typesOnly(match[1] ?? '')) continue;
      found.push(specifier);
      // Дальше идём только по тому, что действительно найдём на диске: путь без
      // расширения как раз и есть нарушение, и его файл лежит рядом с `.ts`.
      const target = specifier.endsWith('.ts') ? specifier : `${specifier}.ts`;
      queue.push(resolve(dirname(file), target));
    }
    if (found.length > 0) specifiers.set(file, found);
  }

  return specifiers;
}

describe('контракты, загружаемые сервером без сборки', () => {
  it('относительный импорт значения несёт расширение .ts — иначе сервер не стартует', () => {
    const broken: string[] = [];

    for (const entry of subpathEntries()) {
      for (const [file, specifiers] of reachable(entry)) {
        for (const specifier of specifiers) {
          if (specifier.endsWith('.ts')) continue;
          broken.push(`${file.replace(CONTRACTS, 'packages/contracts')} → '${specifier}'`);
        }
      }
    }

    // Список, а не счётчик: провал обязан НАЗВАТЬ файл и импорт, иначе его будут
    // искать глазами по всему пакету.
    expect(broken).toEqual([]);
  });
});
