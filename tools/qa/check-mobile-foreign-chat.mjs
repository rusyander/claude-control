/**
 * Разговор с чужим CLI на телефоне (эмулятор Android, собранный APK) — путь
 * человека целиком: список разговоров → новый разговор с Codex → вопрос →
 * телефон в фоне → уведомление «Работа закончена» → нажатие → тот же разговор
 * с ответом. Вторая половина — уведомление после того, как на компьютере
 * переключили CLI: разговор открывается только для чтения.
 *
 * Что подменено. Панель — одноразовая (`throwaway-stand.mjs`), Codex — настоящий
 * `codex app-server` из `STEER_CLI_DIR` или PATH с временным `CODEX_HOME`;
 * подменена только модель (сетевая граница): заглушка OpenAI responses держит
 * ответ HOLD_MS, чтобы телефон успел уйти в фон посреди хода. Между телефоном и
 * панелью — прозрачный прокси (`mobile-device-fixtures.mjs`, без своих ответов):
 * эмулятор видит компьютер как 10.0.2.2, а панель принимает только свой Host.
 * Настоящие `~/.codex`, `~/.agents`, `~/.claude` и стенд человека не трогаются.
 *
 * Нет устройства, APK или codex — код 2, «не проверено».
 *
 * Запуск: STEER_CLI_DIR=<каталог с codex> node tools/qa/check-mobile-foreign-chat.mjs
 *   [--apk agentdeck.apk] [--shots <каталог>]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { REPO, reporter, startStand, wait } from './throwaway-stand.mjs';
import { PACKAGE, device, firstDevice } from './android-device.mjs';
import { startProxy } from './mobile-device-fixtures.mjs';

const IS_WIN = process.platform === 'win32';
// Модель держит ответ, пока проверка его не отпустит (через RELEASE_MS после ухода
// телефона в фон), но не дольше HOLD_MS. Android 15 отрезает фоновому приложению
// сеть через несколько секунд (netpolicy: blocked=APP_BACKGROUND): ход, кончившийся
// позже, телефон сам не увидит — это работа push, а не приложения.
const HOLD_MS = 60_000;
const RELEASE_MS = 1_500;
const tag = Math.random().toString(36).slice(2, 8);
const ANSWER = (turn) => `FOREIGN-ANSWER-${tag}-${turn}`;

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const shots = option('--shots') ?? join(REPO, '.agent', 'screenshots', 'mobile-foreign-chat');
const apk = option('--apk');

const DONE_TITLE = /^(Работа закончена|Work is finished)$/;
const SEND = /^(Отправить|Send)$/;
const READ_ONLY = /^(Это разговор|This is a) Codex/;

function notChecked(reason) {
  console.log(`Не проверено: ${reason}`);
  process.exit(2);
}

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка модели (OpenAI responses, поток): ответ с номером хода — когда отпустят. */
function startModel() {
  let turns = 0;
  let releases = [];
  let firstAt = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!/\/responses/.test(req.url ?? '')) return void res.writeHead(404).end();
      turns += 1;
      if (!firstAt) firstAt = Date.now();
      const text = ANSWER(turns);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const resp = { id: `resp_${turns}`, object: 'response', model: 'stub-model', output: [] };
      const item = {
        type: 'message',
        id: `msg_${turns}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      send('response.created', {
        type: 'response.created',
        response: { ...resp, status: 'in_progress' },
      });
      let answered = false;
      const answer = () => {
        if (answered || res.destroyed) return;
        answered = true;
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, content: [] },
        });
        send('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item,
        });
        send('response.completed', {
          type: 'response.completed',
          response: {
            ...resp,
            status: 'completed',
            output: [item],
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              total_tokens: 11,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        });
        res.end();
      };
      releases.push(answer);
      setTimeout(answer, HOLD_MS);
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        turns: () => turns,
        firstAt: () => firstAt,
        release: () => {
          for (const answer of releases) answer();
          releases = [];
        },
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      }),
    ),
  );
}

const serial = firstDevice();
if (!serial) notChecked('нет устройства в `adb devices` (эмулятор не запущен).');
const phone = device(serial);
if (apk) {
  const result = phone.install(apk);
  if (!String(result.stdout).includes('Success'))
    notChecked(`APK не встал: ${result.stdout}${result.stderr}`);
}
if (!phone.isInstalled()) notChecked(`на устройстве нет ${PACKAGE} (передайте --apk).`);
// Без --apk проверка идёт на том, что уже стоит. Сборка в корне свежее
// установленной — значит, проверялась бы старая (так 07.10 полчаса проверялся
// мутант вместо исправления): не проверено, а не красное и не зелёное.
const builtApk = join(REPO, 'agentdeck.apk');
if (!apk && existsSync(builtApk)) {
  const installedAt = phone.installedAt();
  if (installedAt && statSync(builtApk).mtimeMs > installedAt + 60_000)
    notChecked(`на устройстве сборка старше ${builtApk} — передайте --apk agentdeck.apk.`);
}
const cliDir = findCli('codex');
if (!cliDir) notChecked('codex не найден ни в STEER_CLI_DIR, ни в PATH.');
mkdirSync(shots, { recursive: true });
const shot = (name) => phone.screenshot(join(shots, `${name}.png`));

/** Уведомления приложения в шторке — по заголовкам, как их видит система. */
function postedTitles() {
  const dump = phone.shell('dumpsys notification --noredact');
  const titles = [];
  for (const block of dump.split(/NotificationRecord\(/).slice(1)) {
    if (!block.includes(`pkg=${PACKAGE}`)) continue;
    const title = /android\.title=String \(([^)]*)\)/.exec(block);
    if (title) titles.push(title[1]);
  }
  return titles;
}

const doneCount = () => postedTitles().filter((title) => DONE_TITLE.test(title)).length;

/** Новое «Работа закончена» сверх `before` — прежнее, ещё лежащее в шторке, не в счёт. */
async function waitNotification(before, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (doneCount() > before) return true;
    await wait(1000);
  }
  return false;
}

/** Сопряжение руками: адрес и токен в поля, разрешение на уведомления выдано. */
async function pair(url) {
  phone.stopApp();
  phone.clearData();
  phone.grant('android.permission.POST_NOTIFICATIONS');
  phone.launch();
  await phone.tap(/^(Settings|Настройки)$/, 30_000);
  await phone.tap(/^(Pair|Подключить|Сопряжение)$/);
  const fields = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
  if (fields.length < 2) throw new Error('на экране сопряжения нет полей адреса и токена');
  phone.tapAt(fields[0].x, fields[0].y);
  await wait(400);
  phone.shell('input keyevent KEYCODE_MOVE_END');
  phone.shell(`input keyevent ${Array(80).fill('67').join(' ')}`);
  phone.type(url);
  phone.tapAt(fields[1].x, fields[1].y);
  await wait(400);
  phone.type('device-check');
  phone.hideKeyboard();
  await wait(400);
  await phone.tap(/^(Connect|Подключить)$/);
  return Boolean(await phone.waitFor(/^(online|на связи)$/i, 20_000));
}

/** Вопрос в открытом разговоре и уход в фон, пока модель держит ответ. */
async function askAndLeave(text) {
  // Приложение могло остаться в фоне (уведомление не пришло) — вернуть его.
  if (!(await phone.find(SEND)).length) {
    phone.resume();
    await phone.waitFor(SEND, 15_000);
  }
  const [field] = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
  if (!field) throw new Error('в разговоре нет поля ввода');
  phone.tapAt(field.x, field.y);
  await wait(400);
  phone.type(text);
  phone.hideKeyboard();
  await wait(400);
  const turnsBefore = model.turns();
  await phone.tap(SEND);
  // Ход дошёл до модели (она держит ответ), и экран увидел его хотя бы одним
  // опросом — иначе конец хода для него не событие (первый опрос молчит).
  for (let i = 0; i < 60 && model.turns() === turnsBefore; i += 1) await wait(500);
  await wait(2500);
  const before = doneCount();
  hiddenAt = Date.now();
  phone.home();
  await wait(RELEASE_MS);
  model.release();
  return before;
}

/** Нажать «Работа закончена» в шторке. */
async function tapNotification() {
  phone.shell('cmd statusbar expand-notifications');
  await wait(1200);
  await phone.tap(DONE_TITLE, 10_000);
  await wait(1500);
}

let hiddenAt = 0;
/** Опросы состояния хода, ушедшие с телефона после ухода в фон, — жив ли JS в фоне. */
const statusPolls = () =>
  (proxy?.log ?? []).filter(
    (item) => item.at >= hiddenAt && /\/provider-chat\/chats\/[^/]+\/status$/.test(item.path),
  );
const pollsSinceHidden = () =>
  statusPolls()
    .map(
      (item) =>
        `${item.query} +${Math.round((item.at - hiddenAt) / 1000)}с→${item.closedAt ? `+${Math.round((item.closedAt - hiddenAt) / 1000)}с` : 'висит'} ${item.status ?? ''}${/"isRunning":true/.test(item.body ?? '') ? ' идёт' : /"isRunning":false/.test(item.body ?? '') ? ' не идёт' : ''}`,
    )
    .join('; ') || 'нет';

/** Снос временного каталога: codex мог ещё держать базу — не повод валить итог. */
function removeTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Каталог остаётся в temp — на вердикт проверки это не влияет.
  }
}

const { check, finish } = reporter();
const model = await startModel();
const codexHome = mkdtempSync(join(tmpdir(), 'cc-mob-foreign-codex-'));
writeFileSync(
  join(codexHome, 'config.toml'),
  [
    'model_provider = "stub"',
    'model = "stub-model"',
    'check_for_update_on_startup = false',
    '[analytics]',
    'enabled = false',
    // Синхронизация плагинов клонировала их из сети в этот CODEX_HOME на каждом прогоне.
    '[features]',
    'plugins = false',
    '[model_providers.stub]',
    'name = "stub"',
    `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'wire_api = "responses"',
    'env_key = "STUB_KEY"',
    '',
  ].join('\n'),
);
Object.assign(process.env, {
  CODEX_HOME: codexHome,
  STUB_KEY: 'x',
  PATH: `${cliDir}${delimiter}${process.env.PATH ?? ''}`,
});

