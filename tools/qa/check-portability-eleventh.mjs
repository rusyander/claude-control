/**
 * ОДИННАДЦАТЫЙ CLI: расширяемость как измерение, а не как обещание (П7.2, §5.4).
 *
 * План утверждает, что завести новый CLI — это четыре правки: запись в
 * `providers/catalog/`, `import/<cli>.ts`, `emit/<cli>.ts` и строка в справке.
 * Всё остальное — матрица, отчёт верности, подписка, надзиратель, экран —
 * считает по каталогу и знания о конкретном CLI не держит. Утверждение проверяемо
 * ровно одним способом: завести провайдера, которого нет ни в одном файле домена,
 * и посмотреть, что панель о нём скажет.
 *
 * Что прогоняется:
 *   1. столбец выдуманного провайдера с ПУСТЫМ каталогом возможностей: отчёт
 *      верности считается целиком, каждая строка — «×» с причиной из словаря,
 *      сводка сходится, «только через панель» = 0. Ни одного броска;
 *   2. эмиттеры: у каждого провайдера каталога он есть, у выдуманного — нет, и
 *      план переноса в него ОТКАЗЫВАЕТСЯ по имени, а не выходит пустым;
 *   3. ни одной ветки по имени ЦЕЛИ вне каталога и половин `import/`/`emit/`:
 *      различие провайдеров выражается возможностью, ветка в домене — это
 *      матрица, которая начала лгать (§5.3);
 *   4. роспись живой приёмки: у каждого CLI каталога есть пункт в `TASKS.md`
 *      со всеми шестью пробами, и список проб взят из самого плана, а не
 *      переписан рядом.
 *
 * Запуск: `node tools/qa/check-portability-eleventh.mjs`
 * Самопроверка: `node tools/qa/check-portability-eleventh.mjs --selftest` —
 * каждый из четырёх разделов прогоняется с подменой и обязан покраснеть именно
 * на ней. Проверка, которая не может покраснеть, — украшение.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { LAYERS, cellOf } from './portability-layers.mjs';

const selftest = process.argv.includes('--selftest');

const root = new URL('../../', import.meta.url);
const serverSrc = new URL('apps/server/src/', root);

/** Выдуманный провайдер: запись каталога и ничего больше. */
function eleventh(over = {}) {
  return {
    id: 'одиннадцатый',
    name: 'Одиннадцатый CLI',
    status: 'experimental',
    paths: () => {
      throw new Error('файлы выдуманного провайдера не читаются');
    },
    cli: { command: 'eleventh', windowsCommand: 'eleventh.cmd' },
    capabilities: {},
    ...over,
  };
}

// --- 1. Полный столбец: отчёт верности о провайдере без единой возможности ----
function checkColumn(ctx, damage) {
  const failures = [];
  const { buildFidelityReport, fidelityReasons, CANON_VERSION } = ctx;
  // Подмена: провайдер перестаёт быть пустым. Столбец обязан перестать быть
  // полным — иначе «×» в нём стоит не от каталога, а от незнакомого имени.
  const target = damage
    ? eleventh({ skillsConfig: { format: 'skill-md-dir', dir: () => 'C:/nowhere' } })
    : eleventh();

  const env = {
    canonVersion: CANON_VERSION,
    provider: 'claude',
    scope: 'global',
    root: 'C:/nowhere',
    capturedAt: '2026-09-21T00:00:00.000Z',
    items: LAYERS.map(([, item]) => item),
    skipped: [],
    sectionStates: [],
  };

  let report;
  try {
    report = buildFidelityReport(env, target, env.capturedAt);
  } catch (error) {
    failures.push(`отчёт о выдуманном провайдере бросил: ${error.message}`);
    return failures;
  }

  for (const row of report.rows) {
    if (row.level !== 'impossible') {
      failures.push(`столбец не полон: ${row.kind} — уровень «${row.level}» (${row.reason})`);
      continue;
    }
    if (!fidelityReasons.includes(row.reason)) {
      failures.push(`причина вне словаря: ${row.kind} — «${row.reason}»`);
    }
    // «Невозможно» без условия: обещать исход при каком-то условии у цели,
    // которой панель не знает, значит выдумать этот исход.
    if (row.condition !== null || row.fallback !== 'impossible') {
      failures.push(
        `«×» с условием: ${row.kind} — условие «${row.condition}», без него «${row.fallback}»`,
      );
    }
  }
  if (report.rows.length !== LAYERS.length) {
    failures.push(`строк в отчёте ${report.rows.length}, слоёв ${LAYERS.length}`);
  }
  if (report.summary.impossible !== LAYERS.length) {
    failures.push(`сводка: «невозможно» ${report.summary.impossible} из ${LAYERS.length}`);
  }
  if (report.onlyThroughPanel !== 0) {
    failures.push(`«только через панель» = ${report.onlyThroughPanel}, а панель его не запускает`);
  }
  // И буква матрицы на том же столбце: экран, план и отчёт обязаны сойтись.
  for (const [label, item] of LAYERS) {
    const cell = cellOf(ctx.level(item, target));
    if (cell !== '×') failures.push(`клетка столбца: ${label} — «${cell}»`);
  }
  return failures;
}

