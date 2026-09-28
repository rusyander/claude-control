/**
 * Живое доказательство «Пути» группы: от сохранённого шага до того, что читает
 * процесс CLI.
 *
 * Тест маршрута чата (`chat-routes.path-steps.integration.test.ts`) подменяет
 * сам прогон — зелёный там совместим с тем, что шаг не доезжает ни до
 * `--append-system-prompt`, ни до отдельного хода после стадии. Здесь не
 * подменяется ничего, кроме самого CLI: одноразовая панель (свой каталог
 * конфигурации, дом, порт) и фальшивый `claude` на PATH, который записывает
 * каждый ход — рабочую папку, добавку к системному промпту и промпт.
 *
 * Что доказывается:
 *   1. конвейер: свой шаг «после плана» и шаг внутри скилла доезжают до
 *      добавки обычного чата английской стороной, со своим местом; русская
 *      сторона модели не уходит;
 *   2. сценарий из 80 шагов (с шагами-ресурсами скилла и хука): все 80 по
 *      порядку, строки ресурсов, без подсказки конвейера;
 *   3. ход стадии ребёнка разделения: после стадии «fix» — ОТДЕЛЬНЫЙ ход с
 *      английским текстом шага, названной стадией и условием «готово»;
 *      проваленное условие останавливает цепочку.
 *
 * Запуск: node tools/qa/check-group-path-run.mjs
 * Переменная: CHECK_PANEL_PORT (5213).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const PORT = Number(process.env.CHECK_PANEL_PORT ?? 5213);
const PANEL = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (ok, text, actual = '') => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО ×'} ${text}${actual !== '' ? ` — видно: ${actual}` : ''}`);
  if (!ok) bad += 1;
};

/**
 * Фальшивый `claude`: пишет каждый ход в `turns.jsonl` и отвечает одним
 * сообщением. Промпт с условием «готово» получает ответ «не пройдено» — так
 * видно, что цепочка шагов на нём останавливается.
 */
function fakeCli(bin, logDir) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = (o) => appendFileSync(${JSON.stringify(join(logDir, 'turns.jsonl'))}, JSON.stringify(o) + '\\n');
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const streaming = args.includes('stream-json');
const at = args.indexOf('--append-system-prompt-file');
const fileText = at >= 0 && existsSync(args[at + 1]) ? readFileSync(args[at + 1], 'utf8') : '';
const inline = args.indexOf('--append-system-prompt');
const append = fileText || (inline >= 0 ? args[inline + 1] : '');
const live = args.includes('--input-format');
const sid = 'sess-' + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const reply = (prompt) => {
  log({ cwd: process.cwd(), live, append, prompt });
  let text = 'Done.';
  if (prompt.includes('This step is closed only when')) {
    text = 'Checked.\\n\\n\\u0060\\u0060\\u0060agentdeck:gate\\n{"passed": false, "note": "not yet"}\\n\\u0060\\u0060\\u0060';
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-x', tools: [] });
  out({ type: 'assistant', session_id: sid, message: { id: 'm' + Date.now(), role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 });
};
process.stdin.setEncoding('utf8');
if (!streaming) {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => { process.stdout.write('ok\\n'); });
} else if (live) {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== 'user') continue;
      const c2 = msg.message?.content;
      reply(typeof c2 === 'string' ? c2 : (c2 ?? []).map((p) => p.text ?? '').join(''));
    }
  });
  // Панель закрыла ввод — процесс уходит вслед, а не висит.
  process.stdin.on('end', () => process.exit(0));
  // На Windows между панелью и нами обёртка cmd.exe: панель ушла, а ввод не
  // закрылся — три процесса пережили прогон и держали его каталог. Поэтому
  // ещё и смотрим, жива ли панель, по её порту (PORT унаследован).
  setInterval(() => {
    fetch('http://127.0.0.1:' + process.env.PORT + '/api/system', { signal: AbortSignal.timeout(2000) })
      .catch(() => process.exit(0));
  }, 1000);
} else {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => { reply(input); process.exit(0); });
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

async function waitForPanel(seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      if ((await fetch(`${PANEL}/api/system`)).ok) return true;
    } catch {
      // ещё поднимается
    }
    await wait(500);
  }
  return false;
}

