/**
 * Обходы доступности (axe, обе темы) и клавиатуры только по страницам ядра (`--only core` обоих
 * обходов): список задач, запуск, сценарии и лента подменной задачи из `core-task-stub.mjs`.
 * Нужен живой стенд (`pnpm dev`, :8888). Кейс Tests-блока ссылается на этот файл: привязка — путь
 * без аргументов, а полный обход всех разделов для кейса ядра слишком широк и долог.
 *
 * Код выхода: 0 — оба обхода чисты; 1 — нарушение; 2 — не проверено (обход не нашёл страниц).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let worst = 0;
for (const script of ['check-a11y.mjs', 'check-keyboard.mjs']) {
  const run = spawnSync(process.execPath, [join(HERE, script), '--only', 'core'], {
    stdio: 'inherit',
  });
  const code = run.status ?? 1;
  console.log(`${script} --only core → код ${code}`);
  // Провал важнее «не проверено»: 1 перекрывает 2, 2 перекрывает 0.
  if (code === 1 || (code !== 0 && worst !== 1)) worst = code === 1 ? 1 : 2;
}
process.exit(worst);