// --- 2. Эмиттеры: полнота каталога и честный отказ ----------------------------
function checkEmitters(ctx, damage) {
  const failures = [];
  const { hasEmitter, emitEnvironment, UnknownEmitProviderError, catalogIds } = ctx;

  // Подмена: в каталоге как будто появился CLI, эмиттера которому не завели.
  const expected = damage ? [...catalogIds, 'одиннадцатый'] : catalogIds;
  for (const id of ['claude', ...expected]) {
    if (!hasEmitter(id)) failures.push(`провайдер «${id}» есть в каталоге, эмиттера нет`);
  }

  const env = {
    canonVersion: ctx.CANON_VERSION,
    provider: 'claude',
    scope: 'global',
    root: 'C:/nowhere',
    capturedAt: '2026-09-21T00:00:00.000Z',
    items: [],
    skipped: [],
    sectionStates: [],
  };
  let refused = null;
  try {
    emitEnvironment(env, { target: eleventh(), home: 'C:/nowhere', read: () => null });
    failures.push(
      'план переноса в неизвестный CLI построился — панель обещала запись, которой нет',
    );
  } catch (error) {
    refused = error;
  }
  if (refused && !(refused instanceof UnknownEmitProviderError)) {
    failures.push(`отказ не назван своим классом: ${refused.name} — ${refused.message}`);
  }
  if (refused && !refused.message.includes('одиннадцатый')) {
    failures.push(`отказ не назвал цель: «${refused.message}»`);
  }
  return failures;
}

// --- 3. Ни одной ветки по имени цели вне каталога ------------------------------
/**
 * Исключения — поимённо и с причиной. Пустой список был бы честнее, но неправдой:
 * диалекты прав у панели заведены СВОИМ разделом (`provider-permissions/`), и
 * канон читает их разбор, а не имя цели.
 */
const BRANCH_ALLOWED = new Map([
  [
    'domains/portability/normalize-permissions.ts',
    'разбор по диалекту ИСТОЧНИКА (`ProviderPermissionsValues.kind`), а не по имени цели',
  ],
  [
    'domains/portability/probe-recipes.ts',
    'argv неинтерактивного запуска и СОБСТВЕННЫЕ имена инструментов каждого CLI — ' +
      'единственное, что из каталога не выводится; вынесено отдельным модулем ровно ' +
      'затем, чтобы probe.ts остался под охраной',
  ],
]);

function sourceFiles(dir, skip) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    const relative = at.href.slice(serverSrc.href.length);
    if (skip.some((part) => relative.startsWith(part))) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(at, skip));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(at);
  }
  return files;
}

