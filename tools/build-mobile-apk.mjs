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
 * ## Почему на Windows сборка идёт из короткой копии с подставленного диска
 *
 * `ninja` из Android SDK (1.10.2 при CMake 3.22.1) не открывает путь длиннее 260
 * символов, даже когда длинные пути в самой Windows включены. Длинные пути
 * нативной сборки бывают двух видов, и лечатся они по-разному.
 *
 * Проект. Codegen react-native-gesture-handler зеркалит путь исходника внутрь
 * имени объектного файла: из `apps/mobile/node_modules/...` выходит строка под
 * 280 символов, и сборка падает ещё до компиляции. Поэтому каталог с
 * приложением подставляется отдельной буквой диска (`subst`) — те же файлы
 * становятся `Y:\mobile\...`. Отладочная сборка (`pnpm mobile`) проходит и без
 * этого: у неё имя каталога короче на длину `RelWithDebInfo`.
 *
 * Библиотеки. Подставленный диск — это тот же том, и всякий, кто спрашивает у
 * Windows настоящее имя файла, получает обратно путь до подстановки.
 * Автолинковка Expo так и делает, поэтому reanimated и expo-modules-core
 * собираются по настоящему пути. Из корня в 22 символа (`C:\work\<имя клона>`)
 * самый длинный их путь — 240; копия `<repo>-worktrees/<ветка>` длиннее на 27 и
 * уже не проходит, как и клон где-нибудь в `Documents\GitHub\...`. Ссылка на
 * каталог разворачивается в тот же настоящий путь, так что помогает только
 * короткий НАСТОЯЩИЙ путь: сборка идёт из копии `apps/mobile` в
 * `C:\adapk\<метка клона>` (`shortCopyDir`), и диск подставляется уже на неё.
 * Копия — зеркало (`robocopy /MIR`): повторно переносится только изменённое, а
 * промежуточные файлы сборки не копируются ни туда, ни обратно.
 *
 * С подставленного диска до корня репозитория подъёмом на два уровня уже не
 * дойти, а Metro читает оттуда один общий модуль контрактов — корень передаётся
 * ему переменной `AGENTDECK_REPO_ROOT` (её понимает `metro.config.js`).
 *
 * ## Почему codegen запускается ОТДЕЛЬНО и с настоящего пути
 *
 * Раз библиотеки приезжают в Gradle с корнем `C:`, а сам проект живёт на `Y:`,
 * codegen React Native строит из этой пары относительный путь и падает на
 * `different roots`. Лечится тем, что codegen прогоняется заранее с настоящего
 * пути копии — там оба корня совпадают, — а на `Y:` его задачи уже готовы. Дело
 * это чисто JS-овое, секунды.
 *
 * Запуск: `pnpm mobile:apk`. Нужны JDK 17 и Android SDK — те же, что для
 * `pnpm mobile`.
 *
 * После успешной сборки промежуточные файлы удаляются сами
 * (`clean-mobile-build.mjs`), на Windows — вместе с короткой копией: иначе они
 * копятся десятками гигабайт внутри `node_modules`. Нужна быстрая пересборка
 * подряд — `pnpm mobile:apk --keep-build`.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDirsOf,
  formatGb,
  lockedNote,
  shortCopyDir,
  sweepMobileBuild,
} from './clean-mobile-build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appsDir = join(root, 'apps');
const androidDir = join(appsDir, 'mobile', 'android');
const outputName = 'agentdeck.apk';
const target = join(root, outputName);
const isWindows = process.platform === 'win32';
/** Промежуточные файлы обычно не нужны; `--keep-build` бережёт время пересборки. */
const KEEP_BUILD = process.argv.includes('--keep-build');

/**
 * Адрес панели, который попадёт в сборку как значение по умолчанию: экран
 * сопряжения покажет его заполненным, и APK можно отдать другому человеку, не
 * диктуя адрес голосом. Источник — переменная `MOBILE_DEFAULT_URL` либо файл
 * `apps/mobile/.panel-url` (он в игноре: тайлнет-имя машины личное, а
 * репозиторий публичный). Токен так НЕ передаётся никогда: APK распаковывается
 * одной командой, а токен равен полному доступу к машине.
 */
