/**
 * Мутанты внутри Linux-контейнера `core-linux.mjs --mutants <plan.json>` (P60, правило «проверка,
 * которая не может покраснеть, — украшение»): свойства только для POSIX (exec-бит, группа
 * процессов, метка в environ) на Windows всегда пропускаются, и mustfail там их не видит.
 * Мутация идёт по КОПИИ в контейнере — рабочая копия не трогается.
 *
 * План — тот же формат, что у mustfail: `[{file, find, replace, test, spec}]`, пути от
 * `apps/core`. На каждый спек — сначала зелёный прогон без мутации (тест реально прошёл, не
 * пропущен), затем каждый мутант: `find` ровно один раз, прогон того же теста обязан упасть
 * с его именем в строке FAIL; файл возвращается байт в байт. Выход 1 — хоть один выжил.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const plan = JSON.parse(Buffer.from(process.env.MUTANT_PLAN ?? '', 'base64').toString('utf8'));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function vitest(spec, test) {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', spec, '--coverage.enabled=false', '-t', escape(test)],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Файл `*.alone.test.ts` основной прогон не берёт — только проход-одиночка (vitest.config.ts).
      env: spec.endsWith('.alone.test.ts')
        ? { ...process.env, AGENTDECK_CORE_ALONE: '1' }
        : process.env,
    },
  );
  return { code: run.status, out: stripVTControlCharacters(`${run.stdout}\n${run.stderr}`) };
}

const passed = (out) => Number(/Tests\s+(\d+) passed/.exec(out)?.[1] ?? 0);
let survived = 0;
let broken = 0;

for (const [index, mutant] of plan.entries()) {
  const label = `#${index + 1} ${mutant.file} · ${mutant.test}`;
  const base = vitest(mutant.spec, mutant.test);
  if (base.code !== 0 || passed(base.out) === 0) {
    broken += 1;
    console.log(
      `[mutants] ${label}: BASELINE NOT GREEN (exit ${base.code}, passed ${passed(base.out)})`,
    );
    continue;
  }
  const original = readFileSync(mutant.file, 'utf8');
  const hits = original.split(mutant.find).length - 1;
  if (hits !== 1) {
    broken += 1;
    console.log(`[mutants] ${label}: find occurs ${hits}× — not applied`);
    continue;
  }
  writeFileSync(
    mutant.file,
    original.replace(mutant.find, () => mutant.replace),
  );
  let run;
  try {
    run = vitest(mutant.spec, mutant.test);
  } finally {
    writeFileSync(mutant.file, original);
  }
  // Проверка возврата — после `finally`: брошенное оттуда съело бы исходную ошибку прогона.
  if (readFileSync(mutant.file, 'utf8') !== original)
    throw new Error(`restore failed: ${mutant.file}`);
  const failLine = run.out
    .split('\n')
    .some((line) => /FAIL|×/.test(line) && line.includes(mutant.test));
  if (run.code !== 0 && failLine) console.log(`[mutants] ${label}: RED (killed)`);
  else {
    survived += 1;
    console.log(`[mutants] ${label}: GREEN — survived (exit ${run.code})`);
  }
}
console.log(
  `[mutants] ${plan.length} planned · killed ${plan.length - survived - broken} · survived ${survived} · not run ${broken}`,
);
process.exit(survived || broken ? 1 : 0);
