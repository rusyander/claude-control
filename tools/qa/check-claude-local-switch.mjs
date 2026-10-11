/**
 * «Claude Code на этой модели» (раздел «Локальные модели») — на одноразовом
 * стенде, через настоящий UI, настоящий `claude` и настоящий сервер моделей.
 *
 * 1. Карточка агентов показывает галочку, она доступна (модель скачана).
 * 2. Щелчок: `settings.json` стенда получает адрес сервера моделей и модель
 *    для всех ролей; подпись «Включено».
 * 3. Настоящий `claude -p` (терминал) с каталогом стенда отвечает, и ответ
 *    пришёл от локального сервера: модель загружена в нём (`/api/ps`).
 * 4. Чат панели (`/chat/send`) отвечает тем же путём.
 * 5. Щелчок обратно: `settings.json` ровно тот, что был до включения.
 *
 * Модели — настоящая папка панели (`.local-models/models`, junction), а
 * состояние раздела — временное: отметка «Claude уведён» не попадает в
 * `state.json` стенда человека. `~/.claude` человека не трогается.
 *
 * ЗАМОК: грузит модель ~17 ГБ в видеопамять. Без `ALLOW_OLLAMA=1` — «не
 * проверено», код 2. После прогона модель выгружается, сервер снимается,
 * видеопамять печатается (протокол владельца).
 *
 * Запуск: ALLOW_OLLAMA=1 node tools/qa/check-claude-local-switch.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REAL_MODELS = join(REPO, '.local-models', 'models');
const PORT = 11435;
const IS_WIN = process.platform === 'win32';

if (process.env.ALLOW_OLLAMA !== '1') {
  console.log('Не проверено: нужен ALLOW_OLLAMA=1 (грузит локальную модель в видеопамять).');
  process.exit(2);
}
if (!existsSync(join(REAL_MODELS, 'manifests'))) {
  console.log(`Не проверено: моделей панели нет (${REAL_MODELS}).`);
  process.exit(2);
}

/** Каталог настоящего `claude` (CLAUDE_CLI — путь к нему). */
function claudeDir() {
  if (process.env.CLAUDE_CLI) return dirname(process.env.CLAUDE_CLI);
  const found = spawnSync(IS_WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const first = found.stdout?.split(/\r?\n/).find(Boolean);
  if (!first) {
    console.log('Не проверено: claude нет в PATH.');
    process.exit(2);
  }
  return dirname(first);
}

const vram = () => {
  try {
    return execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'nvidia-smi недоступен';
  }
};
const ps = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ps`);
    return res.ok ? ((await res.json()).models ?? []) : [];
  } catch {
    return undefined;
  }
};

/** Протокол владельца: выгрузить модель, снять сервер, показать видеопамять. */
async function releaseGpu() {
  for (const model of (await ps()) ?? []) {
    await fetch(`http://127.0.0.1:${PORT}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: model.name, keep_alive: 0 }),
    }).catch(() => undefined);
  }
  await wait(1500);
  console.log(
    `  модели после выгрузки: ${JSON.stringify(((await ps()) ?? []).map((m) => m.name))}`,
  );
  if (IS_WIN) {
    for (const image of ['ollama.exe', 'ollama app.exe']) {
      spawnSync('taskkill', ['/IM', image, '/T', '/F'], { stdio: 'ignore' });
    }
    const left = spawnSync('tasklist', [], { encoding: 'utf8' }).stdout ?? '';
    console.log(
      `  процессов ollama осталось: ${left.split(/\r?\n/).filter((l) => /ollama/i.test(l)).length}`,
    );
  }
  await wait(1500);
  console.log(`  видеопамять после: ${vram()}`);
}

const localRoot = mkdtempSync(join(tmpdir(), 'cc-local-switch-'));
// Junction на настоящую папку моделей: 17 ГБ не копируются, а состояние раздела своё.
if (IS_WIN) {
  execFileSync('cmd', ['/c', 'mklink', '/J', join(localRoot, 'models'), REAL_MODELS], {
    stdio: 'ignore',
  });
} else {
  execFileSync('ln', ['-s', REAL_MODELS, join(localRoot, 'models')]);
}
// Стенд не наследует AGENTDECK_* (увели бы его в каталоги человека) — только явным env.
const REAL_STATE = join(REPO, '.local-models', 'state.json');
const realStateBefore = existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null;
const model = readdirSync(join(REAL_MODELS, 'manifests', 'registry.ollama.ai', 'library'))
  .flatMap((name) =>
    readdirSync(join(REAL_MODELS, 'manifests', 'registry.ollama.ai', 'library', name)).map(
      (tag) => `${name}:${tag}`,
    ),
  )
  .at(0);
console.log(`Модель: ${model}; видеопамять до: ${vram()}`);

