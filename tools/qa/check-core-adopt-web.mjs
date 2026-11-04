/**
 * Перенос ключей телефона в ядро из окна панели (этап 10, зона D): НАСТОЯЩИЙ сервер панели с
 * привязанным ключом телефона, НАСТОЯЩЕЕ ядро стенда, настоящий фронт.
 *
 * Что проверяется:
 * 1. На карточке «Подпись решений телефоном» (Настройки → Доступ) есть «Перенести ключи в ядро».
 * 2. Нажатие → ядро приняло ключ (`adopted`), карточка называет итог.
 * 3. Ядро записало номер машины ПАНЕЛИ (`<дом ядра>/machine-id` = `machineId` из `/phone-signing`) —
 *    без него ни одна подпись телефона ядру не годится — и ключ телефона в `devices.json`.
 *
 * Ключ телефона кладётся в `phone-signing.json` дома панели до старта (привязка — только с
 * телефона). `SHOT_TAG=BEFORE|AFTER` — имя снимка карточки в `.agent/screenshots/before-after/
 * core-s10-d/`. Запуск: `node tools/qa/check-core-adopt-web.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { mobileModule } from './mobile-lib.mjs';
import { REPO, runOnStand } from './throwaway-stand.mjs';

const { keyFromSeed } = await mobileModule('shared/api/signing/signing.ts');
const SHOTS = join(REPO, '.agent/screenshots/before-after/core-s10-d');
const TAG = process.env.SHOT_TAG ?? 'AFTER';
const key = keyFromSeed(new Uint8Array(randomBytes(32)));
let coreHomeSeen;

await runOnStand(
  {
    label: 'core-adopt-web',
    core: true,
    env: { AGENTDECK_CORE_SUPERVISE: '0' },
    seed: ({ home, coreHome }) => {
      coreHomeSeen = coreHome;
      const panelHome = join(home, '.agentdeck');
      mkdirSync(panelHome, { recursive: true });
      writeFileSync(
        join(panelHome, 'phone-signing.json'),
        JSON.stringify({
          version: 1,
          enabled: false,
          devices: [
            {
              id: key.deviceId,
              label: 'QA телефон',
              publicKey: key.publicKey,
              boundAt: '2026-11-02T08:00:00.000Z',
            },
          ],
          nonces: [],
        }),
      );
    },
  },
  async (stand, check) => {
    const view = await stand.api('/phone-signing');
    const panelMachine = view.body?.machineId;
    check(
      'панель видит привязанный ключ телефона',
      view.body?.devices?.[0]?.id === key.deviceId,
      view.text.slice(0, 300),
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1280, height: 1100 });
      // Маскот этого браузера выключен: его облачко ложится поверх карточки на снимке.
      await page.addInitScript(() =>
        localStorage.setItem(
          'agentdeck.mascot',
          JSON.stringify({ enabled: false, chatty: false, greeted: true, reactions: false }),
        ),
      );
      await page.goto(`${stand.webUrl}/settings?tab=access`);
      const card = page
        .locator('section, article, div')
        .filter({ has: page.getByText('Подпись решений телефоном', { exact: true }) })
        .filter({ has: page.getByText('QA телефон') })
        .last();
      await card.waitFor({ timeout: 30_000 });
      const button = page.locator('[data-core-adopt]');
      const hasButton = (await button.count()) === 1;
      check('на карточке есть «Перенести ключи в ядро»', hasButton);
      if (hasButton) {
        await button.click();
        const result = page.locator('[data-core-adopt-result]');
        await result.waitFor({ timeout: 30_000 }).catch(() => undefined);
        const text = (await result.count()) ? await result.innerText() : '';
        check(
          'карточка называет итог: ядро приняло 1 ключ',
          text.includes('Ядро приняло ключей: 1'),
          text || 'итога нет',
        );
      }
      await page.waitForTimeout(300);
      mkdirSync(SHOTS, { recursive: true });
      await card.screenshot({ path: join(SHOTS, `phone-signing-card_${TAG}.png`) });
    } finally {
      await browser.close();
    }

    const machineFile = join(coreHomeSeen, 'machine-id');
    const coreMachine = existsSync(machineFile) ? readFileSync(machineFile, 'utf8').trim() : '';
    check(
      'ядро записало номер машины панели',
      Boolean(panelMachine) && coreMachine === panelMachine,
      `ядро: ${coreMachine || 'нет файла'}, панель: ${panelMachine}`,
    );
    const devicesFile = join(coreHomeSeen, 'devices.json');
    const devices = existsSync(devicesFile) ? readFileSync(devicesFile, 'utf8') : '';
    check(
      'ключ телефона — в устройствах ядра',
      devices.includes(key.deviceId),
      devices || 'нет файла',
    );
  },
);
