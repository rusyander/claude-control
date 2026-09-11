/**
 * Сверка справки с кодом: «этот раздел я перечитал, он описывает сегодняшнее
 * поведение».
 *
 * Зачем это вообще есть. Справка стареет не тогда, когда её удаляют, а тогда,
 * когда меняют код, который она описывает: файл на месте, ссылки живые,
 * подписи есть, а написана в нём позавчерашняя правда. Поймать это прогоном
 * нельзя — прочитать документ и код и сказать «сходится» может только человек.
 * Поэтому машина делает ровно ту часть, которую умеет: помнит, КАКИМ был код в
 * момент последней сверки, и краснеет, когда он стал другим
 * (`tools/qa/check-help-shots.mjs`).
 *
 * Отсюда главное свойство этого инструмента: он НЕ чинит справку и не
 * проверяет её. Он записывает заявление человека. Автоматического «подтвердить
 * всё» нет намеренно — оно превратило бы правило в шум, который гасят одной
 * командой не открывая документ. Раздел называется руками, по одному.
 *
 * Опись: `apps/web/public/help/sources.json`. Запись раздела — документ,
 * список исходников с причиной «почему этот файл» и отпечаток каждого.
 * Добавить раздел под наблюдение = дописать ОДНУ запись и выполнить эту
 * команду; больше нигде ничего править не нужно.
 *
 * Запуск: node tools/help-shots/sources.mjs <раздел>
 *         node tools/help-shots/sources.mjs           — что под наблюдением
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  SOURCES_MANIFEST,
  readSourceManifest,
  writeSourceManifest,
  sourceFingerprint,
} from './kit.mjs';

/** Чтение файла репозитория по пути из описи. Нет файла или это папка — undefined. */
function readRepoFile(path) {
  const full = join(REPO_ROOT, path);
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return readFileSync(full, 'utf8');
}

const manifest = readSourceManifest();
const topics = manifest.topics ?? [];
const wanted = process.argv[2];

if (!wanted) {
  console.log(`Под наблюдением разделов: ${topics.length}`);
  for (const entry of topics) {
    const sources = entry.sources ?? [];
    const moved = sources.filter((source) => {
      const text = readRepoFile(source.path);
      return text === undefined || sourceFingerprint(text) !== source.sha;
    });
    console.log(
      `  ${entry.topic}: исходников ${sources.length}` +
        (moved.length ? `, разошлось ${moved.length}` : ', расхождений нет') +
        (entry.confirmedAt
          ? `, сверка ${entry.confirmedAt.slice(0, 10)}`
          : ', ни разу не сверялся'),
    );
  }
  console.log('\nПодтвердить раздел: node tools/help-shots/sources.mjs <раздел>');
  // Ненулевой код намеренно: команда без раздела ничего не подтвердила.
  process.exit(1);
}

const entry = topics.find((topic) => topic.topic === wanted);
if (!entry) {
  console.log(
    `Раздела «${wanted}» в описи ${SOURCES_MANIFEST} нет. Есть: ` +
      (topics.map((topic) => topic.topic).join(', ') || '(пусто)'),
  );
  console.log(
    'Новый раздел заводится записью в описи: document, sources (path + why), пустые sha.',
  );
  process.exit(1);
}

const sources = entry.sources ?? [];
const missing = sources.filter((source) => readRepoFile(source.path) === undefined);
if (missing.length > 0) {
  // Подтвердить опись, которая указывает в никуда, значит заморозить ложь:
  // отпечаток совпадать перестанет навсегда, а причина исчезнет из вида.
  console.log('Не подтверждено — эти пути из описи не читаются:');
  for (const source of missing) console.log(`  ${source.path}`);
  console.log('Поправьте путь в описи (файл переехал) или уберите запись (поведение исчезло).');
  process.exit(1);
}

console.log(`Раздел «${entry.topic}», документ ${entry.document}`);
let changed = 0;
for (const source of sources) {
  const current = sourceFingerprint(readRepoFile(source.path));
  if (current === source.sha) {
    console.log(`  = ${source.path}`);
    continue;
  }
  console.log(`  ${source.sha ? '~' : '+'} ${source.path} — ${source.why}`);
  source.sha = current;
  changed += 1;
}

entry.confirmedAt = new Date().toISOString();
writeSourceManifest(manifest);

console.log(
  changed === 0
    ? '\nРасхождений не было, отметка о сверке обновлена.'
    : `\nОтпечатков обновлено: ${changed}.`,
);
// Последняя строка — про смысл действия, а не про файл: подтверждение
// означает, что документ перечитан и описывает новое поведение. Проверить это
// прогоном невозможно, поэтому сказано вслух.
console.log(
  `Это заявление, что ${entry.document} перечитан и описывает сегодняшнее поведение. ` +
    'Если документ ещё не поправлен — сначала поправьте его.',
);
