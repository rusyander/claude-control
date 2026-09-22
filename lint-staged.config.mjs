/**
 * ХУК ПЕРЕД КОММИТОМ: те же три проверки, но пачками по длине командной строки.
 *
 * Конфигурация переехала из `package.json` в файл ровно за этим: lint-staged
 * дописывает ВСЕ пути одной строкой аргументов, причём АБСОЛЮТНЫЕ, а команда
 * уходит через `.cmd`-обёртку npm, то есть через `cmd.exe` с его пределом 8191
 * символа. Партия из 191 файла (`da720d6`) на этом и умерла — не на правиле, а на
 * длине, — и коммит прошёл только с `--no-verify`, то есть без проверок вовсе.
 * Измерено на партии из 232 файлов: одной командой это 10769 символов у eslint и
 * 17222 у `check-lf.mjs`; пачками — не больше 5977. Функция вместо строки
 * возвращает НЕСКОЛЬКО команд, поэтому число файлов в коммите перестаёт быть
 * ограничением.
 *
 * Бюджет 6000 символов на пачку: запас до 8191 нужен на саму команду, на флаги и
 * на кавычки вокруг путей с пробелами и кириллицей.
 */
const ARGV_BUDGET = 6000;

/** Пути пачками так, чтобы аргументы одной команды не превысили бюджет. */
function chunk(files) {
  const chunks = [[]];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 3; // кавычки и пробел
    if (length + cost > ARGV_BUDGET && chunks.at(-1).length > 0) {
      chunks.push([]);
      length = 0;
    }
    chunks.at(-1).push(file);
    length += cost;
  }
  return chunks;
}

/** Одна команда на пачку; путь в кавычках — в нём бывают пробелы и кириллица. */
const perChunk = (command) => (files) =>
  chunk(files).map((batch) => `${command} ${batch.map((file) => `"${file}"`).join(' ')}`);

export default {
  '*.{ts,tsx,js,mjs,cjs}': (files) => [
    ...perChunk('eslint --no-warn-ignored')(files),
    ...perChunk('prettier --check --ignore-unknown')(files),
  ],
  '*.{json,md,scss,css,yml,yaml,html}': perChunk('prettier --check --ignore-unknown'),
  '*': perChunk('node tools/check-lf.mjs'),
};