const turnsOf = (root) =>
  existsSync(join(root, 'turns.jsonl'))
    ? readFileSync(join(root, 'turns.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

async function waitTurns(root, pred, seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const found = turnsOf(root).filter(pred);
    if (found.length) return found;
    await wait(250);
  }
  return [];
}

const root = mkdtempSync(join(tmpdir(), 'cc-path-run-'));
const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const dirs = Object.fromEntries(
  ['conv', 'scen', 'fix'].map((n) => [n, join(root, `project-${n}`)]),
);
for (const dir of [home, config, bin, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
const SKILL = [
  '---',
  'name: flow-skill',
  'description: A numbered flow.',
  '---',
  '',
  '## 1. Read',
  'read',
  '## 2. Fix',
  'fix',
  '## 3. Ship',
  'ship',
  '',
].join('\n');
mkdirSync(join(config, 'skills', 'flow-skill'), { recursive: true });
writeFileSync(join(config, 'skills', 'flow-skill', 'SKILL.md'), SKILL, 'utf8');
fakeCli(bin, root);

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: config,
  HOME: home,
  USERPROFILE: home,
  PORT: String(PORT),
  PATH: `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
};
const boot = () =>
  spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
    { env, stdio: 'ignore', shell: false },
  );
const NOW = '2026-09-27T00:00:00.000Z';
const step = (id, anchor, order, en, extra = {}) => ({
  id,
  anchor,
  order,
  kind: 'prompt',
  title: { ru: `Шаг ${id}`, en: `Step ${id}` },
  prompt: { ru: `Сделай ${id}`, en },
  source: 'ru',
  createdAt: NOW,
  ...extra,
});

let server = boot();
try {
  check(await waitForPanel(), 'одноразовая панель поднялась');
  const location = await api('GET', '/api/location');
  const appData = location.json?.paths?.appData ?? location.json?.appData;

  // ---------- 1. Конвейер: шаг после плана и шаг внутри скилла ----------
  const conv = await api('POST', '/api/groups', {
    name: 'Conveyor',
    members: [{ kind: 'skill', id: 'flow-skill' }],
  });
  check(conv.status === 200, 'группа-конвейер создана', conv.status);
  const saved = await api('PUT', `/api/groups/${conv.json?.id}/path/steps`, {
    steps: [
      step('after-plan', 'plan', 0, 'MARK_AFTER_PLAN run lint.', {
        gate: { ru: 'чисто', en: 'lint is clean' },
      }),
      step('inside', 'work', 0, 'MARK_INSIDE_SKILL take a shot.', {
        within: { skillId: 'flow-skill', index: 0, after: 'Read' },
      }),
    ],
  });
  check(saved.status === 200, 'шаги конвейера сохранены', saved.status);
  await api('PUT', '/api/chat/path-conv/group-settings', {
    groupChoice: `global:${conv.json?.id}`,
  });
  const sent1 = await api('POST', '/api/chat/send', {
    chatId: 'path-conv',
    prompt: 'hello',
    projectPath: dirs.conv,
  });
  check(sent1.status < 300, 'обычный чат с конвейером принят', sent1.status);
  const [turn1] = await waitTurns(root, (turn) => turn.cwd === dirs.conv);
  const append1 = turn1?.append ?? '';
  check(Boolean(turn1), 'CLI получил ход чата конвейера');
  check(append1.includes('MARK_AFTER_PLAN'), 'свой шаг — в добавке к системному промпту');
  check(append1.includes('After plan'), 'шаг стоит «после плана»');
  check(
    append1.includes('MARK_INSIDE_SKILL') && append1.includes('right after its step "Read"'),
    'шаг внутри скилла — со своим местом',
  );
  check(!append1.includes('Сделай'), 'русская сторона шага модели не уходит');

  // ---------- 2. Сценарий из 80 шагов ----------
  const scen = await api('POST', '/api/groups', {
    name: 'Scenario',
    flow: 'scenario',
    members: [{ kind: 'skill', id: 'flow-skill' }],
  });
  check(
    scen.status === 200 && scen.json?.flow === 'scenario',
    'сценарий создан, flow сохранён',
    `${scen.status} ${scen.json?.flow}`,
  );
  const many = Array.from({ length: 80 }, (_, i) =>
    step(`s${i + 1}`, 'work', i, `MARK_SCEN_${i + 1} do thing ${i + 1}.`),
  );
  many[4] = { ...many[4], kind: 'resource', resource: { type: 'skill', id: 'flow-skill' } };
  many[5] = { ...many[5], kind: 'resource', resource: { type: 'hook', id: 'PostToolUse:abc' } };
  const saved2 = await api('PUT', `/api/groups/${scen.json?.id}/path/steps`, { steps: many });
  check(saved2.status === 200, 'сценарий из 80 шагов сохранён', saved2.status);
  check(
    saved2.json?.entries?.length === 80 &&
      saved2.json.entries.every((entry) => entry.kind === 'custom'),
    'путь сценария — 80 своих шагов без стадий',
    saved2.json?.entries?.length ?? 'нет',
  );
  await api('PUT', '/api/chat/path-scen/group-settings', {
    groupChoice: `global:${scen.json?.id}`,
  });
  const sent2 = await api('POST', '/api/chat/send', {
    chatId: 'path-scen',
    prompt: 'hello',
    projectPath: dirs.scen,
  });
  check(sent2.status < 300, 'чат со сценарием принят', sent2.status);
  const [turn2] = await waitTurns(root, (turn) => turn.cwd === dirs.scen);
  const append2 = turn2?.append ?? '';
  check(append2.includes('scenario "Scenario"'), 'строка сценария в добавке');
  check(
    append2.includes('1. Step s1: MARK_SCEN_1') && append2.includes('80. Step s80: MARK_SCEN_80'),
    'все 80 шагов в добавке',
  );
  check(
    append2.indexOf('MARK_SCEN_10 ') > append2.indexOf('MARK_SCEN_9 '),
    'порядок сохранён (9 раньше 10)',
  );
  check(append2.includes('Apply the skill `flow-skill`'), 'шаг-скилл — «Apply the skill»');
  check(append2.includes('hook `PostToolUse:abc` is active'), 'шаг-хук — строка хука');
  check(!append2.includes('This chat works under the group'), 'у сценария нет подсказки конвейера');

  // ---------- 3. Ход стадии: шаг после «fix» — отдельным ходом ----------
  const fix = await api('POST', '/api/groups', { name: 'FixStage' });
  await api('PUT', `/api/groups/${fix.json?.id}/path/steps`, {
    steps: [
      step('suite', 'fix', 0, 'MARK_AFTER_FIX run whole suite.', {
        gate: { ru: 'всё зелёное', en: 'every test is green' },
      }),
    ],
  });
  // Связь ребёнка разделения со стадией пишет сама панель; здесь — её же
  // хранилищем при остановленной панели, чтобы не гнать всё разделение.
  server.kill();
  await wait(1500);
  const seed = join(root, 'seed.ts');
  const storeUrl = pathToFileURL(join(process.cwd(), 'apps/server/src/lib/app-store.ts')).href;
  writeFileSync(
    seed,
    `import { AppStore } from ${JSON.stringify(storeUrl)};
const store = new AppStore(${JSON.stringify(appData)});
store.setChatLink('path-fix', { parentChatId: 'path-parent', createdAt: '${NOW}', title: 'Fix', branch: 'split/fix', groupIndex: 0, model: 'sonnet', effort: 'medium', kind: 'mechanical', stage: 'fix', ceilingModel: 'claude-opus-5', workModel: 'sonnet', workEffort: 'medium' });
await new Promise((done) => setTimeout(done, 500));
`,
  );
  const seeding = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', seed], {
    env,
    stdio: 'inherit',
  });
  await new Promise((done) => seeding.on('exit', done));
  server = boot();
  check(await waitForPanel(), 'панель поднялась заново');
  const chosen = await api('PUT', '/api/chat/path-fix/group-settings', {
    groupChoice: `global:${fix.json?.id}`,
  });
  check(chosen.status === 200, 'ребёнок выбрал группу', chosen.status);
  const sent3 = await api('POST', '/api/chat/send', {
    chatId: 'path-fix',
    prompt: 'do the fixes',
    projectPath: dirs.fix,
  });
  check(sent3.status < 300, 'ход стадии принят', sent3.status);
  const stepTurns = await waitTurns(
    root,
    (turn) => turn.cwd === dirs.fix && turn.prompt?.includes('MARK_AFTER_FIX'),
    40,
  );
  check(stepTurns.length === 1, 'после стадии — отдельный ход с шагом', stepTurns.length);
  const prompt = stepTurns[0]?.prompt ?? '';
  check(
    prompt.includes('after the fix stage') &&
      prompt.includes('This step is closed only when: every test is green'),
    'ход шага называет стадию и условие «готово»',
  );
  check(!prompt.includes('Сделай'), 'в ходе шага нет русской стороны');
  const before = turnsOf(root).filter((turn) => turn.cwd === dirs.fix).length;
  await wait(3000);
  const after = turnsOf(root).filter((turn) => turn.cwd === dirs.fix).length;
  check(after === before, 'проваленное условие останавливает цепочку', `${before} → ${after}`);
  // Нового хода нет и при «пройдено» (шагов больше нет) — различает их связь:
  // непройденный шаг остаётся незакрытым, ответ человека доведёт его.
  const state = JSON.parse(readFileSync(join(appData, 'state.json'), 'utf8'));
  const pending = Object.values(state.chatLinks ?? {})
    .filter((link) => link.parentChatId === 'path-parent')
    .map((link) => link.pathRun?.pending);
  check(
    pending.length > 0 && pending.every((id) => id === 'suite'),
    'шаг с проваленным условием остался незакрытым',
    JSON.stringify(pending),
  );
} finally {
  server.kill();
  // Фальшивые CLI уходят сами, заметив, что панели нет (раз в секунду); занятый
  // каталог после этого — процесс пережил прогон: это провал, а не молчание.
  let removed = false;
  for (let i = 0; i < 10 && !removed; i += 1) {
    await wait(1000);
    try {
      rmSync(root, { recursive: true, force: true });
      removed = true;
    } catch {
      // ещё занят
    }
  }
  check(removed, 'после прогона не осталось процессов — каталог удалён', removed ? '' : root);
}
console.log(bad === 0 ? '\n«Путь» группы доезжает до процесса CLI' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
