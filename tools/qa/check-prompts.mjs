/**
 * Каталог промптов на экране настроек: чтение встроенного текста рядом со своим,
 * подтверждение перед сбросом и отказ маршрута, который человек обязан увидеть.
 *
 * Все три проверки — про то, чего на карточке НЕ БЫЛО и что нашло ревью Т4:
 * `builtinText` приезжал и нигде не рисовался, «Сбросить» стирал правку без
 * вопроса, а отказ сохранения уходил в консоль. Проверять это на настоящей
 * конфигурации нельзя (DELETE стёр бы правку владельца стенда), поэтому прогон
 * подменяет `/api/prompts` целиком и ничего на диске не трогает.
 *
 * Запуск: `node tools/qa/check-prompts.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'prompts');
await mkdir(OUT_DIR, { recursive: true });

const problems = [];
const ok = (name) => console.log(`  ок  ${name}`);
const expect = (passed, name, detail) => {
  if (passed) ok(name);
  else {
    problems.push(`${name}: ${detail}`);
    console.log(`  !!  ${name} — ${detail}`);
  }
};

const BUILTIN = 'ВСТРОЕННЫЙ ТЕКСТ РЕПОЗИТОРИЯ — маркер прогона';
const MINE = 'мой текст вместо встроенного';

/** Состояние подменённого каталога: правка есть только у «Картинки». */
const record = (id) => ({
  id,
  version: 3,
  text: id === 'image' ? MINE : BUILTIN,
  builtinText: BUILTIN,
  overridden: id === 'image',
  builtinChanged: id === 'image',
  ...(id === 'image' ? { updatedAt: '2026-09-12T10:00:00.000Z' } : {}),
});

const summary = (id) => ({
  id,
  version: 3,
  overridden: id === 'image',
  builtinChanged: id === 'image',
  bytes: id === 'image' ? MINE.length : BUILTIN.length,
});

const IDS = ['tool-protocol', 'contour-agent', 'contour-preamble', 'image', 'presentation'];

const browser = await chromium.launch();

/**
 * Своя вкладка на каждую проверку: подмены живут на вкладке, а состояние
 * каталога у проверок разное.
 */