let proxy;
let stand;
try {
  stand = await startStand({
    web: false,
    label: 'mob-foreign',
    settings: { provider: 'codex' },
    seed: ({ root }) => mkdirSync(join(root, 'proj'), { recursive: true }),
  });
  const project = join(stand.root, 'proj');
  proxy = await startProxy(stand.apiUrl);
  console.log(`Одноразовая панель ${stand.apiUrl}, прокси :${proxy.port}, устройство ${serial}\n`);
  const registered = await stand.api('/projects', { method: 'POST', body: { path: project } });
  check('проект заведён в реестр одноразовой панели', registered.status === 200, registered.text);
  check('телефон сопряжён с одноразовой панелью', await pair(`http://10.0.2.2:${proxy.port}`));

  // — 1. Активен Codex: новый разговор с телефона, ответ в фоне, уведомление ведёт в него.
  console.log('\n— активен Codex');
  // После сопряжения приложение остаётся в «Настройках».
  await phone.tap(/^(Home|Главная)$/, 20_000);
  await phone.tap(/^(Все разговоры|All conversations)$/, 20_000);
  await phone.tap(/^(Новый разговор с|New conversation with) Codex/, 20_000);
  const opened = await phone.waitFor(SEND, 20_000);
  check('кнопка «Новый разговор с Codex» открыла разговор с полем ввода', Boolean(opened));
  shot('1-new-chat');
  const chats = (await stand.api('/provider-chat/chats')).body ?? [];
  check('разговор заведён у Codex на панели', chats.length === 1, JSON.stringify(chats));

  const before1 = await askAndLeave('hello from phone');
  const firstPosted = await waitNotification(before1, 30_000);
  check(
    'в фоне пришло уведомление «Работа закончена»',
    firstPosted,
    `в шторке: ${postedTitles().join(' | ') || 'ничего'}; опросы после ухода в фон: ${pollsSinceHidden()}; запросов к модели ${model.turns()}, ответ отпущен через ${RELEASE_MS / 1000} с после ухода, запрос пришёл через ${Math.round((model.firstAt() - hiddenAt) / 1000)} с после ухода`,
  );
  check('ответ модели действительно шёл (ход один)', model.turns() === 1, String(model.turns()));
  if (firstPosted) {
    await tapNotification();
    const answer = await phone.waitFor(new RegExp(ANSWER(1)), 20_000);
    shot('2-after-tap');
    check('нажатие открыло разговор с ответом Codex', Boolean(answer));
    check('разговор активного CLI — поле ввода на месте', (await phone.find(SEND)).length > 0);
    check('баннера «только чтение» нет', (await phone.find(READ_ONLY)).length === 0);
  }

  // — 2. Пока телефон в фоне, на компьютере включили Claude: уведомление открывает
  // разговор Codex только для чтения, ответ виден.
  console.log('\n— CLI переключён на компьютере, пока телефон в фоне');
  const before2 = await askAndLeave('second question');
  const secondPosted = await waitNotification(before2, 30_000);
  check('второе уведомление пришло', secondPosted, postedTitles().join(' | '));
  const switched = await stand.api('/settings', { method: 'PATCH', body: { provider: 'claude' } });
  check('на панели активен Claude', switched.status === 200, switched.text);
  if (secondPosted) {
    await tapNotification();
    const readOnly = await phone.waitFor(READ_ONLY, 20_000);
    shot('3-read-only');
    check('разговор Codex открыт с объяснением, почему ответить нельзя', Boolean(readOnly));
    check(
      'ответ второго хода виден (чтение разговора неактивного CLI)',
      (await phone.find(new RegExp(ANSWER(2)))).length > 0,
    );
    check('поля ввода нет', (await phone.find(SEND)).length === 0);
  }
} catch (error) {
  shot('error');
  check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  if (stand) console.log(`    хвост журнала панели:\n${stand.log().slice(-3000)}`);
} finally {
  phone.stopApp();
  await proxy?.close();
  await stand?.stop();
  await model.close();
  // Временный CODEX_HOME прогона (~4 МБ: база, журнал) — иначе он копился в temp.
  removeTemp(codexHome);
}
finish();
