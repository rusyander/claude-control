/**
 * Кадры панели на СЦЕНАРНОМ контуре: то, чего живой стенд показать не может.
 *
 * Модель стенда — локальная 0.5B: удачный вызов инструмента она не делает, а
 * рисующей модели у ключа нет вовсе. Поэтому три сцены снимаются на контуре
 * сторожей панели (`tools/qa/stub-platform.mjs`): удачный вызов через прослойку
 * и пример вызова, который панель НЕ исполняет; картинка растровой дорогой
 * контура; красный пробный запрос. Подменена ровно модель — панель, шлюз,
 * настоящий `claude` и файл на диске настоящие, и файл проверяется здесь же:
 * кадр «вызов выполнен» без файла был бы рисунком, а не снимком.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { startStubPlatform } from '../qa/stub-platform.mjs';
import {
  L,
  exact,
  mark,
  frameArea,
  openPlatformTab,
  pause,
  waitText,
} from './platform-shots-lib.mjs';
import { STAND_TITLE as standTitle } from './platform-stand-panel.mjs';

export const SCRIPTED_TITLE = L('Сценарный контур', 'Scripted contour');
const SCRIPTED_ID = 'scripted';
/** Порт постоянный: продолжение отладочной съёмки находит контур на том же адресе. */
const STUB_PORT = Number(process.env.GUIDE_STUB_PORT ?? 5199);
const SMOKE_OK = new RegExp(L('Пробный запрос прошёл', 'Test request went through'));
const SMOKE_FAILED = new RegExp(
  L(
    'Пробный запрос через шлюз не прошёл',
    'The test request through the gateway did not go through',
  ),
);

const button = (page, ru, en) => page.getByRole('button', { name: exact(ru, en) }).first();

/**
 * Картинка, которую «нарисует» сценарный контур: маяк в сумерках, 480×300.
 * Точка 1×1 свипа в карточке не видна вовсе, и кадр читался бы как пустой.
 * Собирается здесь же без зависимостей — сырые пиксели в PNG через zlib.
 */
function lighthousePng(width = 480, height = 300) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const horizon = Math.round(height * 0.62);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const t = y / horizon;
      let rgb =
        y < horizon
          ? [Math.round(40 + 200 * t), Math.round(40 + 90 * t), Math.round(110 + 20 * t)]
          : [30, Math.round(60 + (y - horizon) * 0.2), 110];
      const cliff = height - Math.round(90 * Math.exp(-(((x - 330) / 110) ** 2)));
      if (y > cliff - 20 && x > 220) rgb = [45, 38, 40];
      const beam = y > 60 && y < 140 && Math.abs(y - 100) < (330 - x) * 0.18 && x < 330;
      if (beam) rgb = rgb.map((c) => Math.min(255, c + 60));
      if (x > 318 && x < 342 && y > 95 && y < cliff - 18)
        rgb = (y >> 4) % 2 ? [235, 235, 230] : [200, 40, 40];
      if (x > 314 && x < 346 && y > 80 && y <= 95) rgb = [255, 220, 120];
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/** Остановить стаб, не дожидаясь, пока шлюз сам закроет свои соединения. */
async function stopStub(stub) {
  await Promise.race([stub.close(), pause(2500)]);
}

/** Дождаться текста внутри помеченной карточки: на странице карточек две. */
async function waitInCard(page, selector, pattern, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const text = await page.locator(selector).first().innerText();
    if (pattern.test(text)) return;
    await pause(500);
  }
  throw new Error(`в ${selector} не дождался: ${pattern}`);
}

/** Мастер без кадров, те же шаги, что у стенда. Новый контур мастер делает активным сам. */
async function createScripted(page, url) {
  await button(page, 'Подключить контур', 'Connect a contour').click();
  await pause(700);
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByLabel(exact('Название', 'Name')).fill(SCRIPTED_TITLE);
  await dialog.getByLabel(exact('Идентификатор', 'Identifier')).fill(SCRIPTED_ID);
  await dialog.getByLabel(exact('Адрес API', 'API address')).fill(url);
  await button(page, 'Далее', 'Next').click();
  await pause(500);
  await dialog.getByLabel(exact('Ключ контура', 'Contour key')).fill(['stub', 'key'].join('-'));
  await button(page, 'Далее', 'Next').click();
  await pause(3500);
  await button(page, 'Далее', 'Next').click();
  await pause(1000);
  const chat = dialog
    .locator('label')
    .filter({ hasText: new RegExp(`^${L('Чат', 'Chat')}`) })
    .locator('input');
  if (await chat.count()) await chat.first().check();
  await button(page, 'Готово', 'Done').click();
  await pause(3000);
}

/** Новый чат, прогон до конца; попутно разрешить запись, если CLI о ней спросит. */
async function runChat(page, web, text) {
  // `/chat` открывает последний разговор — без нового чата кадр нёс бы хвост
  // прошлого прогона на другом контуре.
  await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
  await pause(3000);
  await button(page, 'Новый чат', 'New chat').click();
  await pause(1500);
  const box = page.locator('textarea').first();
  await box.fill(text);
  await box.press('Enter');
  let allowed = false;
  for (let i = 0; i < 80; i += 1) {
    await pause(2500);
    const allow = page.getByRole('button', { name: /^(Разрешить|Allow)/ });
    if (!allowed && (await allow.count())) {
      await allow.first().click();
      allowed = true;
      continue;
    }
    const running = await page.getByRole('button', { name: /Остановить|Stop/ }).count();
    if (i > 2 && !running) break;
  }
  await pause(1500);
}

