/**
 * Сторож связки «мобильное приложение ↔ пакет контрактов».
 *
 * Зачем он есть. Телефон живёт вне pnpm-воркспейса, со своей линковкой (npm), и
 * модули контрактов, нужные ему КАК ЗНАЧЕНИЯ, Metro резолвит напрямую в
 * исходник по списку `VALUE_MODULES` в `apps/mobile/metro.config.js`. Список
 * ручной, и разойтись с кодом он может молча: `pnpm mobile:type-check` и
 * юнит-тесты остаются ЗЕЛЁНЫМИ на сборке, которая уже не собирается, потому что
 * TypeScript резолвит путь по своим правилам, а Metro — по своим. Красным это
 * становится только при настоящей сборке APK, то есть через десять минут и,
 * как показал 18.09.2026, через несколько часов после того, как поломка уехала
 * в историю.
 *
 * Проверяется три вещи, и каждая — причина реального отказа сборки:
 *   1. каждый импорт ЗНАЧЕНИЯ из `@agentdeck/contracts/<модуль>` в коде
 *      телефона есть в `VALUE_MODULES` (иначе «Unable to resolve module»);
 *   2. каждый модуль из `VALUE_MODULES` самодостаточен — ни одного импорта
 *      (иначе за ним в бандл уезжает zod, которого у телефона нет);
 *   3. каждый такой модуль объявлен в `exports` пакета контрактов (иначе
 *      сломается резолв у всех, кроме Metro).
 *
 * Импорты ТИПОВ (`import type`) не считаются: они стираются компилятором и до
 * Metro не доходят.
 *
 * Запуск: node tools/qa/check-mobile-contracts.mjs [--selftest]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const METRO = 'apps/mobile/metro.config.js';
const CONTRACTS_PKG = 'packages/contracts/package.json';
const CONTRACTS_SRC = 'packages/contracts/src';
const MOBILE_ROOTS = ['apps/mobile/src', 'apps/mobile/app'];
const CODE = /\.(ts|tsx|js|jsx)$/;

/** Список VALUE_MODULES читается из самого конфига — второй копии быть не должно. */
function readValueModules(metroText) {
  const block = metroText.match(/const VALUE_MODULES = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error(`не нашёл VALUE_MODULES в ${METRO}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name)) out.push(path);
  }
  return out;
}

/**
 * Импорты значений из подпутей контрактов. `import type { … } from '…'` и
 * `export type { … } from '…'` пропускаем — до Metro они не доживают.
 */
/**
 * Все импорты файла как пары «что» + «только ли типы». Тип-импорты стираются
 * компилятором и до Metro не доходят — ни в коде телефона, ни на пути модуля
 * контрактов, поэтому различать их обязаны обе проверки.
 *
 * От каждого `from '…'` идём НАЗАД до ближайшего import/export. Ловить выражение
 * одной регуляркой нельзя: ленивый `[\s\S]*?` перепрыгивает через соседние
 * операторы и склеивает многострочный `import type` с импортом строкой выше —
 * так первая версия этого сторожа дала семь ложных находок.
 */
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
    const head = Math.max(text.lastIndexOf('import', m.index), text.lastIndexOf('export', m.index));
    if (head < 0) continue;
    const clause = text.slice(head, m.index);
    // `import { type A, type B } from` — тоже только типы: каждое имя помечено.
    const names = [...clause.matchAll(/[{,]\s*(type\s+)?[A-Za-z_$][\w$]*/g)];
    const typeOnly =
      /^(import|export)\s+type\b/.test(clause) ||
      (clause.includes('{') && names.length > 0 && names.every((n) => n[1]));
    out.push({ spec: m[1], typeOnly });
  }
  return out;
}

function valueImports(text) {
  return importsOf(text)
    .filter((i) => !i.typeOnly)
    .map((i) => /^@agentdeck\/contracts\/([\w-]+)$/.exec(i.spec)?.[1])
    .filter(Boolean);
}

/**
 * Что на самом деле ломает бандл — не любой импорт, а импорт ЧУЖОГО пакета:
 * `platform.ts` тянет zod, которого в `node_modules` телефона нет. Импорты
 * соседних файлов контрактов Metro разрешает сам, они внутри watchFolder.
 * Поэтому идём по относительным импортам вглубь и ищем внешние имена.
 */
function externalDeps(entry, seen = new Set()) {
  const path = entry.endsWith('.ts') ? entry : `${entry}.ts`;
  const real = existsSync(path) ? path : join(entry, 'index.ts');
  if (seen.has(real) || !existsSync(real)) return [];
  seen.add(real);
  const text = readFileSync(real, 'utf8');
  const out = [];
  for (const { spec, typeOnly } of importsOf(text)) {
    if (typeOnly) continue;
    if (spec.startsWith('.')) {
      const next = join(real, '..', spec.replace(/\.ts$/, ''));
      out.push(...externalDeps(next, seen));
    } else {
      out.push({ spec, file: real });
    }
  }
  return out;
}

function check() {
  const metroText = readFileSync(METRO, 'utf8');
  const valueModules = readValueModules(metroText);
  const exports = Object.keys(JSON.parse(readFileSync(CONTRACTS_PKG, 'utf8')).exports ?? {});
  const problems = [];

  console.log(`модулей-значений в ${METRO}: ${valueModules.length}`);

  // 1. Импорты значений в коде телефона покрыты списком. Тесты пропускаем: в граф
  // Metro они не входят (бандл собирается от `expo-router/entry.js`), их резолвит
  // vitest по своим правилам.
  const files = MOBILE_ROOTS.flatMap((root) => walk(root)).filter(
    (f) => !/\.(test|spec)\.[jt]sx?$/.test(f),
  );
  let imports = 0;
  for (const file of files) {
    for (const name of valueImports(readFileSync(file, 'utf8'))) {
      imports += 1;
      if (!valueModules.includes(name)) {
        problems.push(
          `${file}: значение из '@agentdeck/contracts/${name}', а модуля нет в VALUE_MODULES — Metro его не разрешит`,
        );
      }
    }
  }
  console.log(`проверено файлов телефона: ${files.length}, импортов-значений: ${imports}`);

  // 2. Каждый модуль списка самодостаточен и 3. объявлен в exports.
  for (const name of valueModules) {
    const src = join(CONTRACTS_SRC, `${name}.ts`);
    if (!existsSync(src)) {
      problems.push(`${METRO}: в VALUE_MODULES есть '${name}', а файла ${src} нет`);
      continue;
    }
    for (const { spec, file } of externalDeps(src)) {
      problems.push(
        `${file}: чужой пакет '${spec}' на пути модуля '${name}' из VALUE_MODULES — в node_modules телефона его нет`,
      );
    }
    if (!exports.includes(`./${name}`)) {
      problems.push(`${CONTRACTS_PKG}: нет экспорта './${name}', хотя он в VALUE_MODULES`);
    }
  }

  if (problems.length === 0) {
    console.log('\nСвязка телефона с контрактами цела: всё, что нужно значением, Metro разрешит.');
    return 0;
  }
  console.log(`\n✕ нарушений (${problems.length}):`);
  for (const p of problems) console.log(`  ${p}`);
  console.log(
    '\nЛибо добавьте модуль в VALUE_MODULES (`apps/mobile/metro.config.js`) и в exports пакета,\n' +
      'либо вынесите нужное значение в отдельный модуль БЕЗ импортов (как `platform-layers.ts`).',
  );
  return 1;
}

/** Самопроверка: сторож обязан краснеть на каждой из трёх поломок. */
function selftest() {
  const cases = [
    [
      'импорт значения мимо списка',
      () =>
        valueImports("import { ourLayerIds } from '@agentdeck/contracts/platform';").length === 1,
    ],
    [
      'импорт типа не считается импортом значения',
      () =>
        valueImports("import type { Platform } from '@agentdeck/contracts/platform';").length === 0,
    ],
    [
      'inline-тип в фигурных скобках не считается',
      () =>
        valueImports("import { type Platform } from '@agentdeck/contracts/platform';").length === 0,
    ],
    [
      'смешанный импорт считается значением',
      () =>
        valueImports(
          "import { ourLayerIds, type OurLayerId } from '@agentdeck/contracts/platform-layers';",
        ).length === 1,
    ],
    [
      'список читается из конфига, а не из копии',
      () => readValueModules(readFileSync(METRO, 'utf8')).includes('platform-layers'),
    ],
  ];
  let bad = 0;
  for (const [name, fn] of cases) {
    let ok;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    console.log(`${ok ? 'ок  ' : '✕   '} ${name}`);
    if (!ok) bad += 1;
  }
  console.log(
    bad === 0
      ? '\nСамопроверка пройдена: разбор импортов различает значение и тип.'
      : `\n✕ самопроверка провалена (${bad})`,
  );
  return bad === 0 ? 0 : 1;
}

process.exit(process.argv.includes('--selftest') ? selftest() : check());
