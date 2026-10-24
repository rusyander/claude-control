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
 * На Windows релизный APK собирается из короткой копии приложения
 * (`shortCopyDir`), и гигабайты копятся уже там — уборка снимает копию целиком.
 *
 * Файл работает двумя способами: командой `pnpm mobile:clean` (`--dry` — только
 * посчитать) и как модуль — `pnpm mobile:apk` зовёт `sweepMobileBuild()` сразу
 * после того, как APK лёг в корень репозитория. Оттого гигабайты и не копятся:
 * их снимает та же сборка, которая их произвела.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mobile = join(root, 'apps', 'mobile');

/**
 * Короткая копия `apps/mobile`, из которой на Windows собирается релизный APK
 * (почему — шапка `build-mobile-apk.mjs`). У каждого клона своя: метка из пути
 * корня, иначе две копии репозитория собирали бы в одном каталоге. Лежит в
 * корне системного диска, а не в профиле: путь профиля сам бывает длиннее
 * запаса. `AGENTDECK_APK_DIR` переносит копии в другое место.
 */
export function shortCopyDir(repoRoot = root, env = process.env) {
  const base = env.AGENTDECK_APK_DIR || join(`${env.SystemDrive || 'C:'}\\`, 'adapk');
  const tag = createHash('sha1').update(repoRoot.toLowerCase()).digest('hex').slice(0, 6);
  return join(base, tag);
}

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
function libraryTargets(modules) {
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

/** Промежуточная сборка в каталоге приложения: остатки библиотек плюс сборка самого приложения. */
export function buildDirsOf(mobileDir) {
  return [
    ...libraryTargets(join(mobileDir, 'node_modules')),
    // Сам проект: результат сборки приложения и кеш Gradle. APK из корня
    // репозитория не трогаем — он уже собран и лежит отдельно.
    join(mobileDir, 'android', 'build'),
    join(mobileDir, 'android', '.gradle'),
    join(mobileDir, 'android', 'app', 'build'),
    join(mobileDir, 'android', 'app', '.cxx'),
  ].filter((path) => existsSync(path));
}

/** Всё, что подлежит уборке. */
function allTargets() {
  const copy = shortCopyDir();
  return [
    ...buildDirsOf(mobile),
    // Короткая копия — целиком: в ней только повтор apps/mobile и промежуточные
    // файлы. Так уходит и копия, брошенная прерванной сборкой.
    ...(process.platform === 'win32' && existsSync(copy) ? [copy] : []),
  ];
}

/**
 * Убрать (или, при `dry`, только посчитать) промежуточные файлы.
 * Возвращает, сколько каталогов и байтов убрано и какие каталоги не дались.
 *
 * Каталог может держать открытым процесс, переживший сборку: `gradle --stop`
 * гасит демон Gradle, но не демон компилятора Kotlin. Windows тогда отказывает
 * в удалении (EPERM/EBUSY). Такой каталог пропускаем и называем, остальные
 * убираем — раньше первый же занятый файл обрывал уборку целиком.
 */
export function sweepMobileBuild({ dry = false } = {}) {
  const targets = allTargets();
  let bytes = 0;
  let count = 0;
  const locked = [];
  for (const target of targets) {
    const before = size(target);
    if (dry) {
      bytes += before;
      count += 1;
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      bytes += before;
      count += 1;
    } catch {
      // Часть файлов уже могла уйти — считаем то, что действительно освободилось.
      bytes += before - size(target);
      locked.push(target);
    }
  }
  // Пустой общий каталог копий в корне диска не оставляем; копия другого клона его
  // сохранит. Каталог, названный в AGENTDECK_APK_DIR, — выбор человека, его не трогаем.
  if (!dry && process.platform === 'win32' && !process.env.AGENTDECK_APK_DIR) {
    try {
      rmdirSync(dirname(shortCopyDir()));
    } catch {
      // Не пуст или его нет — так и должно быть.
    }
  }
  return { count, bytes, locked };
}

/** Строка о каталогах, которые не дались, — или пусто, если таких нет. */
export function lockedNote(locked) {
  if (locked.length === 0) return '';
  const names = locked
    .map((path) => (path.startsWith(mobile) ? path.slice(mobile.length + 1) : path))
    .join(', ');
  return (
    `Не удалось убрать каталогов: ${locked.length} (${names}) — их держит открытым другой ` +
    'процесс, обычно демон Kotlin после сборки; он гаснет сам. Повторите pnpm mobile:clean позже.'
  );
}

/** Сколько сейчас занимают промежуточные файлы — для доктора и отчётов. */
export function mobileBuildFootprint() {
  return sweepMobileBuild({ dry: true }).bytes;
}

export const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

// Запуск командой, а не импортом.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dry = process.argv.includes('--dry');
  const { count, bytes, locked } = sweepMobileBuild({ dry });
  if (count === 0 && locked.length === 0) {
    console.log('Чистить нечего: промежуточных файлов сборки нет.');
  } else {
    console.log(
      dry
        ? `Нашлось ${count} каталогов на ${formatGb(bytes)} — запустите без --dry, чтобы убрать.`
        : `Убрано ${count} каталогов, освобождено ${formatGb(bytes)}.`,
    );
    if (!dry) console.log('Следующая сборка APK будет полной — это нормально.');
  }
  const note = lockedNote(locked);
  if (note) {
    console.log(note);
    process.exitCode = 1;
  }
}