async function setDefaultModel(page, web, model) {
  await openPlatformTab(page, web, 'model', SCRIPTED_TITLE);
  const card = await mark(
    page,
    L(`Модель контура · ${SCRIPTED_TITLE}`, `Contour model · ${SCRIPTED_TITLE}`),
    'scripted-model',
  );
  await page
    .locator(card)
    .getByLabel(exact('Модель по умолчанию', 'Default model'))
    .selectOption(model);
  await pause(2000);
}

export async function shootScripted({ page, web, shots }) {
  const { scripted } = shots;
  let stub = await startStubPlatform({ port: STUB_PORT, png: lighthousePng() });
  const folder = join(realpathSync.native(tmpdir()), 'cc-guide-shim');
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });

  try {
    // ── Сценарный контур: тот же мастер, без кадров ─────────────────────────
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
    await pause(3000);
    if (await page.getByText(SCRIPTED_TITLE, { exact: true }).count()) {
      // Продолжение отладочной съёмки (`GUIDE_REUSE`): контур уже заведён.
      await mark(page, SCRIPTED_TITLE, 'scripted-card');
      const on = page
        .locator('[data-shot="scripted-card"]')
        .getByRole('button', { name: exact('Сделать активным', 'Make it active') });
      if (await on.count()) await on.click();
    } else await createScripted(page, stub.url);
    await mark(page, SCRIPTED_TITLE, 'scripted-card');
    await waitInCard(page, '[data-shot="scripted-card"]', SMOKE_OK, 60);

    // ── Удачный вызов через прослойку: файл обязан появиться ────────────────
    await setDefaultModel(page, web, 'stub-tool-shim');
    const done = join(folder, 'hello.txt').replace(/\\/g, '/');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await runChat(page, web, L(`Запиши файл. ФАЙЛ: ${done}`, `Write the file. ФАЙЛ: ${done}`));
    if (!existsSync(done))
      throw new Error(`вызов через прослойку не создал ${done} — кадр был бы неправдой`);
    await scripted.shot(page, '01-shim-call');

    // ── Пример вызова в заборе: файл НЕ должен появиться ─────────────────────
    await setDefaultModel(page, web, 'stub-tool-quote');
    const quoted = join(folder, 'quoted.txt').replace(/\\/g, '/');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await runChat(
      page,
      web,
      L(
        `Покажи, как выглядит вызов. ФАЙЛ: ${quoted}`,
        `Show what a call looks like. ФАЙЛ: ${quoted}`,
      ),
    );
    if (existsSync(quoted))
      throw new Error('пример из забора исполнился — это дефект прослойки, а не кадр');
    await scripted.shot(page, '02-shim-quote');

    await openPlatformTab(page, web, 'tools');
    let area = await frameArea(
      page,
      await mark(page, L('Инструменты через контур', 'Tools through the contour'), 'shim-card'),
      { margin: 70 },
    );
    await scripted.shot(page, '03-shim-card', { clip: area });

    // ── Картинка растровой дорогой контура ──────────────────────────────────
    // Окно шире: превью справа забирает половину, и в 1280 разговор
    // сжимается до колонки в букву.
    await page.setViewportSize({ width: 1680, height: 900 });
    // Картинка ложится карточкой в превью РАЗГОВОРА: просится в последнем чате,
    // у черновика разговора ещё нет.
    await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
    await pause(3000);
    await page
      .getByRole('button', { name: /^(Сообщение|Message)/ })
      .first()
      .click();
    await pause(2500);
    // Меню режимов — окно с кнопками (`ChatModeMenu`), не `menu`.
    const menu = page.locator('[role="dialog"]');
    await scripted.shot(page, '04-image-menu', { clip: '[role="dialog"]', padding: 24 });
    await menu
      .getByRole('button', { name: /^\s*(Картинка|Image)/ })
      .first()
      .click();
    await pause(800);
    const box = page.locator('textarea').first();
    await box.fill(
      L('Маяк на скале в сумерках, акварель', 'A lighthouse on a cliff at dusk, watercolour'),
    );
    await box.press('Enter');
    await waitText(page, /Нарисовано:|Drawn by|Не получилось:|Did not work out:/, 60);
    if (/Не получилось:|Did not work out:/.test(await page.locator('body').innerText()))
      throw new Error('картинка не нарисовалась — кадр отказа здесь не нужен');
    await pause(1500);
    await scripted.shot(page, '05-image-card');

    // ── Переключение обратно на стенд: кнопка второго контура ───────────────
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
    await pause(3000);
    area = await frameArea(page, await mark(page, standTitle, 'stand-card'));
    await scripted.shot(page, '06-switch-button', { clip: area });
    await page
      .locator('[data-shot="stand-card"]')
      .getByRole('button', { name: exact('Сделать активным', 'Make it active') })
      .click();
    await waitInCard(page, '[data-shot="stand-card"]', SMOKE_OK, 90);
    await pause(1500);

    // ── Красный пробный запрос: контур перестал отвечать ────────────────────
    await stopStub(stub);
    stub = undefined;
    await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
    await pause(3000);
    await mark(page, SCRIPTED_TITLE, 'scripted-card');
    await page
      .locator('[data-shot="scripted-card"]')
      .getByRole('button', { name: exact('Сделать активным', 'Make it active') })
      .click();
    await waitInCard(page, '[data-shot="scripted-card"]', SMOKE_FAILED, 90);
    await pause(800);
    area = await frameArea(page, '[data-shot="scripted-card"]');
    await scripted.shot(page, '07-smoke-red', { clip: area });
  } finally {
    if (stub) await stopStub(stub);
    rmSync(folder, { recursive: true, force: true });
  }
}