const urlFile = join(appsDir, 'mobile', '.panel-url');
const defaultUrl = (
  process.env.MOBILE_DEFAULT_URL ?? (existsSync(urlFile) ? readFileSync(urlFile, 'utf8') : '')
).trim();

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
    env: { ...process.env, AGENTDECK_REPO_ROOT: root, MOBILE_DEFAULT_URL: defaultUrl },
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

/**
 * Зеркало `apps/mobile` в короткую копию. Промежуточная сборка исключена с
 * обеих сторон: из исходника её не тащим, а в копии, оставленной
 * `--keep-build`, `/MIR` её не стирает — пересборка подряд остаётся быстрой.
 */
function mirrorMobile(from, to) {
  const skip = ['.cxx', ...buildDirsOf(from), ...buildDirsOf(to)];
  const flags = ['/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1'];
  const result = spawnSync('robocopy', [from, to, ...flags, '/XD', ...skip], {
    stdio: 'inherit',
  });
  // Коды robocopy до 7 — успех разной степени (скопировано, лишнее убрано), от 8 — сбой.
  return result.status !== null && result.status < 8;
}

// Старый файл убирается ДО сборки: сорвись она — в корне не останется вчерашней
// сборки, которую легко принять за сегодняшнюю.
if (existsSync(target)) {
  rmSync(target);
  console.log(`Убран прежний ${outputName}`);
}

console.log(
  defaultUrl
    ? `Адрес панели в сборке: ${defaultUrl} (токен НЕ вшивается)`
    : 'Адрес панели в сборке не задан — поле останется пустым (MOBILE_DEFAULT_URL или apps/mobile/.panel-url)',
);
console.log('Собираю релизный APK — первый раз это минут десять…');
let built;
/** Где Gradle собирал: на Windows — короткая копия, иначе сам проект. */
let buildAndroid = androidDir;

if (isWindows) {
  // Короткая копия, codegen с её настоящего пути, затем подстановка диска (шапка файла).
  const copy = shortCopyDir();
  buildAndroid = join(copy, 'mobile', 'android');
  console.log(`Копирую apps/mobile в ${copy} — короткий путь для нативной сборки…`);
  try {
    mkdirSync(copy, { recursive: true });
  } catch (error) {
    console.error(
      `Не удалось создать ${copy} (${error.code}) — задайте AGENTDECK_APK_DIR: короткий путь, куда можно писать.`,
    );
    process.exit(1);
  }
  if (!mirrorMobile(join(appsDir, 'mobile'), join(copy, 'mobile'))) {
    console.error('\nКопия apps/mobile не сделалась (robocopy).');
    process.exit(1);
  }

  console.log('Сначала codegen с настоящего пути…');
  if (
    !gradle(buildAndroid, [
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
  subst([`${letter}:`, copy]);
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
const outDir = join(buildAndroid, 'app', 'build', 'outputs', 'apk', 'release');
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
console.log('Установка: adb install -r agentdeck.apk — или скиньте файл на телефон.');

// Уборка за собой. Промежуточные файлы нативной сборки — десяток гигабайт,
// которые не нужны ни APK, ни репозиторию (см. clean-mobile-build.mjs). APK уже
// скопирован, так что терять нечего; демона Gradle сначала гасим, иначе он
// держит часть файлов открытыми и удаление будет неполным.
if (KEEP_BUILD) {
  console.log('\nПромежуточные файлы сборки оставлены (--keep-build).');
} else {
  console.log('\nУбираю промежуточные файлы сборки…');
  gradle(androidDir, ['--stop']);
  const { count, bytes, locked } = sweepMobileBuild();
  console.log(`Освобождено ${formatGb(bytes)} в ${count} каталогах.`);
  // APK уже лежит в корне: недоубранный каталог — повод сказать, а не провалить сборку.
  const note = lockedNote(locked);
  if (note) console.log(note);
  console.log('Следующая сборка будет полной — это плата за то, что диск не пухнет.');
}
