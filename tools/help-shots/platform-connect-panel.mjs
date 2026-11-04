/**
 * Кадры путеводителя «Контур», сторона ПАНЕЛИ: все сценарии одной съёмкой.
 *
 * Панель поднимается СВОЯ, одноразовая — `startStand` из `tools/qa/throwaway-stand.mjs`: свой дом
 * (`~/.claude` И `~/.agentdeck` во временной папке), свои порты, свой фронт, ядро под надзором
 * панели, как у человека. Рабочий стенд человека не трогается — ни его контуры, ни его ассистент,
 * ни его конфигурации CLI (прежний запуск подменял один CLAUDE_CONFIG_DIR, и данные панели
 * уезжали в настоящий `~/.agentdeck`).
 *
 * Сценарии идут путём человека, потому что каждый опирается на состояние,
 * оставленное предыдущим: подключение → активация с пробным запросом →
 * маршрут → правила → агент → режимы → сценарный контур → удаление.
 * Живой контур — локальный стенд платформы компании (`PLATFORM_API`); ключ — файлом из
 * `PLATFORM_STAND_KEY_FILE` / `PLATFORM_STAND_KEY_VAR` (не печатается). Сценарный —
 * `tools/qa/stub-platform.mjs` (см. `platform-scripted-panel.mjs`, зачем он и что в нём подменено).
 *
 * `finish()` зовётся только после ПОЛНОСТЬЮ удачной съёмки: он удаляет кадры
 * своей стороны, не снятые этим прогоном, и упавшая на середине съёмка
 * стёрла бы честные кадры прошлой. Съёмка части шагов (`GUIDE_STEPS`) кадров вне выбора не
 * трогает (`keepUnshot`): «Удаление» дописывает кадр в «connect», а «Активация» — его 17-й.
 *
 * Запуск: node tools/help-shots/platform-connect-panel.mjs   (GUIDE_LANG=en, GUIDE_THEME=dark)
 * Переменные: PLATFORM_API, PLATFORM_MODEL, PLATFORM_STAND_KEY_FILE, PLATFORM_STAND_KEY_VAR,
 * GUIDE_STUB_PORT, GUIDE_HEADED=1, GUIDE_STEPS=connect,rules (только эти шаги).
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStand } from '../qa/throwaway-stand.mjs';
import { applyShotLanguage, openScenario } from './kit.mjs';
import { LANG } from './platform-shots-lib.mjs';
import {
  shootActivate,
  shootAgent,
  shootConnect,
  shootDelete,
  shootMedia,
  shootRoute,
  shootRules,
} from './platform-stand-panel.mjs';
import { shootScripted } from './platform-scripted-panel.mjs';

const CONTOUR_URL = process.env.PLATFORM_API ?? 'http://api.localhost';
const SCENARIOS = ['connect', 'activate', 'route', 'rules', 'agent', 'media', 'scripted'];
const ONLY = (process.env.GUIDE_STEPS ?? '').split(',').filter(Boolean);

/**
 * Каталог настоящего `claude` из PATH оболочки — в конец PATH стенда, как у `check-core-chat.mjs`.
 * Сценарный контур ведёт чат через ядро, а оценка ядра отказывает задаче, когда CLI её маршрута нет
 * в PATH («claude not found»). Модель у такого чата — заглушка сценарного контура за шлюзом ядра.
 */
function claudeDir() {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  const first = found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : '';
  return first ? [dirname(first)] : [];
}

const stand = await startStand({
  label: 'guide',
  web: true,
  core: { supervised: true },
  extraPath: claudeDir(),
});
/** @type {string[]} */
const leftovers = [];
try {
  console.log(`панель на ${stand.apiUrl}, фронт на ${stand.webUrl}`);
  await applyShotLanguage(stand.apiUrl, LANG);
  const shots = Object.fromEntries(SCENARIOS.map((id) => [id, openScenario('platform', id)]));
  const browser = await chromium.launch({ headless: process.env.GUIDE_HEADED !== '1' });
  const ran = new Set();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    // Дом стенда одноразовый: входа Claude Code в нём нет, и боковая полоса писала «Нет входа
    // Claude Code на этой машине» над каждым кадром — про контур это ничего не говорит. Окна
    // подписки прячутся так же, как у входа ключом API; знакомство с маскотом уже было — его
    // приветствие ложилось на низ кадра.
    await page.route('**/api/usage-limits', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 'api-key' }),
      }),
    );
    // По той же причине чат открывался окном «Ассистенту Claude Code нужен доступ» поверх кадра и
    // под ним прятал кнопку режимов: у человека вход есть, раннер — CLI.
    await page.route('**/api/provider-runner', async (route) => {
      const response = await route.fetch();
      const runner = await response.json();
      await route.fulfill({ response, json: { ...runner, mode: 'cli' } });
    });
    await page.addInitScript(() =>
      window.localStorage.setItem(
        'agentdeck.mascot',
        JSON.stringify({ enabled: false, chatty: false, greeted: true }),
      ),
    );
    const ctx = {
      page,
      web: stand.webUrl,
      panel: stand.apiUrl,
      shots,
      contourUrl: CONTOUR_URL,
      leftovers,
    };
    const steps = [
      ['connect', shootConnect],
      ['activate', shootActivate],
      ['route', shootRoute],
      ['rules', shootRules],
      ['agent', shootAgent],
      ['media', shootMedia],
      ['scripted', shootScripted],
      ['delete', shootDelete],
    ];
    for (const [name, step] of steps) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      console.log(`— ${name}`);
      try {
        await step(ctx);
      } catch (error) {
        // Кадр места падения: без него причину пришлось бы угадывать по тексту ошибки.
        const shot = join(tmpdir(), 'cc-guide-fail.png');
        await page.screenshot({ path: shot }).catch(() => {});
        console.log(`упало на «${name}», экран: ${shot}`);
        throw error;
      }
      ran.add(name);
    }
  } finally {
    await browser.close();
  }
  for (const id of SCENARIOS) if (ran.has(id)) shots[id].finish({ keepUnshot: ONLY.length > 0 });
} finally {
  await stand.stop();
  // Папки съёмки, которые держал живой чат ядра, — только теперь, когда стенд остановлен.
  for (const folder of leftovers) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.log(`папка съёмки не убрана (${error.code ?? error.message}): ${folder}`);
    }
  }
}
