/**
 * Кадры путеводителя «Контур», сторона ПАНЕЛИ.
 *
 * Панель поднимается СВОЯ, одноразовая: каталог конфигурации во временной
 * папке, свои порты, свой фронт. Рабочий стенд человека не трогается — ни его
 * контуры, ни его ассистент, ни его конфигурации CLI. Тот же приём, что в
 * `tools/qa/check-platform-foreign.mjs`.
 *
 * Контур — настоящий: локальный стенд платформа компании через `kubectl port-forward
 * svc/inst-api 5300:8080`. Ключ читается из `~/.agentdeck/enterprise-platform-credentials.env`
 * и не печатается: в кадре он закрыт набором, а в поле ввода он и так под точками.
 *
 * Запуск: node tools/help-shots/platform-connect-panel.mjs
 * Переменные: ENTERPRISE_PLATFORM_API (адрес контура), GUIDE_PANEL_PORT, GUIDE_WEB_PORT.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openScenario } from './kit.mjs';

const CONTOUR_URL = process.env.ENTERPRISE_PLATFORM_API ?? 'http://127.0.0.1:5300';
const PANEL_PORT = Number(process.env.GUIDE_PANEL_PORT ?? 5192);
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT ?? 8899);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
/** Идентификатор контура в панели: из него собран адрес шлюза. */
const CONTOUR_ID = 'enterprise-platform-stand';
/** Модель контура, которой доказывается связь. */
const MODEL = process.env.ENTERPRISE_PLATFORM_MODEL ?? 'qwen2.5:0.5b';

function contourKey() {
  const file = join(homedir(), '.agentdeck', 'enterprise-platform-credentials.env');
  const key = readFileSync(file, 'utf8')
    .match(/^ENTERPRISE_PLATFORM_LOCAL_INST_KEY=(.+)$/m)?.[1]
    ?.trim();
  if (!key) throw new Error(`в ${file} нет ENTERPRISE_PLATFORM_LOCAL_INST_KEY`);
  return key;
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const scenario = openScenario('platform', 'connect');
const started = [];
const home = mkdtempSync(join(tmpdir(), 'cc-guide-'));
mkdirSync(join(home, 'agentdeck'), { recursive: true });
writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
writeFileSync(join(home, 'CLAUDE.md'), '# путеводитель\n', 'utf8');

try {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: home,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
  };

  started.push(
    spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
      { env, stdio: 'ignore', shell: false },
    ),
  );
  if (!(await waitFor(`${PANEL}/api/system`, 40)))
    throw new Error('одноразовая панель не поднялась');
  console.log(`панель на ${PANEL}`);

  started.push(
    spawn(
      'node',
      [
        join('node_modules', 'vite', 'bin', 'vite.js'),
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--host',
        '127.0.0.1',
      ],
      {
        cwd: join(process.cwd(), 'apps', 'web'),
        // BROWSER=none — иначе Vite откроет окно поверх съёмки.
        env: { ...env, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
        stdio: 'ignore',
        shell: false,
      },
    ),
  );
  if (!(await waitFor(WEB, 90))) throw new Error('фронт одноразовой панели не поднялся');
  console.log(`фронт на ${WEB}`);

  await shootPanel();
  scenario.finish();
} finally {
  for (const child of started) child.kill();
  rmSync(home, { recursive: true, force: true });
}

