/**
 * Матрица верности против опубликованной таблицы (П1.1).
 *
 * Матрица «слой × провайдер» в `TASKS-PORTABILITY.md` §3 — это ОБЕЩАНИЕ человеку.
 * Считает её код (`domains/portability/fidelity.ts`) по данным каталога. Эта
 * проверка сводит одно с другим: каждая клетка таблицы обязана совпасть с тем,
 * что модуль выдаёт для представителя этого слоя у этого провайдера. Разошлись —
 * красный: либо код посчитал не то, либо документ рассказывает о панели то, чего
 * в ней нет.
 *
 * Что ещё проверяется:
 *   0. таблица, каталог и словарь канона покрывают друг друга: столбцы =
 *      провайдеры каталога, строка без представителя названа, вид записи без
 *      представителя назван тоже (иначе проверка идёт по таблице и молчит о
 *      том, чего в таблице нет, — о новом CLI и о новом виде записи);
 *   1. у каждого «×» причина из ЗАКРЫТОГО словаря (критерий приёмки П1.1);
 *   2. условие и запасной уровень согласованы: есть условие — есть иной исход;
 *   3. перенос В Claude считается тоже (в таблице его столбца нет — он источник);
 *   4. выдуманный провайдер с пустым каталогом получает полный столбец, и ни
 *      один файл домена при этом не правится (§5.4).
 *
 * Запуск: `node tools/qa/check-portability-fidelity.mjs`
 * Самопроверка: `node tools/qa/check-portability-fidelity.mjs --selftest` —
 * подменяет клетку таблицы и добавляет канону вид записи без представителя,
 * требуя, чтобы проверка покраснела ИМЕННО на них, по одному следу на подмену.
 * Проверка, которая не может покраснеть, — украшение, и раздел без своей
 * подмены — тоже.
 */
import { readFileSync } from 'node:fs';
import { LAYERS, cellOf } from './portability-layers.mjs';

const selftest = process.argv.includes('--selftest');
const failures = [];

function check(name, condition, detail) {
  if (!condition) failures.push(detail ? `${name} — ${detail}` : name);
}

/** Разобрать таблицу §3 плана: подпись строки → карта «провайдер → клетка». */
function parseMatrix(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| слой '));
  if (start < 0) throw new Error('в плане не найдена таблица §3 («| слой »)');
  const clean = (cell) =>
    cell
      .replaceAll('\\*', '')
      .replaceAll('*', '')
      .replace(/[†‡§¶⊘∅∎]/g, '')
      .trim();
  const columns = lines[start].split('|').slice(2, -1).map(clean);
  const rows = new Map();
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(clean);
    const [label, ...values] = cells;
    rows.set(label, new Map(columns.map((column, at) => [column, values[at]])));
  }
  return { columns, rows };
}

/** Что на самом деле сошлось — числами самой сверки, для итоговой строки. */
let checked = { layers: 0, columns: 0 };

