/**
 * Кадры панели для раздела «Подпись решений» документа «Телефон»:
 * `phone/signing` 01–02 — карточка «Подпись решений телефоном» во вкладке
 * «Доступ» (режим включён, один ключ живой, один отозван) и подтверждение
 * отзыва последнего живого ключа. Четыре варианта за прогон: тема × язык.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`): файл режима
 * `~/.agentdeck/phone-signing.json` засеян в доме стенда — ключи настоящие
 * Ed25519 из фиксированных зёрен, поэтому отпечатки в кадре те же от прогона к
 * прогону. Ключ телефона здесь не привязать (привязка — подпись самим ключом,
 * её делает телефон), поэтому состояние засеяно, а не нажато.
 *
 * ПОДМЕНЕНЫ ДВА ПОЛЯ. Путь файла режима в `GET /api/phone-signing`: настоящий
 * лежит во временном каталоге профиля съёмки, в кадре — нейтральный
 * `~/.agentdeck/phone-signing.json`, ровно то место, где файл у человека. И
 * адрес Tailscale в `/api/remote` (имя машины съёмки), как в `phone-panel.mjs`.
 * После съёмки текст кадров сверяется с именем пользователя и машины —
 * совпадение роняет прогон.
 *
 * Запуск: node tools/help-shots/phone-signing-panel.mjs
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import {
  DEFAULT_MASKS,
  SHOTS_ROOT,
  SHOT_LANGS,
  SHOT_THEMES,
  applyShotLanguage,
  openScenario,
  writeVariantIndex,
} from './kit.mjs';

const SHOWN_PATH = '~/.agentdeck/phone-signing.json';
const SHOWN_ADDRESS = 'https://desk.tailnet-example.ts.net';
/**
 * Под окном отзыва видна вкладка «Доступ» целиком, а в ней — пути стенда
 * (каталог профиля машины съёмки с именем пользователя). Закрываются в любом
 * тексте кадра, как в `settings-mascot.mjs`.
 */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\Users\\\S+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/\S+`,
];
const TITLE = { ru: 'Подпись решений телефоном', en: 'Decisions signed by the phone' };
const card = (lang) =>
  `xpath=//*[text()="${TITLE[lang]}"]/ancestor::div[contains(@class,"padding-md")][1]`;

/** Открытый ключ Ed25519 (base64url) из 32-байтового зерна — как у телефона. */
function publicKeyOf(fill) {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, fill),
  ]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({
    format: 'jwk',
  });
  return jwk.x;
}

function device(fill, label, extra) {
  const publicKey = publicKeyOf(fill);
  const raw = Buffer.from(publicKey, 'base64url');
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { id, label, publicKey, ...extra };
}

function seed({ home }) {
  const dir = join(home, '.agentdeck');
  mkdirSync(dir, { recursive: true });
  const live = device(7, 'Pixel 8', {
    boundAt: '2026-10-20T09:15:00.000Z',
    lastUsedAt: '2026-10-24T08:40:00.000Z',
  });
  const old = device(9, 'Galaxy S21', {
    boundAt: '2026-09-02T12:00:00.000Z',
    revokedAt: '2026-10-20T09:10:00.000Z',
  });
  writeFileSync(
    join(dir, 'phone-signing.json'),
    `${JSON.stringify(
      {
        version: 1,
        enabled: true,
        enabledAt: '2026-10-20T09:20:00.000Z',
        enabledBy: live.id,
        devices: [live, old],
        nonces: [],
      },
      null,
      2,
    )}\n`,
  );
}

const stand = await startStand({ label: 'phone-signing-shots', seed });

async function shoot(browser, scenario, lang) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 1100 } });
  const page = await context.newPage();
  await page.route('**/api/phone-signing', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, storePath: SHOWN_PATH } });
  });
  // Карточка «Удалённый доступ» выше по вкладке показывает адрес машины съёмки
  // в её tailnet (имя машины) — под окном отзыва он виден. Как в `phone-panel.mjs`.
  await page.route(
    (url) => url.pathname.startsWith('/api/remote'),
    async (route) => {
      const response = await route.fetch();
      const body = await response.json().catch(() => undefined);
      await route.fulfill({
        response,
        json:
          body && typeof body === 'object' && 'detectedUrl' in body
            ? { ...body, detectedUrl: SHOWN_ADDRESS }
            : body,
      });
    },
  );
  try {
    await page.goto(`${stand.webUrl}/settings?tab=access`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(card(lang), { timeout: 20_000 });
    await wait(1_000);
    // Страница настроек прокручивается своим контейнером, а не окном: карточку
    // подводит к верху сам элемент, иначе кадр обрезался по низу окна.
    await page
      .locator(card(lang))
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => document.activeElement?.blur?.());
    await wait(600);
    await scenario.shot(page, '01-panel-card', {
      clip: card(lang),
      padding: 20,
      maskText: MASKS,
    });

    // Отзыв последнего живого ключа при включённом режиме — окно называет путь
    // файла, которым режим выключается без телефона.
    await page
      .locator(card(lang))
      .first()
      .getByRole('button', { name: lang === 'ru' ? 'Отозвать' : 'Revoke' })
      .click();
    const dialog = '[role="alertdialog"], [role="dialog"]';
    await page.waitForSelector(dialog, { timeout: 10_000 });
    await wait(700);
    // Без полей: под окном — вкладка целиком, в кадр идёт только само окно.
    await scenario.shot(page, '02-panel-revoke-last', {
      clip: dialog,
      padding: 0,
      maskText: MASKS,
    });
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
}

let exitCode = 0;
try {
  const browser = await chromium.launch();
  try {
    for (const theme of SHOT_THEMES) {
      for (const lang of SHOT_LANGS) {
        await applyShotLanguage(stand.apiUrl, lang, theme);
        const scenario = openScenario('phone', 'signing', lang, theme);
        console.log(`\nсценарий phone/signing [${theme}-${lang}]`);
        await shoot(browser, scenario, lang);
        scenario.finish();
      }
    }
  } finally {
    await browser.close();
  }
  writeVariantIndex('phone');
  const manifest = readFileSync(join(SHOTS_ROOT, 'phone', 'signing', 'frames.json'), 'utf8');
  for (const name of [userInfo().username, hostname()]) {
    if (name && manifest.toLowerCase().includes(name.toLowerCase())) {
      throw new Error(`в тексте кадров phone/signing есть имя машины съёмки: ${name}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stand.stop();
}
process.exit(exitCode);