async function shootPanel() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.goto(`${WEB}/platform`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Свежая панель встречает мастером онбординга. Он ЗАКРЫВАЕТСЯ по-настоящему,
    // а не перехватом ответа настроек: подменять на съёмке нечего — кадры
    // должны быть тем, что человек увидит сам.
    const skip = page.getByRole('button', { name: 'Пропустить' });
    if (await skip.count()) {
      await skip.first().click();
      await page.waitForTimeout(1200);
    }
    await scenario.shot(page, '09-panel-empty');

    // ── Мастер: адрес ──────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Подключить контур' }).first().click();
    await page.waitForTimeout(600);
    await page.getByLabel('Название').fill('Платформа компании · стенд');
    // Идентификатор собирается из названия, но собирается ЛАТИНИЦЕЙ: у русского
    // имени он выходит пустым, и «Проверить связь» остаётся выключенной. В
    // кадре это выглядело бы ошибкой панели, хотя поле просто ждёт ввода.
    await page.getByLabel('Идентификатор').fill('enterprise-platform-stand');
    await page.getByLabel('Адрес API').fill(CONTOUR_URL);
    await page.waitForTimeout(400);
    await scenario.shot(page, '10-wizard-address', { clip: '[role="dialog"]' });

    await page.getByRole('button', { name: 'Проверить связь' }).click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '11-wizard-probe', { clip: '[role="dialog"]' });

    // ── Мастер: ключ ───────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(500);
    await page.getByLabel('Ключ контура').fill(contourKey());
    await page.waitForTimeout(300);
    await scenario.shot(page, '12-wizard-key', { clip: '[role="dialog"]' });

    // ── Мастер: что умеет контур ───────────────────────────────────────────
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(3000);
    await scenario.shot(page, '13-wizard-capabilities', { clip: '[role="dialog"]' });

    // ── Мастер: куда применять ─────────────────────────────────────────────
    // Окно выше остальных: на последнем шаге под списком потребителей стоят
    // поля, которые человеку и нужно заполнить, — режим на случай отказа,
    // бюджет и день сброса. В окне 820px они уходят под срез, и кадр обещает
    // меньше, чем шаг на самом деле просит.
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '14-wizard-targets', { clip: '[role="dialog"]' });

    // ── Мастер: шлюз ───────────────────────────────────────────────────────
    // Пока шлюз не поднят, применять НЕ К ЧЕМУ: у всех потребителей стоит
    // прочерк с этой самой причиной. Шаг нельзя пропустить в путеводителе —
    // именно здесь человек чаще всего застревает.
    const raise = page.getByRole('button', { name: 'Поднять шлюз' });
    if (await raise.count()) {
      await raise.first().click();
      await page.waitForTimeout(3000);
    }
    await scenario.shot(page, '15-wizard-gateway', { clip: '[role="dialog"]' });

    // Дальше кадры снимаются окном целиком — окно возвращается к общему размеру.
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.waitForTimeout(3000);
    await scenario.shot(page, '16-panel-card');

    // ── Живой запрос через шлюз панели ─────────────────────────────────────
    // Запрос нарочно в два символа: доказать связь, а не потратить бюджет.
    // Идёт он ровно тем путём, которым пойдёт любой потребитель — через
    // локальный шлюз панели, а не мимо него.
    const gateway = await fetch(`${PANEL}/api/platforms/gateway`).then((r) => r.json());
    // Адрес берётся у самого шлюза, а не собирается из настроек: занятый порт
    // он отдаёт соседу и пишет в ответ тот, который ДОСТАЛСЯ. Пустая строка —
    // не «адреса нет», а «шлюз не поднялся», и `??` её не ловит: падать надо
    // здесь, с ответом шлюза в руках, а не в fetch по обрывку URL.
    const address = gateway?.status?.address || '';
    if (!address)
      throw new Error(`шлюз панели не поднят: ${JSON.stringify(gateway).slice(0, 300)}`);
    const answer = await fetch(`${address}/${CONTOUR_ID}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '2+2=' }],
        stream: true,
        max_tokens: 24,
      }),
    });
    const body = await answer.text();
    const said = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5))?.choices?.[0]?.delta?.content ?? '';
        } catch {
          return '';
        }
      })
      .join('');
    console.log(
      `  живой запрос через шлюз: ${answer.status}, ответ ${JSON.stringify(said.slice(0, 60))}`,
    );
    if (!answer.ok || !said.trim()) throw new Error('контур не ответил через шлюз панели');

    // ── Что видно после живого запроса ─────────────────────────────────────
    await page.goto(`${WEB}/platform`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await scenario.shot(page, '17-panel-spend', { clip: '[data-testid="platform-card"], main' });

    // ── Как отключить ──────────────────────────────────────────────────────
    // Снимается ДИАЛОГ удаления, а не страница ещё раз: он один объясняет обе
    // развилки — применение снимается перед удалением, а файл, изменённый
    // человеком после применения, остаётся и будет назван. Кадр целой страницы
    // здесь повторял бы кадр 16 слово в слово.
    await page.getByRole('button', { name: 'Удалить', exact: true }).first().click();
    await page.waitForTimeout(1000);
    await scenario.shot(page, '18-panel-delete', { clip: '[role="dialog"]' });
  } finally {
    await browser.close();
  }
}
