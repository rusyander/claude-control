/**
 * Убрать промежуточные файлы нативной сборки телефонного приложения:
 * `pnpm mobile:clean`.
 *
 * Откуда берутся гигабайты. Gradle кладёт результат сборки КАЖДОЙ нативной
 * библиотеки не в общий каталог, а внутрь самой библиотеки — в
 * `node_modules/<пакет>/android/build` и `android/.cxx`. Там лежат объектные
 * файлы C++ с отладочной информацией, отдельно на каждую из четырёх
 * архитектур и отдельно на debug и release. Reanimated, expo-modules-core и
 * worklets так набирают по паре гигабайт каждый — при том, что сами пакеты
 * весят десятки мегабайт. В APK ничего этого нет: туда попадают уже
 * обрезанные библиотеки.
 *
 * Удалять их безопасно: всё пересоберётся из исходников. Плата — следующая
 * сборка снова полная, минут десять.
 *
 * Файл работает двумя способами: командой `pnpm mobile:clean` (`--dry` — только
 * посчитать) и как модуль — `pnpm mobile:apk` зовёт `sweepMobileBuild()` сразу
 * после того, как APK лёг в корень репозитория. Оттого гигабайты и не копятся:
 * их снимает та же сборка, которая их произвела.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mobile = join(root, 'apps', 'mobile');
const modules = join(mobile, 'node_modules');

/** Размер каталога рекурсивно; недоступное считаем нулём, а не падаем. */
function size(path) {
  let total = 0;
  let stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          // Файл исчез между обходом и замером — для оценки это ноль.
        }
      }
    }
  }
  return total;
}

/** Каталоги сборки внутри нативных библиотек. */
function libraryTargets() {
  if (!existsSync(modules)) return [];
  const found = [];
  const packages = readdirSync(modules, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  for (const entry of packages) {
    // Пакеты с областью имён (`@expo/...`) лежат уровнем глубже.
    const paths = entry.name.startsWith('@')
      ? readdirSync(join(modules, entry.name), { withFileTypes: true })
          .filter((inner) => inner.isDirectory())
          .map((inner) => join(modules, entry.name, inner.name))
      : [join(modules, entry.name)];

    for (const path of paths) {
      for (const nested of ['android/build', 'android/.cxx']) {
        const target = join(path, ...nested.split('/'));
        if (existsSync(target)) found.push(target);
      }
    }
  }
  return found;
}

/** Всё, что подлежит уборке: остатки библиотек плюс сборка самого приложения. */
function allTargets() {
  return [
    ...libraryTargets(),
    // Сам проект: результат сборки приложения и кеш Gradle. APK из корня
    // репозитория не трогаем — он уже собран и лежит отдельно.
    join(mobile, 'android', 'build'),
    join(mobile, 'android', '.gradle'),
    join(mobile, 'android', 'app', 'build'),
    join(mobile, 'android', 'app', '.cxx'),
  ].filter((path) => existsSync(path));
}

/**
 * Убрать (или, при `dry`, только посчитать) промежуточные файлы.
 * Возвращает, сколько каталогов и байтов это было.
 */
export function sweepMobileBuild({ dry = false } = {}) {
  const targets = allTargets();
  let bytes = 0;
  for (const target of targets) {
    bytes += size(target);
    if (!dry) rmSync(target, { recursive: true, force: true });
  }
  return { count: targets.length, bytes };
}

/** Сколько сейчас занимают промежуточные файлы — для доктора и отчётов. */
export function mobileBuildFootprint() {
  return sweepMobileBuild({ dry: true }).bytes;
}

export const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

// Запуск командой, а не импортом.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dry = process.argv.includes('--dry');
  const { count, bytes } = sweepMobileBuild({ dry });
  if (count === 0) {
    console.log('Чистить нечего: промежуточных файлов сборки нет.');
  } else {
    console.log(
      dry
        ? `Нашлось ${count} каталогов на ${formatGb(bytes)} — запустите без --dry, чтобы убрать.`
        : `Убрано ${count} каталогов, освобождено ${formatGb(bytes)}.`,
    );
    if (!dry) console.log('Следующая сборка APK будет полной — это нормально.');
  }
}
