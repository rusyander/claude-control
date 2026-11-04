/**
 * Проверка `tools/help-shots/clear-home.mjs` на НАСТОЯЩИХ занятых каталогах, без подмены `rmSync`.
 *
 * Поводом был прогон 03.11.2026: пустой `.cc-help-portability\.agentdeck\core` держал чужой
 * процесс, и съёмка переносимости падала до первого кадра. Здесь каталог занимает дочерний процесс
 * этой же проверки (его рабочий каталог — тот самый каталог), а файл держит дочерний PowerShell,
 * открывший его без общего доступа (`FileShare.None`). Гасятся только эти дочерние процессы.
 *
 *   1. занятый ПУСТОЙ каталог в глубине дома: соседи сняты, он и его родители до дома оставлены,
 *      список оставленных называет ровно его — родителей никто не держит;
 *   2. занятый файл в доме: очистка падает `HomeHeldError` с путём этого файла;
 *   3. свободный дом снимается целиком, список пуст; несуществующий — пустой список без ошибки.
 *
 * Только Windows: на Linux и macOS открытый каталог удаляется свободно, занять его нечем.
 * Запуск: node tools/qa/check-clear-home.mjs — код выхода 0 при зелёном.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearHomeByContent, HomeHeldError } from '../help-shots/clear-home.mjs';

if (process.platform !== 'win32') {
  console.log('пропуск: занять каталог открытым дескриптором можно только на Windows');
  process.exit(0);
}

const children = [];
const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

/** Дочерний процесс, который печатает `ready`, когда держит то, что должен. */
function hold(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  return new Promise((done, fail) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('ready')) done(child);
    });
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) =>
      fail(new Error(`держатель вышел (${code}) раньше готовности: ${out}`)),
    );
  });
}

/** Каталог занят: рабочий каталог живого процесса. */
const holdDir = (dir) =>
  hold(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { cwd: dir });

/** Файл занят: открыт без общего доступа. */
const holdFile = (file) =>
  hold('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$f = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'None'); ` +
      "Write-Output 'ready'; Start-Sleep -Seconds 120; $f.Close()",
  ]);

const release = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill();
  await exited;
};

const root = mkdtempSync(join(tmpdir(), 'check-clear-home-'));
try {
  // 1. Занятый пустой каталог в глубине: home/.agentdeck/core держит процесс.
  {
    const home = join(root, 'held-empty');
    const core = join(home, '.agentdeck', 'core');
    mkdirSync(core, { recursive: true });
    mkdirSync(join(home, 'projects', 'demo'), { recursive: true });
    writeFileSync(join(home, 'projects', 'demo', 'note.md'), 'x');
    writeFileSync(join(home, '.agentdeck', 'state.json'), '{}');
    writeFileSync(join(home, 'top.txt'), 'x');
    const holder = await holdDir(core);
    let kept;
    let thrown;
    try {
      kept = clearHomeByContent(home);
    } catch (error) {
      thrown = error;
    }
    expect(
      !thrown,
      `занятый пустой каталог: очистка без ошибки${thrown ? ` (${thrown.message})` : ''}`,
    );
    expect(
      JSON.stringify(kept) === JSON.stringify([core]),
      `в списке оставленных ровно занятый core: ${JSON.stringify(kept)}`,
    );
    expect(existsSync(core) && readdirSync(core).length === 0, 'занятый каталог на месте и пуст');
    expect(
      JSON.stringify(readdirSync(home)) === JSON.stringify(['.agentdeck']) &&
        JSON.stringify(readdirSync(join(home, '.agentdeck'))) === JSON.stringify(['core']),
      `соседи сняты: дом = ${JSON.stringify(readdirSync(home))}`,
    );
    await release(holder);
  }

  // 2. Занятый файл: внутри остаётся содержимое — отказ с путём файла.
  {
    const home = join(root, 'held-file');
    const deep = join(home, '.agentdeck', 'core');
    mkdirSync(deep, { recursive: true });
    const locked = join(deep, 'journal.log');
    writeFileSync(locked, 'x');
    writeFileSync(join(home, 'top.txt'), 'x');
    const holder = await holdFile(locked);
    let thrown;
    try {
      clearHomeByContent(home);
    } catch (error) {
      thrown = error;
    }
    expect(
      thrown instanceof HomeHeldError,
      `занятый файл: HomeHeldError (${thrown?.name ?? 'нет ошибки'})`,
    );
    expect(thrown?.path === locked, `ошибка называет занятый файл: ${thrown?.path}`);
    expect(existsSync(locked), 'занятый файл на месте');
    await release(holder);
  }

  // 3. Свободный дом и несуществующий дом.
  {
    const home = join(root, 'free');
    mkdirSync(join(home, '.agentdeck', 'core'), { recursive: true });
    writeFileSync(join(home, '.agentdeck', 'core', 'a.json'), '{}');
    const kept = clearHomeByContent(home);
    expect(kept.length === 0 && !existsSync(home), 'свободный дом снят целиком, оставленных нет');
    const none = clearHomeByContent(join(root, 'missing'));
    expect(none.length === 0, 'несуществующий дом — пустой список');
  }
} finally {
  for (const child of children) await release(child);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nзелёный' : `\nкрасных ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