const { check, failed } = reporter();
let stand;
let browser;
let project;
let skipped = false;
try {
  // Стенд вырезает `claude` из PATH; здесь нужен настоящий — каталог в конец PATH.
  stand = await startStand({
    label: 'local-switch-stand',
    extraPath: [claudeDir()],
    env: { AGENTDECK_LOCAL_MODELS_DIR: localRoot },
  });
  {
    const settingsPath = join(stand.cfg, 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');
    browser = await chromium.launch();
    const page = await stand.newPage(browser);
    // Галочка — на вкладке «Агентам»: на других вкладках раздела её нет.
    await page.goto(`${stand.webUrl}/local-models?tab=agents`, { waitUntil: 'domcontentloaded' });
    const toggle = page.getByLabel('Claude Code на этой модели');
    await toggle.first().waitFor({ timeout: 30_000 });
    check('галочка «Claude Code на этой модели» есть', (await toggle.count()) === 1);
    check('галочка доступна (модель скачана)', await toggle.isEnabled());
    check('по умолчанию выключена', !(await toggle.isChecked()));

    await toggle.click();
    // Включение поднимает сервер моделей — это минуты на холодном старте.
    const on = page.getByText('Включено: Claude Code работает на', { exact: false });
    await on.waitFor({ timeout: 300_000 }).catch(() => undefined);
    check(
      'подпись «Включено»',
      await on.isVisible(),
      (await page.locator('main').innerText()).slice(0, 600),
    );
    const env = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
    check(
      `settings.json: адрес сервера моделей :${PORT}`,
      String(env.ANTHROPIC_BASE_URL).includes(`:${PORT}`),
      JSON.stringify(env),
    );
    check(
      'settings.json: модель для всех ролей',
      env.ANTHROPIC_MODEL === model && env.ANTHROPIC_DEFAULT_SONNET_MODEL === model,
      JSON.stringify(env),
    );

    // Терминал: настоящий `claude` на каталоге стенда.
    const word = `PONG${Math.floor(Math.random() * 9000 + 1000)}`;
    // Промпт — через stdin: `.cmd` под `shell` склеивает аргументы, и фраза с
    // пробелами доходила до CLI одним первым словом.
    const cli = spawnSync('claude', ['-p'], {
      cwd: stand.root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: stand.cfg },
      input: `Reply with exactly this word and nothing else: ${word}`,
      encoding: 'utf8',
      shell: IS_WIN,
      timeout: 300_000,
    });
    check(
      'терминал: claude -p ответил словом',
      cli.stdout?.includes(word),
      `${cli.status} ${cli.stdout?.slice(0, 300)} ${cli.stderr?.slice(0, 300)}`,
    );
    const loaded = (await ps()) ?? [];
    check(
      'ответ дал локальный сервер: модель загружена в нём',
      loaded.some((item) => item.name === model),
      JSON.stringify(loaded.map((item) => item.name)),
    );

    // Чат панели: ответ на отправку — поток прогона до конца.
    const chatWord = `CHAT${Math.floor(Math.random() * 9000 + 1000)}`;
    project = mkdtempSync(join(tmpdir(), 'cc-local-switch-project-'));
    const sent = await stand.api('/chat/send', {
      method: 'POST',
      body: {
        chatId: crypto.randomUUID(),
        prompt: `Reply with exactly this word and nothing else: ${chatWord}`,
        projectPath: project,
      },
    });
    // Поток SSE: текст идёт кусками (`kind: text`), модель — в `kind: usage`.
    const events = sent.text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return {};
        }
      });
    const reply = events
      .filter((event) => event.kind === 'text')
      .map((event) => event.text)
      .join('');
    check('чат панели: ответ словом', reply.includes(chatWord), reply.slice(0, 300));
    const finished = events.find((event) => event.kind === 'done');
    // CLI считает чужую модель по тарифу Claude (11.10: $0.19) — панель это гасит.
    check(
      'чат панели: итог хода без выдуманной цены',
      finished?.costUsd === 0,
      JSON.stringify(finished ?? null),
    );
    const usage = events.find((event) => event.kind === 'usage');
    check(
      'чат панели: ход сделала локальная модель',
      usage?.model === model,
      JSON.stringify(usage ?? null),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await toggle.first().waitFor({ timeout: 30_000 });
    check('после перезагрузки галочка включена', await toggle.isChecked());
    await toggle.click();
    const off = page.getByText('Выключено: Claude Code работает как обычно');
    await off.waitFor({ timeout: 60_000 }).catch(() => undefined);
    check('подпись «Выключено»', await off.isVisible());
    check('галочка снята', !(await toggle.isChecked()));
    check(
      'выключение: settings.json как до включения',
      readFileSync(settingsPath, 'utf8') === before,
      readFileSync(settingsPath, 'utf8'),
    );
  }
} catch (error) {
  if (error instanceof NotChecked) {
    skipped = true;
    console.log(`Не проверено: ${error.message}`);
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
    if (stand)
      console.log(`
Журнал панели (хвост):
${stand.log().slice(-3000)}`);
  }
} finally {
  if (browser) await browser.close();
  // Сервер моделей, поднятый панелью стенда, держит его каталог: сперва он.
  await releaseGpu();
  if (stand) await stand.stop().catch((error) => console.log(`  ! стенд: ${error.code ?? error}`));
  // Сначала junction (rmdir не идёт внутрь), потом остальное.
  if (IS_WIN) spawnSync('cmd', ['/c', 'rmdir', join(localRoot, 'models')], { stdio: 'ignore' });
  else rmSync(join(localRoot, 'models'), { force: true });
  // Рекурсивное удаление — только когда junction уже снят: иначе ушли бы модели.
  if (!existsSync(join(localRoot, 'models'))) {
    rmSync(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } else console.log(`  ! junction не снят, каталог оставлен: ${localRoot}`);
  if (project) {
    try {
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.log(`  ! каталог проекта не удалён: ${project} (${error.code})`);
    }
  }
}
// Сторож: состояние раздела у стенда человека не тронуто.
check(
  'настоящий .local-models/state.json не изменился',
  (existsSync(REAL_STATE) ? readFileSync(REAL_STATE, 'utf8') : null) === realStateBefore,
);
if (skipped) process.exit(2);
console.log(failed() === 0 ? '\nВсё сходится.' : `\nПровалов: ${failed()}`);
process.exit(failed() === 0 ? 0 : 1);