function checkBranches(ctx, damage) {
  const failures = [];
  // `claude` не в списке намеренно: он канон, и отличать его домену можно и нужно
  // (инвариант 1). Ветка по имени ЛЮБОЙ другой цели — знание о конкретном CLI.
  const ids = ctx.catalogIds;
  // Ветка по имени цели прячется не только в `=== 'codex'`. Тот же смысл несут
  // двойные кавычки, обратные, `includes('codex')`, `new Set([...])` и карта,
  // ключ которой — идентификатор CLI (а карта, ключ которой CLI, — здешняя
  // идиома). Сторож на `===|!==|case '…'` пропускал их все, и обойти его можно
  // было не пряча, а просто записав иначе.
  //
  // Поэтому ищется ЛЮБОЕ упоминание идентификатора в коде: в этом слое знать его
  // неоткуда — уровни считает каталог. Тот же приём строже стоит в
  // `fidelity.test.ts` §«в модуле нет ни одного идентификатора провайдера».
  const patterns = [
    new RegExp(`['"\`](${ids.join('|')})['"\`]`, 'g'),
    new RegExp(`[{,]\\s*(${ids.join('|')})\\s*:`, 'g'),
  ];

  const files = sourceFiles(new URL('domains/portability/', serverSrc), [
    'domains/portability/import/',
    'domains/portability/emit/',
  ]);
  files.push(new URL('routes/portability-routes.ts', serverSrc));
  files.push(new URL('routes/portability-carry-routes.ts', serverSrc));

  const scanned = files.map((at) => [
    at.href.slice(serverSrc.href.length),
    readFileSync(at, 'utf8'),
  ]);
  // Подмена: файлы домена, в которых появилась ветка по имени цели. Их ДВА, по
  // одному на форму записи: сравнение и карта. С одним лишь сравнением селфтест
  // зеленел бы и на стороже, который карту не видит, — то есть подтверждал бы
  // ровно ту дыру, ради которой этот сторож переписан.
  if (damage) {
    scanned.push([
      'domains/portability/подмена.ts',
      `if (target.id === "${ids[0]}") return native;`,
    ]);
    scanned.push([
      'domains/portability/подмена-картой.ts',
      `const byTarget = { ${ids[0]}: native };`,
    ]);
  }

  for (const [relative, text] of scanned) {
    // Комментарии сняты: провайдеров в них называют по имени, и это не ветка.
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const hits = patterns.flatMap((pattern) =>
      [...code.matchAll(pattern)].map((match) => match[1]),
    );
    if (BRANCH_ALLOWED.has(relative)) {
      // Исключение, которому нечего прощать, — стухшее: файл давно не ветвится,
      // а разрешение осталось и прикрывает следующую ветку, которую там заведут.
      if (hits.length === 0) failures.push(`исключение «${relative}» больше ничего не прощает`);
      continue;
    }
    if (hits.length === 0) continue;
    failures.push(`ветка по имени цели в ${relative}: ${[...new Set(hits)].join(', ')}`);
  }
  for (const relative of BRANCH_ALLOWED.keys()) {
    if (!scanned.some(([name]) => name === relative)) {
      failures.push(`исключение «${relative}» указывает на файл, которого нет`);
    }
  }
  return failures;
}