async function open({ failSave = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const calls = [];
  const consoleErrors = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));

  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json();
      body.onboardingDone = true;
      body.language = 'ru';
      await route.fulfill({ response, json: body });
    } catch {
      /* вкладка уже закрыта — ответ никому не нужен */
    }
  });

  await page.route('**/api/prompts', (route) =>
    route.fulfill({ json: { items: IDS.map(summary) } }),
  );

  await page.route('**/api/prompts/*', (route) => {
    const method = route.request().method();
    const id = route.request().url().split('/').pop();
    calls.push(`${method} ${id}`);
    if (method === 'GET') return route.fulfill({ json: record(id) });
    if (method === 'PUT') {
      // Тот же отказ, что отдаёт настоящий маршрут на слишком длинный текст.
      if (failSave) {
        return route.fulfill({
          status: 400,
          json: { error: 'prompt_too_long', message: 'Промпт длиннее 64 КБ.' },
        });
      }
      return route.fulfill({ json: record(id) });
    }
    if (method === 'DELETE') return route.fulfill({ json: { ...record(id), overridden: false } });
    return route.continue();
  });

  await page.goto(`${BASE}/settings?tab=prompts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(900);
  return { page, calls, consoleErrors };
}

async function finish(page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.close();
}

/** Открыть карточку промпта по его строке в списке. */
async function openPrompt(page, id) {
  await page.locator(`[data-prompt="${id}"]`).getByRole('button', { name: 'Открыть' }).click();
  await page.waitForTimeout(600);
}

// 1. Встроенный текст читается, не стирая свой.
{
  const { page, consoleErrors } = await open();
  await openPrompt(page, 'image');

  // Текст живёт в textarea: `innerText` его не видит, и проверка на нём
  // проходила бы при пустом поле.
  const fields = () => page.locator('#prompt-editor textarea');
  expect(
    (await fields().first().inputValue()) === MINE,
    'в поле рабочий текст — правка человека',
    (await fields().first().inputValue()).slice(0, 120),
  );
  expect(
    (await fields().count()) === 1,
    'встроенный текст до нажатия не показан',
    'на карточке уже два поля',
  );

  const show = page.getByRole('button', { name: 'Показать встроенный' });
  expect(
    (await show.count()) === 1,
    'у правленого промпта есть «Показать встроенный»',
    'кнопки нет',
  );
  await show.click();
  await page.waitForTimeout(400);

  // Панели нет — остальные проверки про неё бессмысленны, но прогон обязан
  // дойти до конца: иначе одна поломка прячет состояние всех соседних.
  const panel = page.locator('#prompt-builtin');
  const opened = (await panel.count()) === 1;
  expect(opened, 'панель встроенного текста раскрылась', 'панели нет');
  if (opened) {
    const area = panel.locator('textarea').first();
    const shown = await area.inputValue();
    expect(shown === BUILTIN, 'в панели ВСТРОЕННЫЙ текст, а не правка', shown.slice(0, 120));
    expect(
      !(await area.isEditable()),
      'встроенный текст только для чтения',
      'поле встроенного текста правится',
    );
    expect(
      (await page.locator('#prompt-editor textarea').first().inputValue()) === MINE,
      'свой текст при этом остался нетронутым',
      'рабочий текст подменился встроенным',
    );
    await page.screenshot({ path: join(OUT_DIR, 'builtin-open.png'), fullPage: true });

    await page.getByRole('button', { name: 'Скрыть встроенный' }).click();
    await page.waitForTimeout(300);
    expect(
      (await page.locator('#prompt-builtin').count()) === 0,
      'панель сворачивается тем же переключателем',
      'панель осталась раскрытой',
    );
  }

  // Промпт без правки сравнивать не с чем: кнопки быть не должно.
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.waitForTimeout(400);
  await openPrompt(page, 'presentation');
  expect(
    (await page.getByRole('button', { name: 'Показать встроенный' }).count()) === 0,
    'у неправленого промпта кнопки «Показать встроенный» нет',
    'кнопка показана там, где рабочий текст и есть встроенный',
  );

  expect(!consoleErrors.length, 'ошибок в консоли нет', consoleErrors.slice(0, 2).join(' | '));
  await finish(page);
}

// 2. Сброс спрашивает, и отказ от вопроса ничего не стирает.
{
  const { page, calls } = await open();
  await openPrompt(page, 'image');

  await page.getByRole('button', { name: 'Сбросить к встроенному' }).click();
  await page.waitForTimeout(400);

  const dialog = page.getByRole('dialog');
  const asked = (await dialog.count()) === 1;
  expect(asked, 'сброс спрашивает подтверждение', 'диалога нет');
  // Без вопроса правка уже стёрта — проверять «отказ от вопроса» нечем, и
  // отдельная строка ниже скажет об этом прямо.
  expect(
    !calls.some((call) => call.startsWith('DELETE')),
    'до ответа человека DELETE не уходит',
    calls.join(', '),
  );

  if (asked) {
    const dialogText = await dialog.innerText();
    expect(
      dialogText.includes('Истории правок у промптов нет'),
      'диалог называет цену: истории правок нет',
      dialogText.slice(0, 160),
    );
    await page.screenshot({ path: join(OUT_DIR, 'reset-confirm.png'), fullPage: true });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    expect(
      !calls.some((call) => call.startsWith('DELETE')),
      'отказ от вопроса не отправляет DELETE',
      calls.join(', '),
    );

    await page.getByRole('button', { name: 'Сбросить к встроенному' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('dialog').getByRole('button', { name: 'Сбросить к встроенному' }).click();
    await page.waitForTimeout(700);
    expect(
      calls.some((call) => call === 'DELETE image'),
      'подтверждённый сброс отправляет DELETE',
      calls.join(', '),
    );
  }
  await finish(page);
}

// 3. Отказ маршрута виден человеку, а не консоли.
{
  const { page } = await open({ failSave: true });
  await openPrompt(page, 'image');

  const field = page.locator('#prompt-editor textarea').first();
  await field.fill(`${MINE} и ещё абзац`);
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForTimeout(700);

  const alerts = await page.locator('#prompt-editor [role="alert"]').allInnerTexts();
  expect(
    alerts.some((text) => text.includes('Промпт длиннее 64 КБ')),
    'отказ сохранения показан дословно',
    alerts.join(' | ') || 'на экране нет ни одного сообщения',
  );
  await page.screenshot({ path: join(OUT_DIR, 'save-refused.png'), fullPage: true });
  await finish(page);
}

await browser.close();

if (problems.length) {
  console.log(`\nПроблемы (${problems.length}):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log('\nКарточка промптов: все проверки прошли.');