async function main() {
  const planPath = new URL('../../TASKS-PORTABILITY.md', import.meta.url);
  const { columns, rows } = parseMatrix(readFileSync(planPath, 'utf8'));
  // Итоговую строку пишет САМА сверка, своими числами: «9 CLI» в ней было
  // написано рукой, и десятый провайдер каталога оставил бы её врать о девяти.
  checked = { layers: LAYERS.length, columns: columns.length };

  const { level } = await import(
    new URL('../../apps/server/src/domains/portability/fidelity.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );
  const { CATALOG_PROVIDERS } = await import(
    new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href
  );
  const { fidelityReasons, fidelityConditions } = await import(
    new URL('../../packages/contracts/src/portable-fidelity.ts', import.meta.url).href
  );

  const byId = new Map(CATALOG_PROVIDERS.map((provider) => [provider.id, provider]));

  // --- 0. Таблица и каталог покрывают друг друга -----------------------------
  //
  // Проверка клеток идёт ПО ТАБЛИЦЕ, поэтому сама по себе она молчит о том, чего
  // в таблице нет: появись в каталоге одиннадцатый CLI — ни одна клетка не
  // покраснеет, а обещание человеку останется о девяти. Поэтому покрытие
  // сверяется в обе стороны, и так же — строки: строка, представителя которой
  // здесь нет, не проверяется вовсе, и молчать об этом нельзя.
  const catalogIds = CATALOG_PROVIDERS.map((provider) => provider.id).sort();
  const columnIds = [...columns].sort();
  check(
    'столбцы таблицы §3 = каталог провайдеров',
    columnIds.join(',') === catalogIds.join(','),
    `в таблице [${columnIds.join(', ')}], в каталоге [${catalogIds.join(', ')}]`,
  );

  // Строка матрицы, которой нет среди представителей, — не «пока не проверяем»:
  // это клетки, о которых план обещает, а гейт молчит. Единственное исключение
  // названо поимённо, и причина у него та же, что в самом плане.
  const NOT_CANON_ROWS = new Set(['Поведение CLI (модель и пр.)']);
  const covered = new Set(LAYERS.map(([label]) => label));
  for (const label of rows.keys()) {
    if (covered.has(label) || NOT_CANON_ROWS.has(label)) continue;
    failures.push(`строка таблицы «${label}» не проверяется: представителя слоя нет`);
  }

  // Та же сверка со стороны КАНОНА, и без неё покрытие было замкнуто само на
  // себя: и таблица, и представители правятся руками, поэтому тринадцатый вид
  // записи, заведённый в `envItemKinds`, не получил бы ни строки в таблице, ни
  // представителя — и обе проверки остались бы зелёными, обещая человеку
  // двенадцать слоёв вместо тринадцати.
  const { envItemKinds } = await import(
    new URL('../../packages/contracts/src/portable-env.ts', import.meta.url).href
  );
  // Подмена самопроверки: вид канона, представителя у которого заведомо нет.
  const kinds = selftest ? [...envItemKinds, 'виджет'] : envItemKinds;
  const represented = new Set(LAYERS.map(([, canonItem]) => canonItem.kind));
  for (const kind of kinds) {
    if (represented.has(kind)) continue;
    failures.push(`вид канона «${kind}» не проверяется: представителя слоя нет`);
  }

  // --- 1. Клетка за клеткой: таблица против вычисления ------------------------
  for (const [label, canonItem] of LAYERS) {
    const published = rows.get(label);
    if (!published) {
      failures.push(`строки «${label}» нет в таблице §3 плана`);
      continue;
    }
    for (const column of columns) {
      const target = byId.get(column);
      if (!target) {
        failures.push(`столбец «${column}» не найден в каталоге провайдеров`);
        continue;
      }
      let verdict;
      try {
        verdict = level(canonItem, target);
      } catch (error) {
        failures.push(`${label} / ${column}: матрица бросила — ${error.message}`);
        continue;
      }
      const computed = cellOf(verdict);
      const expected =
        selftest && label === 'MCP-серверы' && column === 'codex' ? 'Т' : published.get(column);
      check(
        `${label} / ${column}`,
        computed === expected,
        `в плане «${expected}», вычислено «${computed}» (${verdict.reason})`,
      );
    }
  }

  // --- 2. Приговор всегда полон ----------------------------------------------
  for (const target of [claudeProvider, ...CATALOG_PROVIDERS]) {
    for (const [label, canonItem] of LAYERS) {
      const verdict = level(canonItem, target);
      check(
        `причина из словаря: ${label} / ${target.id}`,
        fidelityReasons.includes(verdict.reason),
        `причина «${verdict.reason}»`,
      );
      if (verdict.condition === null) {
        check(
          `без условия исход один: ${label} / ${target.id}`,
          verdict.fallback === verdict.level,
        );
      } else {
        check(
          `условие из словаря: ${label} / ${target.id}`,
          fidelityConditions.includes(verdict.condition),
          `условие «${verdict.condition}»`,
        );
        check(
          `условие называет иной исход: ${label} / ${target.id}`,
          verdict.fallback !== verdict.level,
        );
      }
    }
  }

  // --- 3. Одиннадцатый CLI: столбец считается без правки домена ---------------
  const invented = {
    id: 'одиннадцатый',
    name: 'Одиннадцатый CLI',
    status: 'experimental',
    paths: () => {
      throw new Error('не используется');
    },
    cli: { command: 'eleventh', windowsCommand: 'eleventh.cmd' },
    capabilities: {},
  };
  for (const [label, canonItem] of LAYERS) {
    let verdict;
    try {
      verdict = level(canonItem, invented);
    } catch (error) {
      failures.push(`выдуманный провайдер: ${label} бросил — ${error.message}`);
      continue;
    }
    check(
      `выдуманный провайдер: ${label} — «×» с причиной`,
      verdict.level === 'impossible' && fidelityReasons.includes(verdict.reason),
      `уровень «${verdict.level}», причина «${verdict.reason}»`,
    );
  }

  // --- 4. Подмена возможности обязана изменить матрицу -----------------------
  const gemini = byId.get('gemini');
  const commandItem = LAYERS.find(([label]) => label === 'Слэш-команды')[1];
  const withCommands = level(commandItem, gemini);
  const withoutCommands = level(commandItem, { ...gemini, commandsConfig: undefined });
  check(
    'подмена возможности меняет матрицу (каталог команд у gemini)',
    withCommands.level === 'native' && withoutCommands.level !== 'native',
    `с каталогом «${withCommands.level}», без каталога «${withoutCommands.level}»`,
  );

  // --- 5. Раздел «только для чтения» назван своей причиной -------------------
  //
  // Буква матрицы у такой клетки та же, что у «раздела нет вовсе» (`×`), и по
  // таблице эти два случая неразличимы. Разница вся в причине: у `kimi`
  // плагинами владеет его собственная команда `/plugins`, у `opencode` ключ
  // хуков исчез из схемы — панель их ПОКАЗЫВАЕТ, но не пишет, и человек обязан
  // прочитать именно это, а не «такого раздела у цели нет».
  const readOnlyCases = [
    ['Плагины как единица', (provider) => provider.pluginsConfig?.format === 'kimi-plugins'],
    ['Хуки: события сессии', (provider) => Boolean(provider.hooksConfig?.writeDisabledReason)],
  ];
  for (const [label, isReadOnly] of readOnlyCases) {
    const canonItem = LAYERS.find(([name]) => name === label)[1];
    const targets = CATALOG_PROVIDERS.filter(isReadOnly);
    check(`раздел только для чтения: «${label}» есть хоть у одной цели`, targets.length > 0);
    for (const target of targets) {
      const verdict = level(canonItem, target);
      check(
        `раздел только для чтения: ${label} / ${target.id}`,
        verdict.reason === 'mechanism_read_only',
        `причина «${verdict.reason}», а раздел в каталоге помечен нечитаемым для записи`,
      );
    }
  }

  // --- 6. Провод не обещает того, чего не видит ------------------------------
  //
  // Контур сидит в ПУТИ ЗАПРОСА: вызовы инструментов и текст запроса он видит, а
  // старт сессии, её конец и сжатие контекста — нет. Запись, требования которой
  // вывести не удалось («нужно всё сразу»), получала `П` у любой цели с
  // адресом — обещание контура там, где он бессилен.
  const sessionItem = LAYERS.find(([label]) => label === 'Хуки: события сессии')[1];
  const undeterminedHook = {
    ...sessionItem,
    needs: { resolution: 'undetermined', why: 'скрипт не разобран' },
  };
  for (const target of [claudeProvider, ...CATALOG_PROVIDERS]) {
    const verdict = level(undeterminedHook, target);
    check(
      `провод вне пути запроса: хук сессии / ${target.id}`,
      verdict.level !== 'wired' && verdict.fallback !== 'wired',
      `уровень «${verdict.level}», без условия «${verdict.fallback}» (${verdict.reason})`,
    );
  }

  // --- 7. Перенос В Claude считается, хотя столбца в таблице нет --------------
  for (const [label, canonItem] of LAYERS) {
    const verdict = level(canonItem, claudeProvider);
    if (label === 'Плагины как единица') {
      // Единственный слой, который в Claude единицей не едет: его плагины
      // ставятся из магазина, а установка плагинов у цели вне объёма (П2.6).
      // Требовать тут уровень значило бы пообещать установку, которой нет.
      // Зато причина обязана называть ИМЕННО это, а не «механизма нет»: иначе
      // человек прочтёт отказ как отсутствие раздела у цели.
      check(
        `перенос в claude: ${label} — назван непереносимой единицей`,
        verdict.reason === 'unit_not_installable',
        `уровень «${verdict.level}» (${verdict.reason})`,
      );
      continue;
    }
    check(
      `перенос в claude: ${label}`,
      verdict.level !== 'impossible',
      `уровень «${verdict.level}» (${verdict.reason})`,
    );
  }
}

await main();

if (selftest) {
  // Подмены ДВЕ, и каждая ловится по своему следу. Одной хватало, пока §0 не
  // начал проверять покрытие со стороны канона: раздел, которому самопроверка
  // не наносит урона, зеленеет всегда — то есть стоит украшением.
  const damages = [
    ['подменённая клетка «MCP-серверы / codex»', (line) => line.startsWith('MCP-серверы / codex')],
    ['вид канона без представителя', (line) => line.includes('вид канона «виджет»')],
  ];
  const caught = new Set();
  for (const [name, hit] of damages) {
    const found = failures.filter(hit);
    if (found.length !== 1) {
      console.error(`САМОПРОВЕРКА ПРОВАЛЕНА: ${name} — поймано ${found.length}, ожидалась одна`);
      process.exit(1);
    }
    for (const line of found) caught.add(line);
  }
  const extra = failures.filter((line) => !caught.has(line));
  if (extra.length > 0) {
    console.error('САМОПРОВЕРКА ПРОВАЛЕНА: кроме подмен покраснело что-то ещё:');
    for (const line of extra) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`Самопроверка: ${damages.length} подмены пойманы по имени, остальное зелено.`);
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`Матрица верности разошлась с планом (${failures.length}):`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `Матрица верности: ${checked.layers} слоёв × ${checked.columns} CLI сошлись с §3 плана.`,
);