// --- 4. Роспись живой приёмки: пункт на каждый CLI ----------------------------
function checkRoster(ctx, damage) {
  const failures = [];
  const plan = readFileSync(new URL('docs/TASKS-PORTABILITY.ru.md', root), 'utf8');

  // Шесть проб берутся ИЗ ПЛАНА: список назван в §9 (доктрина) и в критерии
  // П7.2, и обе копии обязаны совпасть — иначе приёмка закрывается не тем, о чём
  // договаривались.
  const spelled = [...plan.matchAll(/\(хук блокирует[^)]*\)/g)].map((match) => match[0]);
  if (spelled.length < 2) {
    failures.push(
      `список проб назван в плане ${spelled.length} раз(а), ожидались §9 и критерий П7.2`,
    );
    return failures;
  }
  if (new Set(spelled).size !== 1) {
    failures.push(`копии списка проб в плане разошлись: ${[...new Set(spelled)].join(' ⟂ ')}`);
    return failures;
  }
  const probes = spelled[0].slice(1, -1).split(' · ');
  if (probes.length !== 6) {
    failures.push(`проб в списке ${probes.length}, а не шесть: ${probes.join(' · ')}`);
    return failures;
  }

  const tasks = readFileSync(new URL('TASKS.md', root), 'utf8').split('\n');
  const start = tasks.findIndex(
    (line) => line.startsWith('#') && line.includes('Живая приёмка переноса среды'),
  );
  if (start < 0) {
    failures.push('в TASKS.md нет раздела «Живая приёмка переноса среды»');
    return failures;
  }

  const items = new Map();
  let current = null;
  for (let index = start + 1; index < tasks.length; index += 1) {
    const line = tasks[index];
    if (line.startsWith('#')) break;
    const head = /^- \*\*(.+?)\*\* \(`([^`]+)`\)/.exec(line);
    if (head) {
      current = head[2];
      items.set(current, line);
      continue;
    }
    if (current && line.trim().length > 0) items.set(current, `${items.get(current)}\n${line}`);
  }
  // Подмена: один CLI выпал из росписи — ровно то, что случится, когда
  // одиннадцатый заведут в каталоге и забудут про живую приёмку.
  if (damage) items.delete(ctx.catalogIds[0]);

  for (const id of ['claude', ...ctx.catalogIds]) {
    const body = items.get(id);
    if (!body) {
      failures.push(`живой приёмки нет ни для одного пункта CLI «${id}»`);
      continue;
    }
    // Переносы строк в пункте ставит prettier, и проба легко оказывается разорвана
    // посередине: сравнивать надо текст, а не то, как он разложен по строкам.
    const flat = body.replace(/\s+/g, ' ');
    const missing = probes.filter((probe) => !flat.includes(probe));
    if (missing.length > 0) {
      failures.push(`у «${id}» не названы пробы: ${missing.join(' · ')}`);
    }
  }
  for (const id of items.keys()) {
    if (id !== 'claude' && !ctx.catalogIds.includes(id)) {
      failures.push(`в росписи живой приёмки CLI «${id}», которого нет в каталоге`);
    }
  }
  return failures;
}

/**
 * Раздел, его прогон и СЛЕД подмены — строка, которая обязана появиться в
 * красном именно от неё. Без следа самопроверка довольствовалась бы любым
 * покраснением, а «покраснело хоть что-то» и «поймало подмену» — разные вещи.
 */
const SECTIONS = [
  ['столбец выдуманного провайдера', checkColumn, 'столбец не полон'],
  ['эмиттеры', checkEmitters, 'эмиттера нет'],
  ['ветки по имени цели', checkBranches, 'подмена.ts'],
  ['роспись живой приёмки', checkRoster, 'живой приёмки нет'],
];

async function context() {
  const { level } = await import(new URL('domains/portability/fidelity.ts', serverSrc).href);
  const { buildFidelityReport } = await import(
    new URL('domains/portability/fidelity-report.ts', serverSrc).href
  );
  const { hasEmitter, emitEnvironment } = await import(
    new URL('domains/portability/emit/index.ts', serverSrc).href
  );
  const { UnknownEmitProviderError } = await import(
    new URL('domains/portability/emit/types.ts', serverSrc).href
  );
  const { CATALOG_PROVIDERS } = await import(new URL('providers/catalog.ts', serverSrc).href);
  const { fidelityReasons } = await import(
    new URL('packages/contracts/src/portable-fidelity.ts', root).href
  );
  const { CANON_VERSION } = await import(
    new URL('packages/contracts/src/portable-env.ts', root).href
  );
  return {
    level,
    buildFidelityReport,
    hasEmitter,
    emitEnvironment,
    UnknownEmitProviderError,
    fidelityReasons,
    CANON_VERSION,
    catalogIds: CATALOG_PROVIDERS.map((provider) => provider.id),
  };
}

const ctx = await context();

if (selftest) {
  const clean = SECTIONS.flatMap(([name, run]) =>
    run(ctx, false).map((line) => `${name}: ${line}`),
  );
  if (clean.length > 0) {
    console.error('САМОПРОВЕРКА ПРОВАЛЕНА: без подмены проверка уже красная:');
    for (const line of clean) console.error(`  - ${line}`);
    process.exit(1);
  }
  for (const [name, run, trace] of SECTIONS) {
    const caught = run(ctx, true);
    if (!caught.some((line) => line.includes(trace))) {
      console.error(
        `САМОПРОВЕРКА ПРОВАЛЕНА: подмена в разделе «${name}» не поймана по следу «${trace}»` +
          (caught.length > 0 ? `; покраснело другое: ${caught.join(' | ')}` : ''),
      );
      process.exit(1);
    }
  }
  console.log(`Самопроверка: ${SECTIONS.length} подмены поймано, без них зелено.`);
  process.exit(0);
}

const failures = SECTIONS.flatMap(([name, run]) =>
  run(ctx, false).map((line) => `${name}: ${line}`),
);

if (failures.length > 0) {
  console.error(`Одиннадцатый CLI: расширяемость нарушена (${failures.length}):`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `Одиннадцатый CLI: столбец из ${LAYERS.length} «×», эмиттеры на ${ctx.catalogIds.length} целей, ветки по имени цели не заведены, живая приёмка расписана на ${ctx.catalogIds.length + 1} CLI.`,
);
