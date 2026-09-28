/**
 * Переписать описи вариантов (`<раздел>/variants.json`) по описям сценариев.
 *
 * Обычно это делает сама съёмка (`finish()` в `kit.mjs`). Отдельная команда
 * нужна, когда описи сценариев поменялись без съёмки — например, кадр снят с
 * учёта руками, — и `pnpm shots` сказал, что опись вариантов отстала.
 *
 * Запуск: node tools/help-shots/variants.mjs [раздел…]  (без аргументов — все)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SHOTS_ROOT, readTopicManifests, writeVariantIndex } from './kit.mjs';

const wanted = process.argv.slice(2);
const topics = readdirSync(SHOTS_ROOT).filter(
  (name) =>
    statSync(join(SHOTS_ROOT, name)).isDirectory() &&
    readTopicManifests(name).length > 0 &&
    (wanted.length === 0 || wanted.includes(name)),
);
for (const name of wanted) {
  if (!topics.includes(name) && !existsSync(join(SHOTS_ROOT, name))) {
    console.error(`раздела ${name} в каталоге снимков нет`);
    process.exitCode = 1;
  }
}
for (const topic of topics) {
  writeVariantIndex(topic);
  console.log(`опись вариантов переписана: ${topic}`);
}
