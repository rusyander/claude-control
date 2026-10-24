/**
 * Снятие остатков живой проверки (`reap` из `foreign-cli.mjs`) не трогает чужие CLI.
 *
 * kit-029 (24.10): 3 из 8 прогонов теряли OpenCode на старте — соседняя проверка снимала
 * всякий процесс из каталога CLI, родившийся после её начала, а под тем же каталогом и
 * CLI другой проверки, и чат человека в живой панели.
 *
 * Сценарий на настоящей таблице процессов ОС, CLI — заглушка в своём каталоге:
 * прогон R запомнил «до»; ПОСЛЕ этого сосед N (не потомок R, жив) запускает свой CLI F1;
 * R запускает своего ребёнка F2 и сироту F3 (промежуточный процесс вышел — как стенд,
 * снятый жёстко); R зовёт `reap`. Ждём: F1 жив, F2 и F3 сняты.
 *
 * Запуск: node tools/qa/check-qa-reap.mjs — выход 0 «Всё сходится.», 1 — расхождение.
 */
import { fork, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLEEP = 'setInterval(() => undefined, 1000);\n';
const ROLE = process.argv[2];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const message = (proc) => new Promise((done) => proc.once('message', done));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

if (ROLE === 'run') {
  // Прогон R: «до» — в начале, остаток — после соседа.
  const { cliProcesses, reap } = await import('./foreign-cli.mjs');
  const dir = process.argv[3];
  const before = cliProcesses(dir, 'fakecli');
  process.send({ step: 'before' });
  await message(process);
  const own = spawn(process.execPath, [join(dir, 'fakecli')], { stdio: 'ignore' });
  const middle = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'fakecli'))}], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let out = '';
  middle.stdout.on('data', (chunk) => (out += chunk));
  await new Promise((done) => middle.once('exit', done));
  const orphan = Number(out.trim());
  await wait(500);
  reap(before, dir, 'fakecli');
  await wait(1500);
  process.send({ step: 'reaped', own: own.pid, orphan });
  await message(process);
  process.exit(0);
} else if (ROLE === 'neighbour') {
  const cli = spawn(process.execPath, [join(process.argv[3], 'fakecli')], { stdio: 'ignore' });
  process.send({ pid: cli.pid });
  setInterval(() => undefined, 1000);
} else {
  const self = fileURLToPath(import.meta.url);
  const root = mkdtempSync(join(tmpdir(), 'qa-reap-'));
  const dir = join(root, 'fakecli-bin');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fakecli'), SLEEP);

  const fails = [];
  const check = (name, ok) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) fails.push(name);
  };
  const leftovers = [];
  try {
    const run = fork(self, ['run', dir], { stdio: 'ignore' });
    await message(run);
    const neighbour = fork(self, ['neighbour', dir], { stdio: 'ignore' });
    leftovers.push(neighbour.pid);
    const { pid: foreign } = await message(neighbour);
    leftovers.push(foreign);
    await wait(500);
    run.send('go');
    const result = await message(run);
    leftovers.push(result.own, result.orphan);
    check(`CLI соседа, запущенный после «до» прогона, жив (pid ${foreign})`, alive(foreign));
    check(`ребёнок прогона снят (pid ${result.own})`, !alive(result.own));
    check(`сирота прогона снята (pid ${result.orphan})`, !alive(result.orphan));
    run.send('done');
  } finally {
    for (const pid of leftovers) {
      try {
        if (pid) process.kill(pid);
      } catch {
        // уже вышел
      }
    }
    await wait(300);
    rmSync(root, { recursive: true, force: true });
  }
  console.log(fails.length ? `\nРасхождений: ${fails.length}` : '\nВсё сходится.');
  process.exit(fails.length ? 1 : 0);
}
