/**
 * Хуки и скиллы Codex (MAP 26) — настоящим codex через настоящую панель.
 *
 * Панель пишет `$CODEX_HOME/hooks.json` и `~/.agents/skills/<имя>/SKILL.md`.
 * Вопрос — читает ли codex ровно то, что обещает экран. Свидетель — его
 * собственный `app-server`: `hooks/list` (событие, матчер, `timeoutSec`, доверие)
 * и `skills/list`. Сценарии:
 *   1. раздел хуков — `codex-json`, `hooks.json` в CODEX_HOME, нужно одобрение;
 *      раздел скиллов — `~/.agents/skills`, `$CODEX_HOME/skills` назван;
 *   2. отказ ДО записи: Interrupt дольше 3 с (CLI молча урезал бы), матчер у
 *      UserPromptSubmit (CLI молча выбросил бы) — 400, файла нет;
 *   3. запись хуков панелью; codex видит каждое правило с ТЕМ ЖЕ матчером и тем
 *      же таймаутом в секундах (свой 30, умолчания 600 и 1, граница 3), без
 *      предупреждений, и каждое «не одобрено» — ровно то, что говорит карточка;
 *   4. рубильник `[features] hooks = false` в config.toml — панель его называет;
 *   5. скилл панелью: файл в `~/.agents/skills`, codex загружает его с тем же
 *      описанием; до записи его не было (иначе находка ничего не доказывала бы);
 *   6. имя длиннее 64: панель — 400; тот же файл, положенный руками, отвергает и
 *      сам codex — граница панели совпадает с границей CLI в обе стороны;
 *   7. удаление скилла — каталога нет, codex его больше не видит.
 *
 * Личный каталог `~/.agents/skills` codex на Windows берёт из профиля ОС мимо
 * HOME/USERPROFILE (живая проба 07.10.2026), поэтому каталог временного дома
 * отдаётся свидетелю через `skills/extraRoots/set` — настоящий `~/.agents`
 * человека не читается этой проверкой и не пишется. Модели не нужно. CLI — из
 * `STEER_CLI_DIR`, иначе из PATH; нет — «не проверено», код 2.
 *
 * Запуск: node tools/qa/check-codex-hooks-skills.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const SKILL = 'qa-codex-skill-7731';
const DESCRIPTION = 'QA skill written by the panel 7731';

function findCli() {
  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: codex нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const cli = join(cliDir, IS_WIN ? 'codex.cmd' : 'codex');

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-codex-hs-')));
const codexHome = join(root, 'codex-home');
mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
const hooksPath = join(codexHome, 'hooks.json');
const configPath = join(codexHome, 'config.toml');

/**
 * Один сеанс `codex app-server` с тем же CODEX_HOME, что у панели: вызовы по
 * id, `initialize` уже сделан.
 */
