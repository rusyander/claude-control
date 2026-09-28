/**
 * Живое доказательство строки «Тестов» в чате: от файлов проекта до argv CLI.
 *
 * Юнит-тест строки (`tests-chat-wiring.test.ts`) зеленеет, даже когда строка не
 * доезжает до `--append-system-prompt`: слушатель не подключён, чат идёт мимо
 * решателя, дописка склеена не с той. Здесь не подменяется ничего, кроме самого
 * CLI: одноразовая панель (свой каталог конфигурации, дом, порт) и фальшивый
 * `claude` на PATH, который кладёт argv и текст дописки в рабочую папку.
 *
 * Что доказывается, по трём проектам:
 *   1. своя команда (`.agent/tests/automation.json`), папки нет — строка называет
 *      команду, привязку `automation.file` и `run` без `--cmd`, совета завести
 *      Playwright нет, и старт чата ничего в проекте не завёл;
 *   2. папка e2e с тестом — строка о папке, своей команды в ней нет;
 *   3. голый проект — «папки ещё нет», и на диске её тоже нет.
 *
 * Запуск: node tools/qa/check-tests-chat-line.mjs
 * Переменная: CHECK_PANEL_PORT (5463).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5463);
const PANEL = `http://127.0.0.1:${PORT}`;
const DUMP = 'cc-argv-dump.json';
const OWN = 'node tools/qa/junit-run.mjs {files}';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}`);
  if (!ok) bad += 1;
};

/** Фальшивый CLI: argv и дописка (флагом или файлом) — в рабочую папку. */
function fakeCli(bin) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(
    script,
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const at = args.indexOf('--append-system-prompt-file');
const fileText = at >= 0 && existsSync(args[at + 1]) ? readFileSync(args[at + 1], 'utf8') : '';
const inline = args.indexOf('--append-system-prompt');
const append = fileText || (inline >= 0 ? args[inline + 1] : '');
writeFileSync(join(process.cwd(), ${JSON.stringify(DUMP)}), JSON.stringify({ args, append }));
`,
  );
  if (isWindows) {
    writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
}

async function waitForDump(dir, seconds = 30) {
  const path = join(dir, DUMP);
  for (let i = 0; i < seconds * 4; i += 1) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* пишется */
      }
    }
    await wait(250);
  }
  return undefined;
}

async function waitForPanel(seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      if ((await fetch(`${PANEL}/api/system`)).ok) return true;
    } catch {
      /* ещё не поднялась */
    }
    await wait(500);
  }
  return false;
}

async function send(chatId, projectPath) {
  const res = await fetch(`${PANEL}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, prompt: 'напиши тесты на вход', projectPath }),
  });
  return res.status;
}

const root = mkdtempSync(join(tmpdir(), 'cc-tests-chat-line-'));
const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const own = join(root, 'project-own');
const folder = join(root, 'project-folder');
const bare = join(root, 'project-bare');
for (const dir of [home, config, bin, own, folder, bare]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
mkdirSync(join(own, '.agent', 'tests'), { recursive: true });
writeFileSync(
  join(own, '.agent', 'tests', 'automation.json'),
  JSON.stringify({ version: 1, command: OWN }),
);
mkdirSync(join(folder, 'e2e'));
writeFileSync(join(folder, 'playwright.config.ts'), "export default { testDir: 'e2e' };\n");
writeFileSync(join(folder, 'e2e', 'auth.spec.ts'), "test('[auth-001] вход', async () => {});\n");
fakeCli(bin);

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
  {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
      USERPROFILE: home,
      PORT: String(PORT),
      PATH: `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
    },
    stdio: 'ignore',
    shell: false,
  },
);

try {
  check(await waitForPanel(), `одноразовая панель поднялась на ${PANEL}`);

  // 1. Своя команда проекта.
  check((await send('new-line-own', own)) < 300, 'чат проекта со своей командой принят');
  const ownDump = await waitForDump(own);
  const ownLine = ownDump?.append ?? '';
  check(Boolean(ownDump), 'фальшивый CLI выгрузил argv');
  check(
    Boolean(ownDump?.args.some((arg) => arg.startsWith('--append-system-prompt'))),
    'дописка ушла флагом CLI',
  );
  check(ownLine.includes(`"${OWN}"`), 'строка называет команду проекта');
  check(
    ownLine.includes('"automation": {"status": "automated", "file"'),
    'и как привязать проверку к кейсу',
  );
  check(
    ownLine.includes(`run --project "${own}" [--group <group>]`),
    `прогон — run по проекту: …${ownLine.slice(ownLine.indexOf('Run them'), ownLine.indexOf('Run them') + 120)}…`,
  );
  check(!/--cmd\s+"/.test(ownLine), 'своей команды через --cmd не велено');
  check(!/Playwright config|create "e2e\/"/.test(ownLine), 'совета завести Playwright нет');
  check(!existsSync(join(own, 'e2e')), 'старт чата папку e2e не завёл');

  // 2. Папка с тестом.
  check((await send('new-line-folder', folder)) < 300, 'чат проекта с папкой принят');
  const folderLine = (await waitForDump(folder))?.append ?? '';
  check(folderLine.includes('e2e folder "e2e"'), 'строка о папке e2e');
  check(!folderLine.includes(OWN), 'чужой команды в ней нет');

  // 3. Голый проект.
  check((await send('new-line-bare', bare)) < 300, 'чат голого проекта принят');
  const bareLine = (await waitForDump(bare))?.append ?? '';
  check(bareLine.includes('no e2e folder yet'), 'строка: папки ещё нет');
  check(!existsSync(join(bare, 'e2e')), 'и на диске её нет');
} finally {
  server.kill();
  await wait(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(bad === 0 ? '\nитог: всё сошлось' : `\nитог: расхождений ${bad}`);
process.exit(bad === 0 ? 0 : 1);
