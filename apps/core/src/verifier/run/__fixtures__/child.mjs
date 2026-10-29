import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Проверка-подставка для прогонов `run.ts`: настоящий процесс, не макет (P40 — снимается
 * настоящее дерево). Режимы: `env <code>` — печатает метку аренды, временный каталог и утечку
 * окружения ядра, кладёт файл во временный каталог, выходит с кодом; `tree` — заводит внука и
 * висит; `big <bytes>` — печатает столько байт; `vitest-red` — строки FAIL vitest и выход 1.
 */

const [mode, arg] = process.argv.slice(2);

if (mode === 'env') {
  writeFileSync(join(tmpdir(), 'scratch.txt'), 'x');
  process.stdout.write(
    `${JSON.stringify({
      lease: process.env.AGENTDECK_CHECK_LEASE ?? null,
      tmp: tmpdir(),
      leak: process.env.AGENTDECK_RUN_TEST_LEAK ?? null,
      pinned: process.env.PINNED_BY_PROFILE ?? null,
    })}\n`,
  );
  process.exit(Number(arg ?? '0'));
} else if (mode === 'tree') {
  const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  process.stdout.write(`grandchild ${grand.pid}\n`);
  setInterval(() => {}, 1000);
} else if (mode === 'big') {
  const total = Number(arg);
  const line = `${'y'.repeat(1023)}\n`;
  let out = 'HEAD-MARK\n';
  while (out.length < total - 10) out += line;
  process.stdout.write(`${out}TAIL-MARK\n`, () => process.exit(0));
} else if (mode === 'vitest-red') {
  process.stdout.write(' FAIL  src/a.test.ts > outer > breaks on x\n');
  process.stdout.write(' FAIL  src/b.test.ts\n'); // ошибка сбора — не тест
  process.exit(1);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