async function appServer(cwd) {
  const child = IS_WIN
    ? spawn(`"${cli}" app-server`, { cwd, shell: true, env: process.env })
    : spawn(cli, ['app-server'], { cwd, env: process.env });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  let next = 1;
  const call = (method, params) =>
    new Promise((done, fail) => {
      const id = next++;
      const timer = setTimeout(
        () => fail(new NotChecked(`app-server не ответил на ${method}`)),
        60_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  await call('initialize', { clientInfo: { name: 'qa', version: '0' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  return { call, close: () => child.kill() };
}

/** Хуки глазами codex: вход списка `hooks/list` для рабочего каталога. */
async function codexHooks(cwd) {
  const server = await appServer(cwd);
  try {
    const answer = await server.call('hooks/list', { cwds: [cwd] });
    const entry = answer.result?.data?.[0] ?? {};
    return { hooks: entry.hooks ?? [], warnings: entry.warnings ?? [], errors: entry.errors ?? [] };
  } finally {
    server.close();
  }
}

/** Скиллы глазами codex с дополнительными корнями (каталог временного дома). */
async function codexSkills(cwd, extraRoots) {
  const server = await appServer(cwd);
  try {
    const roots = await server.call('skills/extraRoots/set', { extraRoots });
    if (roots.error) throw new NotChecked(`skills/extraRoots/set: ${JSON.stringify(roots.error)}`);
    const answer = await server.call('skills/list', { cwds: [cwd], forceReload: true });
    const entries = answer.result?.data ?? [];
    return {
      skills: entries.flatMap((entry) => entry.skills ?? []).filter((s) => s.scope !== 'system'),
      errors: entries.flatMap((entry) => entry.errors ?? []),
    };
  } finally {
    server.close();
  }
}

const sorted = (value) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

let stand;
try {
  stand = await startStand({
    label: 'codex-hooks-skills',
    settings: { provider: 'codex' },
    web: false,
    extraPath: [cliDir],
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);
  const work = join(stand.home, 'work');
  mkdirSync(work, { recursive: true });
  const skillsDir = join(stand.home, '.agents', 'skills');

  console.log('1. Разделы хуков и скиллов Codex');
  const providers = (await stand.api('/providers')).body;
  const codex = providers?.providers?.find((item) => item.id === 'codex');
  check(
    'возможности hooks и skills — ready',
    codex?.capabilities?.hooks === 'ready' && codex?.capabilities?.skills === 'ready',
    JSON.stringify(codex?.capabilities),
  );
  const hooksInfo = (await stand.api('/provider-hooks')).body;
  check(
    'хуки: codex-json, hooks.json в CODEX_HOME, секунды, нужно одобрение, файла ещё нет',
    hooksInfo?.format === 'codex-json' &&
      hooksInfo?.filePath === hooksPath &&
      hooksInfo?.timeoutUnit === 's' &&
      hooksInfo?.trustRequired === true &&
      hooksInfo?.present === false,
    JSON.stringify(hooksInfo),
  );
  const skillsInfo = (await stand.api('/provider-skills')).body;
  check(
    'скиллы: ~/.agents/skills временного дома, $CODEX_HOME/skills назван',
    skillsInfo?.skillsDir === skillsDir &&
      skillsInfo?.externalDirs?.some((dir) => dir.path === join(codexHome, 'skills')),
    JSON.stringify(skillsInfo),
  );

  console.log('\n2. Отказ до записи там, где CLI исказил бы правило молча');
  for (const [label, rules] of [
    ['Interrupt 4 с', [{ event: 'Interrupt', command: 'echo i', timeout: 4 }]],
    ['матчер у UserPromptSubmit', [{ event: 'UserPromptSubmit', matcher: 'x', command: 'echo u' }]],
  ]) {
    const res = await stand.api('/provider-hooks', { method: 'PUT', body: { rules } });
    check(`${label} — 400`, res.status === 400, res.text);
  }
  check('hooks.json не появился', !existsSync(hooksPath));

  console.log('\n3. Запись хуков панелью — свидетель hooks/list');
  const rules = [
    { event: 'PreToolUse', matcher: '^Bash$', command: 'echo qa-pre', timeout: 30 },
    { event: 'Stop', command: 'echo qa-stop' },
    { event: 'SessionEnd', command: 'echo qa-end' },
    { event: 'Interrupt', command: 'echo qa-int', timeout: 3 },
  ];
  const put = await stand.api('/provider-hooks', { method: 'PUT', body: { rules } });
  check('PUT — 200', put.status === 200, put.text);
  const seen = await codexHooks(work);
  const byEvent = new Map(seen.hooks.map((hook) => [hook.eventName, hook]));
  const expected = [
    ['preToolUse', '^Bash$', 'echo qa-pre', 30],
    ['stop', null, 'echo qa-stop', 600],
    ['sessionEnd', null, 'echo qa-end', 1],
    ['interrupt', null, 'echo qa-int', 3],
  ];
  // Имена событий app-server отдаёт в своей нотации — сверка без учёта регистра.
  const find = (name) =>
    [...byEvent.entries()].find(([key]) => String(key).toLowerCase() === name.toLowerCase())?.[1];
  for (const [event, matcher, command, timeout] of expected) {
    const hook = find(event);
    check(
      `${event}: команда, матчер ${matcher ?? '—'}, таймаут ${timeout} с`,
      hook?.command === command &&
        (hook?.matcher ?? null) === matcher &&
        hook?.timeoutSec === timeout,
      JSON.stringify(hook),
    );
  }
  check('codex видит ровно четыре правила', seen.hooks.length === 4, JSON.stringify(seen.hooks));
  check(
    'без предупреждений и ошибок (ничего не урезано и не выброшено)',
    seen.warnings.length === 0 && seen.errors.length === 0,
    JSON.stringify({ w: seen.warnings, e: seen.errors }),
  );
  check(
    'каждое правило «не одобрено» — как говорит карточка раздела',
    seen.hooks.every((hook) => hook.trustStatus !== 'trusted'),
    JSON.stringify(seen.hooks.map((hook) => hook.trustStatus)),
  );
  const roundTrip = (await stand.api('/provider-hooks')).body;
  check(
    'панель читает записанное обратно',
    // Порядок ключей внутри правила — не смысл; порядок правил — смысл.
    JSON.stringify(roundTrip?.rules?.map(sorted)) === JSON.stringify(rules.map(sorted)),
    JSON.stringify(roundTrip?.rules),
  );

  console.log('\n4. Рубильник в config.toml');
  writeFileSync(configPath, '[features]\nhooks = false\n');
  const switched = (await stand.api('/provider-hooks')).body;
  check('disableAll назван', switched?.disableAll === true, JSON.stringify(switched));
  writeFileSync(configPath, '');
  check(
    'без рубильника — не назван',
    (await stand.api('/provider-hooks')).body?.disableAll !== true,
  );

  console.log('\n5. Скилл панелью — свидетель skills/list');
  const before = await codexSkills(work, [skillsDir]);
  check('до записи codex скилла не видит', !before.skills.some((s) => s.name === SKILL));
  const created = await stand.api('/provider-skills/skill', {
    method: 'PUT',
    body: { path: `${SKILL}/SKILL.md`, name: SKILL, description: DESCRIPTION, body: 'Say hi.\n' },
  });
  check('PUT skill — 200', created.status === 200, created.text);
  check('файл в ~/.agents/skills временного дома', existsSync(join(skillsDir, SKILL, 'SKILL.md')));
  const after = await codexSkills(work, [skillsDir]);
  const loaded = after.skills.find((s) => s.name === SKILL);
  check(
    'codex загрузил скилл с тем же описанием',
    loaded?.description === DESCRIPTION,
    JSON.stringify({ loaded, errors: after.errors }),
  );

  console.log('\n6. Имя длиннее 64 — граница панели = граница CLI');
  const longName = `q${'a'.repeat(64)}`;
  const tooLong = await stand.api('/provider-skills/skill', {
    method: 'PUT',
    body: { path: `${longName}/SKILL.md`, name: longName, description: 'x', body: '' },
  });
  check('панель — 400', tooLong.status === 400, tooLong.text);
  const manual = join(root, 'manual-skills');
  mkdirSync(join(manual, longName), { recursive: true });
  writeFileSync(
    join(manual, longName, 'SKILL.md'),
    `---\nname: ${longName}\ndescription: x\n---\nx\n`,
  );
  const cliView = await codexSkills(work, [manual]);
  check(
    'codex тот же файл не загрузил и назвал ошибку',
    !cliView.skills.some((s) => s.name === longName) && cliView.errors.length > 0,
    JSON.stringify(cliView.errors).slice(0, 400),
  );
  const okName = 'q'.repeat(64);
  mkdirSync(join(manual, okName), { recursive: true });
  writeFileSync(join(manual, okName, 'SKILL.md'), `---\nname: ${okName}\ndescription: x\n---\nx\n`);
  const edge = await codexSkills(work, [manual]);
  check(
    'ровно 64 знака codex принимает',
    edge.skills.some((s) => s.name === okName),
  );

  console.log('\n7. Удаление скилла панелью');
  const removed = await stand.api(
    `/provider-skills/skill?path=${encodeURIComponent(`${SKILL}/SKILL.md`)}`,
    { method: 'DELETE' },
  );
  check('DELETE — 200', removed.status === 200, removed.text);
  check('каталога скилла нет', !existsSync(join(skillsDir, SKILL)));
  check(
    'codex его больше не видит',
    !(await codexSkills(work, [skillsDir])).skills.some((s) => s.name === SKILL),
  );
  check(
    'hooks.json на месте и не тронут скиллами',
    readFileSync(hooksPath, 'utf8').includes('qa-pre'),
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error instanceof Error ? error.stack : String(error));
  }
} finally {
  await stand?.stop();
  // Корень прогона (проект, домашний каталог CLI) — иначе он копился в temp.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Держит ещё не вышедший CLI — на вердикт проверки это не влияет.
  }
}
if (process.exitCode !== 2) finish();
