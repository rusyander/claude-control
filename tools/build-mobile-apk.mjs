/**
 * Релизный APK телефонного приложения — в корень репозитория.
 *
 * Кладётся ОДИН файл с постоянным именем: старый удаляется перед сборкой, новый
 * встаёт на его место. Так на телефон всегда ставится то, что собрано последним,
 * и не приходится гадать, какой из файлов свежий.
 *
 * Подпись — отладочным ключом из шаблона Expo (`android/app/debug.keystore`):
 * поставить сборку себе этого достаточно, для магазина нужен свой ключ, и это
 * отдельный разговор, а не молчаливая подмена.
 *
 * ## Почему на Windows сборка идёт с подставленного диска
 *
 * `ninja` из Android SDK отказывается работать с путём длиннее 260 символов, а
 * codegen react-native-gesture-handler зеркалит путь исходника внутрь имени
 * объектного файла: из `apps/mobile/node_modules/...` выходит строка под 280
 * символов, и сборка падает ещё до компиляции. Лечится только укорочением пути,
 * поэтому каталог `apps/` подставляется отдельной буквой диска (`subst`) — те же
 * файлы становятся `Y:\mobile\...`. Отладочная сборка (`pnpm mobile`) проходит и
 * без этого: у неё имя каталога короче на длину `RelWithDebInfo`.
 *
 * С подставленного диска до корня репозитория подъёмом на два уровня уже не
 * дойти, а Metro читает оттуда один общий модуль контрактов — корень передаётся
 * ему переменной `CLAUDE_CONTROL_REPO_ROOT` (её понимает `metro.config.js`).
 *
 * ## Почему codegen запускается ОТДЕЛЬНО и с настоящего пути
 *
 * Подставленный диск — это тот же том, и всякий, кто спрашивает у Windows
 * настоящее имя файла, получает обратно `C:\...`. Автолинковка Expo так и
 * делает, поэтому каталоги библиотек приезжают в Gradle с корнем `C:`, а сам
 * проект живёт на `Y:`. Codegen React Native строит из этой пары относительный
 * путь и падает на `different roots`. Лечится тем, что codegen прогоняется
 * заранее с настоящего пути — там оба корня совпадают, — а на `Y:` его задачи
 * уже готовы. Дело это чисто JS-овое, секунды.
 *
 * Запуск: `pnpm mobile:apk`. Нужны JDK 17 и Android SDK — те же, что для
 * `pnpm mobile`.
 *
 * После успешной сборки промежуточные файлы удаляются сами
 * (`clean-mobile-build.mjs`): иначе они копятся десятками гигабайт внутри
 * `node_modules`. Нужна быстрая пересборка подряд — `pnpm mobile:apk
 * --keep-build`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGb, sweepMobileBuild } from './clean-mobile-build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appsDir = join(root, 'apps');
const androidDir = join(appsDir, 'mobile', 'android');
const outputName = 'claude-control.apk';
const target = join(root, outputName);
const isWindows = process.platform === 'win32';
/** Промежуточные файлы обычно не нужны; `--keep-build` бережёт время пересборки. */
const KEEP_BUILD = process.argv.includes('--keep-build');

if (!existsSync(join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew'))) {
  console.error('Нет каталога android/ — сначала выполните expo prebuild в apps/mobile.');
  process.exit(1);
}

/** Запустить gradle в каталоге `cwd`; на Windows gradlew — это .bat. */
function gradle(cwd, tasks) {
  const command = isWindows ? join(cwd, 'gradlew.bat') : './gradlew';
  const result = spawnSync(command, [...tasks, '--console=plain'], {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, CLAUDE_CONTROL_REPO_ROOT: root },
  });
  return result.status === 0;
}

const assemble = (cwd) => gradle(cwd, ['assembleRelease']);

/** Свободная буква диска для подстановки. */
function freeDriveLetter() {
  const busy = spawnSync('cmd', ['/c', 'subst'], { encoding: 'latin1' }).stdout ?? '';
  for (const letter of 'YXWVUT') {
    if (!busy.includes(`${letter}:\\`) && !existsSync(`${letter}:\\`)) return letter;
  }
  return null;
}

const subst = (args) => spawnSync('cmd', ['/c', 'subst', ...args], { stdio: 'ignore' });

// Старый файл убирается ДО сборки: сорвись она — в корне не останется вчерашней
// сборки, которую легко принять за сегодняшнюю.
if (existsSync(target)) {
  rmSync(target);
  console.log(`Убран прежний ${outputName}`);
}

console.log('Собираю релизный APK — первый раз это минут десять…');
let built;

if (isWindows) {
  // Codegen — с настоящего пути, до подстановки диска (см. шапку файла).
  console.log('Сначала codegen с настоящего пути…');
  if (
    !gradle(androidDir, [
      'generateCodegenSchemaFromJavaScript',
      'generateCodegenArtifactsFromSchema',
    ])
  ) {
    console.error('\nCodegen не отработал.');
    process.exit(1);
  }

  const letter = freeDriveLetter();
  if (!letter) {
    console.error('Нет свободной буквы диска для короткого пути — освободите Y:, X: или W:.');
    process.exit(1);
  }
  subst([`${letter}:`, appsDir]);
  try {
    built = assemble(`${letter}:\\mobile\\android`);
  } finally {
    subst([`${letter}:`, '/D']);
  }
} else {
  built = assemble(androidDir);
}

if (!built) {
  console.error('\nGradle не собрал APK.');
  process.exit(1);
}

// Выходных файлов может быть несколько (разные ABI) — берём самый свежий.
const outDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
const apk = readdirSync(outDir)
  .filter((name) => name.endsWith('.apk'))
  .map((name) => ({ name, time: statSync(join(outDir, name)).mtimeMs }))
  .sort((left, right) => right.time - left.time)[0];

if (!apk) {
  console.error(`Gradle отработал, но APK в ${outDir} не нашёлся.`);
  process.exit(1);
}

copyFileSync(join(outDir, apk.name), target);
const size = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`\nГотово: ${outputName} (${size} МБ) в корне репозитория.`);
console.log('Установка: adb install -r claude-control.apk — или скиньте файл на телефон.');

// Уборка за собой. Промежуточные файлы нативной сборки — десяток гигабайт,
// которые не нужны ни APK, ни репозиторию (см. clean-mobile-build.mjs). APK уже
// скопирован, так что терять нечего; демона Gradle сначала гасим, иначе он
// держит часть файлов открытыми и удаление будет неполным.
if (KEEP_BUILD) {
  console.log('\nПромежуточные файлы сборки оставлены (--keep-build).');
} else {
  console.log('\nУбираю промежуточные файлы сборки…');
  gradle(androidDir, ['--stop']);
  const { count, bytes } = sweepMobileBuild();
  console.log(`Освобождено ${formatGb(bytes)} в ${count} каталогах.`);
  console.log('Следующая сборка будет полной — это плата за то, что диск не пухнет.');
}
