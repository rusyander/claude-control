/**
 * Кадры телефона для документа «Телефон»: настоящее приложение (APK) на
 * эмуляторе Android, подключённое к одноразовой панели.
 *
 *   phone/pair     04–06 — до спаривания, экран «Подключение», «на связи»
 *   phone/day      01–07 — главная, вопросы, чат, агент, проекты, тесты, аналитика
 *   phone/offline  01–02 — панель остановлена: главная и настройки
 *
 * Варианты — по одному на язык (ru, en), под именами светлых: приложение всегда
 * тёмное и от темы панели не зависит, `requiredVariants` требует от стороны
 * `phone` ровно их. Кадры панели в `pair` (01–03, сторона
 * `panel`) снимает `phone-panel.mjs`, и этот прогон их не трогает.
 *
 * ЧТО ПОДМЕНЕНО. Панель — настоящая одноразовая (свой дом, свой `~/.claude`,
 * `claude` фальшивый), с включённым «Пускать по токену»: телефон подключается
 * её токеном, как у человека. Между телефоном и панелью — прокси
 * (`mobile-device-fixtures.mjs`), который правит ОДНО поле: адрес, найденный у
 * Tailscale (`detectedUrl`). Сервер спрашивает Tailscale этой машины, и
 * настоящий ответ — имя машины съёмки; в кадр оно не должно попасть, поэтому
 * телефону уходит выдуманное, а на снимке и в тексте кадра оно ещё и закрыто.
 * Телефон ходит по служебному адресу эмулятора `10.0.2.2` — документ говорит об
 * этом прямо, это не адрес человека.
 *
 * ТОКЕН В КАДР НЕ ПОПАДАЕТ: поле токена на экране спаривания — скрытый ввод, а
 * текст каждого кадра сверяется с токеном, именем пользователя и именем машины
 * до записи; совпадение — прогон падает, кадр не пишется.
 *
 * Нужны: эмулятор в `adb devices` и установленный APK (`--apk` ставит сам).
 * Нет устройства — код 2.
 *
 * Запуск: node tools/help-shots/phone-device.mjs [--apk agentdeck.apk] [--only pair,day,offline]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, parse } from 'node:path';
import { chromium } from 'playwright';
import { SHOTS_ROOT, writeVariantIndex } from './kit.mjs';
import { NotChecked, startStand, wait } from '../qa/throwaway-stand.mjs';
import { PACKAGE, device, firstDevice } from '../qa/android-device.mjs';
import { startProxy, upstreamJson, json } from '../qa/mobile-device-fixtures.mjs';
import { PHONE_FAKE_CLI, seedPhoneDemo } from './phone-device-fixture.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = option('--only')?.split(',');
const wanted = (scenario) => !only || only.includes(scenario);
const apk = option('--apk');

/** Выдуманный адрес машины в tailnet — телефону вместо настоящего. */
const SHOWN_HOST = 'desk.tailnet-example.ts.net';
const MASK = '••••••••••••';
/** Нейтральный путь проектов: временный каталог лежит в профиле пользователя. */
const DEMO_ROOT = join(parse(process.cwd()).root, 'demo');
const PROJECTS = [join(DEMO_ROOT, 'shop-app'), join(DEMO_ROOT, 'docs-site')];
/** Кадр телефона в справке шириной 300 px — половины экрана эмулятора хватает с запасом. */
const SCALE = 0.5;

