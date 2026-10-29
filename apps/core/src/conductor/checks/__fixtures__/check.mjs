import { appendFileSync } from 'node:fs';

/**
 * Проверка-подставка для входа проверки: настоящий процесс раннера. Каждый запуск дописывает
 * строку в `CHECK_COUNTER` (сколько раз ядро запускало — P68 «один ключ — один прогон»).
 * Поведение — `CHECK_MODE` пина (в ключ не входит): pass | fail | flaky (полный прогон красный,
 * узкий `--tests …` зелёный) | slow (ждёт `CHECK_SLOW_MS`, затем зелёный) | loud (3 МБ, затем красный).
 * Аргументы: <unit> [--tests <name>…].
 */

const args = process.argv.slice(2);
const counter = process.env.CHECK_COUNTER;
if (counter) appendFileSync(counter, `${JSON.stringify(args)}\n`);
const mode = process.env.CHECK_MODE ?? 'pass';
const narrowed = args.includes('--tests');

function red() {
  // Итог раннера, как у настоящего vitest: по нему флаки сверяет, что каждый упавший назван.
  process.stdout.write(' FAIL  src/a.test.ts > suite > breaks\n      Tests  1 failed (1)\n');
  process.exit(1);
}

if (mode === 'fail') red();
else if (mode === 'loud') {
  // 3 МБ вывода — больше потолка раннера (2 МБ): лог записи срезан до головы и хвоста.
  process.stdout.write(`${'x'.repeat(1023)}\n`.repeat(3 * 1024), () => red());
} else if (mode === 'flaky') {
  // Узкий зелёный печатает итог vitest: без него ядро не засчитывает зелёный (0 тестов ≠ pass).
  // `CHECK_SLOW_MS` держит узкий повтор живым — чтобы ядро успело ударить сердцем во время него.
  if (narrowed) {
    setTimeout(
      () => {
        process.stdout.write(' Tests  1 passed (1)\n');
        process.exit(0);
      },
      Number(process.env.CHECK_SLOW_MS ?? '0'),
    );
  } else red();
} else if (mode === 'slow') {
  setTimeout(() => process.exit(0), Number(process.env.CHECK_SLOW_MS ?? '1500'));
} else process.exit(0);
