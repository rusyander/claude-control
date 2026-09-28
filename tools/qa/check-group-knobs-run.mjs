/**
 * Живое доказательство «чисел» группы: от текста скилла до argv прогона.
 *
 * Юнит-тесты домена зеленеют, даже когда порвано всё между ними: маршрут
 * пишет значения не в ту запись, строка собирается, но не доезжает до
 * `--append-system-prompt`, ребёнок разделения не видит группу родителя,
 * выписка зовёт модель на каждом показе. Здесь не подменяется ничего, кроме
 * самого CLI: одноразовая панель (свой каталог конфигурации, дом, порт) и
 * фальшивый `claude` на PATH. Он же отвечает на служебный вызов выписки
 * (`claude -p`, промпт в stdin) — и в его ответе нарочно лежат два
 * выдуманных числа, которые сервер обязан отбросить.
 *
 * Что доказывается:
 *   1. GET отвечает сразу с `pending`, второй — с числами; скилл без цифр
 *      модель не зовёт, повторный показ — тоже (кэш по хэшу);
 *   2. выдуманная цитата и число, которого нет в цитате, отброшены;
 *   3. PUT вне границ — 400; своё значение — `overridden`;
 *   4. строка с изменённым числом доезжает до argv прогона чата группы и до
 *      ребёнка (связь с родителем) — вместе со строкой эскалации работы;
 *   5. возврат к «Авто» (PUT null) — строки нет.
 *
 * Запуск: node tools/qa/check-group-knobs-run.mjs
 * Переменная: CHECK_PANEL_PORT (5197).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5197);
const PANEL = `http://127.0.0.1:${PORT}`;
/** Выгрузка n-го прогона в рабочей папке: `cc-argv-dump-<n>.json`. */
const DUMP = 'cc-argv-dump';
const ASKS = 'assistant-asks.log';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}`);
  if (!ok) bad += 1;
};

const SKILL_TEXT = [
  '---',
  'name: fleet-review',
  'description: Review with a fleet.',
  '---',
  '',
  'Run 2 review rounds before the verdict.',
  'Spawn 3 agents per round, one per lane.',
  '',
].join('\n');

/** Ответ «модели»: два честных числа и два выдуманных. */
const EXTRACTION = {
  knobs: [
    {
      key: 'review-rounds',
      label: { ru: 'Кругов ревью', en: 'Review rounds' },
      default: 2,
      min: 1,
      max: 6,
      quote: 'Run 2 review rounds before the verdict.',
    },
    {
      key: 'agents-per-round',
      label: { ru: 'Агентов на круг', en: 'Agents per round' },
      default: 3,
      min: 1,
      max: 8,
      quote: 'Spawn 3 agents per round',
    },
    {
      key: 'verifiers',
      label: { ru: 'Проверяющих', en: 'Verifiers' },
      default: 2,
      min: 1,
      max: 4,
      quote: 'Use 2 verifiers after each round.',
    },
    {
      key: 'passes',
      label: { ru: 'Проходов', en: 'Passes' },
      default: 5,
      min: 1,
      max: 9,
      quote: 'Run 2 review rounds before the verdict.',
    },
  ],
};

/**
 * Фальшивый CLI на Node: разбор argv — настоящий, без правил cmd. Служебный
 * вызов (`-p` без stream-json) пишет строку в журнал и отвечает выпиской;
 * прогон чата кладёт argv и текст файла дописки в рабочую папку.
 */
function fakeCli(bin, logDir) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const streaming = args.includes('stream-json');
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (args.includes('-p') && !streaming) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const head = input.split('\\n').find((line) => line.startsWith('skill ')) ?? '?';
    appendFileSync(${JSON.stringify(join(logDir, ASKS))}, head + '\\n');
    const lang = /language (\\S+) containing/.exec(input)?.[1] ?? 'json';
    process.stdout.write('\`\`\`' + lang + '\\n' + ${JSON.stringify(JSON.stringify(EXTRACTION))} + '\\n\`\`\`\\n');
  });
} else {
  const at = args.indexOf('--append-system-prompt-file');
  const fileText = at >= 0 && existsSync(args[at + 1]) ? readFileSync(args[at + 1], 'utf8') : '';
  const inline = args.indexOf('--append-system-prompt');
  const append = fileText || (inline >= 0 ? args[inline + 1] : '');
  let n = 0;
  while (existsSync(join(process.cwd(), ${JSON.stringify(DUMP)} + '-' + n + '.json'))) n += 1;
  writeFileSync(join(process.cwd(), ${JSON.stringify(DUMP)} + '-' + n + '.json'), JSON.stringify({ args, append }));
}
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

async function waitForDump(dir, run = 0, seconds = 30) {
  const path = join(dir, `${DUMP}-${run}.json`);
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
      const res = await fetch(`${PANEL}/api/system`);
      if (res.ok) return true;
    } catch {
      /* ещё не поднялась */
    }
    await wait(500);
  }
  return false;
}

async function api(method, path, body) {
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

const asksOf = (root) =>
  existsSync(join(root, ASKS))
    ? readFileSync(join(root, ASKS), 'utf8').split('\n').filter(Boolean)
    : [];

const root = mkdtempSync(join(tmpdir(), 'cc-group-knobs-'));
const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const dirs = Object.fromEntries(
  ['chat', 'kid', 'plain'].map((name) => [name, join(root, `project-${name}`)]),
);
for (const dir of [home, config, bin, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
for (const [id, text] of [
  ['fleet-review', SKILL_TEXT],
  ['plain-skill', '---\nname: plain-skill\ndescription: Say hello.\n---\n\nSay hello politely.\n'],
]) {
  mkdirSync(join(config, 'skills', id), { recursive: true });
  writeFileSync(join(config, 'skills', id, 'SKILL.md'), text, 'utf8');
}
fakeCli(bin, root);

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

  const created = await api('POST', '/api/groups', {
    name: 'Fleet',
    members: [
      { kind: 'skill', id: 'fleet-review' },
      { kind: 'skill', id: 'plain-skill' },
    ],
  });
  check(created.status === 200 && created.json?.id, `группа создана: ${created.status}`);
  const groupId = created.json?.id;

  // 1. Первый показ — сразу, с pending; скилл без цифр не ждёт и модель не зовёт.
  const first = await api('GET', `/api/groups/${groupId}/knobs`);
  check(first.status === 200, `GET knobs: ${first.status}`);
  check(
    JSON.stringify(first.json?.pending) === '["fleet-review"]',
    `первый показ: pending только у скилла с цифрами — ${JSON.stringify(first.json?.pending)}`,
  );
  let view;
  for (let i = 0; i < 60; i += 1) {
    await wait(250);
    view = (await api('GET', `/api/groups/${groupId}/knobs`)).json;
    if (!view?.pending) break;
  }
  const keys = (view?.knobs ?? []).map((knob) => knob.key).sort();
  // 2. Выдуманное отброшено.
  check(
    JSON.stringify(keys) === '["agents-per-round","review-rounds"]',
    `взяты только числа с дословной цитатой: ${JSON.stringify(keys)}`,
  );
  check(
    JSON.stringify(asksOf(root)) === '["skill fleet-review:"]',
    `модель звана один раз и только для скилла с цифрами: ${JSON.stringify(asksOf(root))}`,
  );
  await api('GET', `/api/groups/${groupId}/knobs`);
  check(asksOf(root).length === 1, `повторный показ модель не зовёт: ${asksOf(root).length}`);

  // 3. Границы и своё значение.
  const id = 'fleet-review:review-rounds';
  const tooMany = await api('PUT', `/api/groups/${groupId}/knobs`, { values: { [id]: 99 } });
  check(tooMany.status === 400, `значение вне границ — 400: ${tooMany.status}`);
  const put = await api('PUT', `/api/groups/${groupId}/knobs`, { values: { [id]: 4 } });
  const knob = put.json?.knobs?.find((item) => item.key === 'review-rounds');
  check(put.status === 200 && knob?.value === 4 && knob.overridden, `своё значение: ${put.text}`);

  // 4. Строка доезжает до argv — чату группы и ребёнку.
  const choice = await api('PUT', '/api/chat/new-knobs-chat/group-settings', {
    groupChoice: `global:${groupId}`,
  });
  check(choice.status === 200, `чат выбрал группу: ${choice.status}`);
  const sent = await api('POST', '/api/chat/send', {
    chatId: 'new-knobs-chat',
    prompt: 'проверка',
    projectPath: dirs.chat,
  });
  check(sent.status < 300, `прогон чата принят: ${sent.status}`);
  const chatDump = await waitForDump(dirs.chat);
  const expected = 'fleet-review — Review rounds: 4 (skill default 2)';
  check(Boolean(chatDump?.append.includes(expected)), `в дописке чата: «${expected}»`);
  check(
    Boolean(chatDump?.append.includes('Use exactly these counts on every run without asking')),
    'в дописке чата — взять ровно эти числа, не спрашивая',
  );
  check(!chatDump?.append.includes('Agents per round'), 'неизменённое число в дописку не попало');
  check(
    Boolean(chatDump?.args.some((arg) => arg.startsWith('--append-system-prompt'))),
    `дописка ушла флагом CLI: ${chatDump?.args.filter((a) => a.startsWith('--append')).join(' ')}`,
  );

  const kid = await api('POST', '/api/chat/send', {
    chatId: 'new-knobs-kid',
    prompt: 'проверка',
    projectPath: dirs.kid,
    parentChatId: 'new-knobs-chat',
    parentTitle: 'Родитель',
  });
  check(kid.status < 300, `прогон ребёнка принят: ${kid.status}`);
  const kidDump = await waitForDump(dirs.kid);
  check(
    Boolean(kidDump?.append.includes(expected)),
    'ребёнок на первом ходу (связь ещё не записана) видит числа группы родителя',
  );
  // Второй ход ребёнка идёт дописькой звена (`childAppendPrompt`): числа и
  // строка эскалации работы — из того же `childStageExtra`, что у старта разделения.
  await wait(1500);
  const kid2 = await api('POST', '/api/chat/send', {
    chatId: 'new-knobs-kid',
    prompt: 'проверка 2',
    projectPath: dirs.kid,
  });
  check(kid2.status < 300, `второй ход ребёнка принят: ${kid2.status}`);
  const kid2Dump = await waitForDump(dirs.kid, 1);
  check(Boolean(kid2Dump?.append.includes(expected)), 'звено ребёнка: числа группы родителя');
  check(
    Boolean(kid2Dump?.append.includes('"severity":"critical"')),
    'звену-работе сказано, как поднять критическое в главный чат',
  );

  // 5. Возврат к «Авто» (null) — строки нет.
  const reset = await api('PUT', `/api/groups/${groupId}/knobs`, { values: { [id]: null } });
  check(
    reset.status === 200 && reset.json?.knobs?.every((item) => item.auto && !item.overridden),
    `сброс null: ${reset.status}`,
  );
  const plainChoice = await api('PUT', '/api/chat/new-knobs-plain/group-settings', {
    groupChoice: `global:${groupId}`,
  });
  check(plainChoice.status === 200, `второй чат выбрал группу: ${plainChoice.status}`);
  await api('POST', '/api/chat/send', {
    chatId: 'new-knobs-plain',
    prompt: 'проверка',
    projectPath: dirs.plain,
  });
  const plainDump = await waitForDump(dirs.plain);
  check(Boolean(plainDump), 'фальшивый CLI второго чата выгрузил argv');
  check(
    !plainDump?.append.includes('run counts'),
    `без изменённых чисел строки нет: «${plainDump?.append.slice(0, 80)}…»`,
  );
} finally {
  server.kill();
  await wait(500);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(bad === 0 ? '\nитог: всё сошлось' : `\nитог: расхождений ${bad}`);
process.exit(bad === 0 ? 0 : 1);