const serial = firstDevice();
if (!serial) {
  console.log('Не снято: нет устройства в `adb devices` (эмулятор не запущен).');
  process.exit(2);
}
const phone = device(serial);
if (apk) {
  const result = phone.install(apk);
  if (!String(result.stdout).includes('Success')) {
    console.log(`Не снято: APK не встал: ${result.stdout}${result.stderr}`);
    process.exit(2);
  }
}
if (!phone.isInstalled()) {
  console.log(`Не снято: на устройстве нет ${PACKAGE} (передайте --apk).`);
  process.exit(2);
}
/** Метка «каталог завёл этот прогон»: только такой можно снести при старте. */
const DEMO_MARK = join(DEMO_ROOT, '.phone-shots');
if (existsSync(DEMO_ROOT) && existsSync(DEMO_MARK)) {
  // Прошлый прогон, убитый снаружи, не успел прибрать за собой.
  rmSync(DEMO_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
if (existsSync(DEMO_ROOT)) {
  console.log(`Не снято: ${DEMO_ROOT} уже есть — чужой каталог не перезаписываем.`);
  process.exit(2);
}

// ─── опись кадров стороны phone ──────────────────────────────────────────────

/** Размер PNG из заголовка. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Опись сценария для стороны `phone`: запись кадра заменяется по id, русский
 * прогон пишет поля верхнего уровня, английский — поле `en` (как у `kit.mjs`).
 * Кадры другой стороны (`panel` в `pair`) живут нетронутыми.
 */
function openPhoneScenario(scenario) {
  const dir = join(SHOTS_ROOT, 'phone', scenario);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'frames.json');
  const previous = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { topic: 'phone', scenario, frames: [] };
  const frames = new Map(previous.frames.map((frame) => [frame.id, frame]));
  const taken = new Set();
  return {
    dir,
    record(id, lang, file, size, text) {
      const shot = { file, masked: 0, ...size, shotAt: new Date().toISOString(), text };
      const before = frames.get(id) ?? {};
      frames.set(
        id,
        lang === 'ru'
          ? { ...before, id, side: 'phone', ...shot }
          : { ...before, id, side: 'phone', en: shot },
      );
      taken.add(id);
    },
    setMasked(id, lang, count) {
      const frame = frames.get(id);
      if (lang === 'ru') frame.masked = count;
      else frame.en.masked = count;
    },
    finish() {
      for (const [id, frame] of [...frames]) {
        if (frame.side !== 'phone' || taken.has(id)) continue;
        for (const file of [frame.file, frame.en?.file]) {
          if (file) rmSync(join(dir, file), { force: true });
        }
        frames.delete(id);
        console.log(`  снят с учёта устаревший кадр ${scenario}/${id}`);
      }
      const list = [...frames.values()].sort((a, b) => a.id.localeCompare(b.id));
      writeFileSync(
        path,
        `${JSON.stringify({ topic: 'phone', scenario, frames: list }, null, 2)}\n`,
      );
    },
  };
}

// ─── снимок: экран → закрытые поля → половинный размер ──────────────────────

let browser;
/**
 * Закрасить прямоугольники (цвет — пиксель слева от поля, поверх точки) и
 * уменьшить. Через canvas браузера: своих зависимостей под картинки нет.
 */
async function finishPng(raw, rects) {
  const page = await browser.newPage();
  try {
    const data = await page.evaluate(
      async ({ src, rects, scale, mask }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const full = document.createElement('canvas');
        full.width = image.width;
        full.height = image.height;
        const ctx = full.getContext('2d');
        ctx.drawImage(image, 0, 0);
        for (const r of rects) {
          const [red, green, blue] = ctx.getImageData(Math.max(0, r.x1 - 4), r.y1 + 2, 1, 1).data;
          ctx.fillStyle = `rgb(${red},${green},${blue})`;
          ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
          ctx.fillStyle = '#8a8f98';
          ctx.font = `${Math.round((r.y2 - r.y1) * 0.6)}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.fillText(mask, r.x1, (r.y1 + r.y2) / 2);
        }
        const out = document.createElement('canvas');
        out.width = Math.round(image.width * scale);
        out.height = Math.round(image.height * scale);
        const small = out.getContext('2d');
        small.imageSmoothingQuality = 'high';
        small.drawImage(full, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      },
      { src: `data:image/png;base64,${raw.toString('base64')}`, rects, scale: SCALE, mask: MASK },
    );
    return Buffer.from(data.split(',')[1], 'base64');
  } finally {
    await page.close();
  }
}

/** Что в кадр попасть не должно — ни в тексте, ни на картинке. */
let forbidden = [];

async function shoot(scenario, id, lang) {
  await wait(900);
  const nodes = await phone.screen();
  const hides = nodes.filter((node) => `${node.text} ${node.desc}`.includes(SHOWN_HOST));
  const text = nodes
    .map((node) => node.text || node.desc)
    .filter(Boolean)
    .join(' ')
    .replaceAll(SHOWN_HOST, MASK)
    .replace(/\s+/g, ' ')
    .trim();
  const leaked = forbidden.filter((value) => text.includes(value));
  if (leaked.length > 0)
    throw new Error(`кадр ${id}: в тексте экрана ${leaked.length} запретных значения`);
  const rawFile = join(scenario.dir, `.raw-${id}.png`);
  phone.screenshot(rawFile);
  const raw = readFileSync(rawFile);
  rmSync(rawFile, { force: true });
  const png = await finishPng(
    raw,
    hides.map((node) => node.bounds),
  );
  const file = `${id}${lang === 'ru' ? '' : '.en'}.png`;
  writeFileSync(join(scenario.dir, file), png);
  scenario.record(id, lang, file, pngSize(png), text);
  scenario.setMasked(id, lang, hides.length);
  console.log(`  кадр ${id} [light-${lang}]${hides.length ? ` (закрыто: ${hides.length})` : ''}`);
}

// ─── шаги в приложении ───────────────────────────────────────────────────────

const TAB = {
  home: /^(Главная|Home)$/,
  agent: /^(Агент|Agent)$/,
  projects: /^(Проекты|Projects)$/,
  analytics: /^(Аналитика|Analytics)$/,
  settings: /^(Настройки|Settings)$/,
};

async function openTab(name, expect, ms = 20_000) {
  await phone.tap(TAB[name], 20_000, (list) => list.at(-1));
  if (expect && !(await phone.waitFor(expect, ms))) {
    throw new Error(
      `вкладка ${name}: не дождались ${expect}; видно: ${(await phone.texts()).slice(0, 30).join(' ¦ ')}`,
    );
  }
}

async function setLanguage(lang) {
  // Сразу после запуска (и после смены ночного режима) экран ещё пересобирается:
  // ждём сам заголовок «Язык», а не первый попавшийся кадр.
  await openTab('settings', /^(Язык|Language)$/);
  const button = await phone.scrollTo(lang === 'ru' ? /^Русский$/ : /^English$/);
  if (!button) {
    throw new Error(
      `в настройках нет выбора языка; видно: ${(await phone.texts()).slice(0, 30).join(' ¦ ')}`,
    );
  }
  phone.tapAt(button.x, button.y);
  await wait(800);
}

/** Поле ввода: очистить и набрать. */
async function fill(field, value) {
  phone.tapAt(field.x, field.y);
  await wait(400);
  phone.shell('input keyevent KEYCODE_MOVE_END');
  phone.shell(`input keyevent ${Array(80).fill('67').join(' ')}`);
  phone.type(value);
}

async function pairFrames(lang, url, token, scenario) {
  await openTab('settings', /^(Не подключено|Not connected)$/);
  await shoot(scenario, '04-phone-not-paired', lang);
  await phone.tap(/^(Спарить|Pair)$/);
  let fields = [];
  for (let i = 0; i < 30 && fields.length < 2; i += 1) {
    fields = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
    if (fields.length < 2) await wait(500);
  }
  if (fields.length < 2) throw new Error('на экране спаривания нет полей адреса и токена');
  await fill(fields[0], url);
  await fill(fields[1], token);
  phone.hideKeyboard();
  await wait(700);
  await shoot(scenario, '05-phone-pair-screen', lang);
  await phone.tap(/^(Подключиться|Connect)$/);
  if (!(await phone.waitFor(/^(на связи|online)$/i, 25_000))) {
    throw new Error(`не подключился: ${(await phone.texts()).slice(0, 30).join(' ¦ ')}`);
  }
  await shoot(scenario, '06-phone-online', lang);
}

/**
 * Дождаться конца очередного опроса главной. Главная привязывает крутилку
 * «обновить» к `isRefetching`, и она мигает на каждом фоновом опросе раз в
 * 5 секунд; снимок сразу после ответа попадает в промежуток без неё. Прокси
 * пишет каждое обращение, так что конец опроса виден без догадок.
 */
async function betweenPolls() {
  if (!proxy) return;
  const from = proxy.log.length;
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const done = proxy.log
      .slice(from)
      .some((entry) => entry.path === '/api/chat/inbox' && entry.closedAt);
    if (done) break;
    await wait(150);
  }
  await wait(700);
}

async function dayFrames(lang, scenario) {
  await openTab('home', /shop-app/);
  await wait(1500);
  await betweenPolls();
  await shoot(scenario, '01-home', lang);
  await phone.tap(/^(Вопросы|Questions)/);
  await phone.waitFor(/Which sign-in stays the default/, 15_000);
  await wait(1500);
  await betweenPolls();
  await shoot(scenario, '02-questions', lang);
  await phone.tap(/^(Проекты и чаты|Projects & chats)/);
  await phone.tap(/Add sign-in by QR code/);
  await phone.waitFor(/Waiting for your answer/, 20_000);
  await wait(1500);
  await shoot(scenario, '03-chat', lang);
  await phone.tap(/^(Тесты|Tests)$/);
  await phone.waitFor(/Sign in by QR code/, 20_000);
  // Кейсы и их статусы — под блоком автотестов: докручиваем экран до конца
  // (список короткий, дальше края он не уходит) и требуем кейс в кадре.
  for (let i = 0; i < 3; i += 1) {
    phone.shell('input swipe 30 1800 30 900 350');
    await wait(700);
  }
  const [row] = await phone.find(/^Sign in by QR code$/);
  if (!row || row.y > 2200) throw new Error('кейсы проекта не встали в кадр');
  await shoot(scenario, '06-tests', lang);
  phone.back();
  await wait(600);
  phone.back();
  await wait(800);
  await openTab('agent');
  await wait(2500);
  await shoot(scenario, '04-agent', lang);
  await openTab('projects', /docs-site/);
  await shoot(scenario, '05-projects', lang);
  await openTab('analytics');
  await wait(4000);
  await shoot(scenario, '07-analytics', lang);
}

async function offlineFrames(lang, scenario) {
  await openTab('home');
  await phone.shell('input swipe 540 700 540 1900 250');
  if (!(await phone.waitFor(/(Панель не ответила|did not answer)/, 30_000))) {
    throw new Error(
      `главная не сказала о молчании: ${(await phone.texts()).slice(0, 30).join(' ¦ ')}`,
    );
  }
  await wait(2500); // крутилка «обновить» успевает уйти
  await shoot(scenario, '01-home-silent', lang);
  // Настройки держат последний ответ панели, пока их не обновить: человек тянет
  // экран вниз — и только тогда видит «не отвечает».
  await openTab('settings', /^(Язык|Language)$/);
  phone.shell('input swipe 540 700 540 1900 250');
  if (!(await phone.waitFor(/^(не отвечает|not answering)$/i, 30_000))) {
    throw new Error(
      `настройки не сказали «не отвечает»: ${(await phone.texts()).slice(0, 30).join(' ¦ ')}`,
    );
  }
  await wait(2500);
  await shoot(scenario, '02-settings-silent', lang);
}

/** Приложение с нуля: данные стёрты, системного окна уведомлений нет. */
async function freshApp() {
  phone.stopApp();
  phone.clearData();
  // «Отказано навсегда»: системного окна нет, push-токен на панели не регистрируется.
  phone.shell(
    `pm set-permission-flags ${PACKAGE} android.permission.POST_NOTIFICATIONS user-fixed`,
  );
  phone.launch();
  if (!(await phone.waitFor(TAB.settings, 30_000))) throw new Error('приложение не поднялось');
}

// ─── прогон ──────────────────────────────────────────────────────────────────

let exitCode = 0;
let stand;
let proxy;
let desk;
try {
  stand = await startStand({
    web: false,
    label: 'phone-shots',
    fakeCli: { claude: PHONE_FAKE_CLI },
    seed: ({ cfg }) => {
      mkdirSync(DEMO_ROOT, { recursive: true });
      writeFileSync(DEMO_MARK, 'phone-device.mjs\n', 'utf8');
      seedPhoneDemo(cfg, PROJECTS);
    },
  });
  for (const path of PROJECTS) {
    const registered = await stand.api('/projects', { method: 'POST', body: { path } });
    if (registered.status !== 200) throw new Error(`проект не заведён: ${registered.text}`);
  }
  // Разговор, который «работает»: ход держит фальшивый CLI до конца съёмки.
  const controller = new AbortController();
  desk = { controller };
  void fetch(`${stand.apiUrl}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chatId: `new-${Date.now()}`,
      prompt: 'Run the checkout e2e tests',
      projectPath: PROJECTS[0],
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      for await (const _chunk of res.body ?? []) {
        // держим поток, как вкладка панели
      }
    })
    .catch(() => undefined);

  const { token } = (await stand.api('/remote')).body;
  const enabled = await stand.api('/remote', { method: 'PATCH', body: { enabled: true } });
  if (enabled.status !== 200) throw new Error(`«Пускать по токену» не включился: ${enabled.text}`);
  forbidden = [token, userInfo().username, hostname()].filter((value) => value && value.length > 3);

  proxy = await startProxy(stand.apiUrl);
  proxy.routes.push({
    name: 'remote-address',
    match: (method, path) => method === 'GET' && path === '/api/remote',
    handle: async (req, res, url) => {
      const { status, body } = await upstreamJson(stand.apiUrl, req, url, (value) =>
        value && typeof value === 'object' && value.detectedUrl
          ? { ...value, detectedUrl: `https://${SHOWN_HOST}` }
          : value,
      );
      json(res, status, body);
    },
  });
  const url = `http://10.0.2.2:${proxy.port}`;
  console.log(`Одноразовая панель ${stand.apiUrl}, прокси :${proxy.port}, устройство ${serial}`);

  browser = await chromium.launch();
  const pair = openPhoneScenario('pair');
  const day = openPhoneScenario('day');
  for (const lang of ['ru', 'en']) {
    console.log(`
телефон [light-${lang}]`);
    // Каждый язык начинается с чистого приложения. «Отключить» для второго
    // языка не годится: после него настройки ещё держат состояние прежней
    // панели («Доступ снаружи», «Панель шлёт уведомления») — это не экран
    // человека, который ставит приложение впервые.
    await freshApp();
    await setLanguage(lang);
    await pairFrames(lang, url, token, pair);
    if (wanted('day')) await dayFrames(lang, day);
  }
  pair.finish();
  // Не снятый сценарий не сверяется: его кадры иначе ушли бы как «устаревшие».
  if (wanted('day')) day.finish();

  if (wanted('offline')) {
    // Панель останавливается по-настоящему: и она, и прокси. Телефону больше
    // некуда ходить — ровно уснувший компьютер.
    desk.controller.abort();
    // Сначала рвём соединения: `close` ждёт открытых (поток чата телефона) вечно.
    proxy.closeAll?.();
    await proxy.close().catch(() => undefined);
    proxy = undefined;
    await stand.stop();
    stand = undefined;
    const offline = openPhoneScenario('offline');
    // Язык сейчас en: снимаем его, потом переключаемся — настройка локальная.
    await offlineFrames('en', offline);
    await setLanguage('ru');
    await offlineFrames('ru', offline);
    offline.finish();
  }
  writeVariantIndex('phone');
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не снято: ${error.message}`);
    exitCode = 2;
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    exitCode = 1;
  }
} finally {
  desk?.controller.abort();
  phone.stopApp();
  phone.clearData();
  await browser?.close();
  proxy?.closeAll?.();
  await proxy?.close().catch(() => undefined);
  await stand?.stop();
  rmSync(DEMO_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
process.exit(exitCode);
