/**
 * Сценарий раздела «Свой эндпоинт»: `endpoints/local`.
 *
 * Вход один: модель своя — локальная, корпоративный шлюз или прокси, — и
 * человеку нужно, чтобы CLI пошли туда, а не в облако вендора. Профиль
 * заводится один раз, а раздаётся кнопкой; всё остальное в сценарии — ответ на
 * вопрос «кто его примет и почему остальные нет».
 *
 * Проверка связи настоящая: на петле поднят выдуманный верх, который отвечает
 * списком из трёх моделей. Поэтому «связь есть, моделей: 3» в кадре — то, что
 * панель посчитала сама, а поле «модель» после проверки превращается в список с
 * именами С ЭТОГО адреса.
 */
import { openSettingsTab, card, shotCard, bringIntoView } from './access-providers-fixture.mjs';
import { shotLanguage } from './kit.mjs';

/** Блок «куда применить» вместе с подписью: своей карточки у него нет. */
const TARGETS =
  'xpath=//*[normalize-space(text())="Куда применить" or normalize-space(text())="Apply to"]/parent::*';

/**
 * Название вида API «OpenAI-совместимый» переведено, а «Anthropic» — нет
 * (имя собственное): значение для `selectOption` берём по языку прогона, раз
 * само API `selectOption({ label })` регулярку не принимает.
 */
const OPENAI_COMPAT = shotLanguage() === 'en' ? 'OpenAI-compatible' : 'OpenAI-совместимый';

/** Токен собирается из кусков: строка вида ключа не должна лежать в файле. */
const FAKE_TOKEN = ['gw', 'qa', '9b41e07c2d5a'].join('_');

export async function shootLocal(browser, web, scenario, { panel, upstream }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1900 } });

  try {
    // Начинаем с чистого листа: профилей нет, ассистент ходит как раньше.
    await patch(panel, { endpointProfiles: [], assistantEndpointId: '' });

    const box = card('Свой эндпоинт');

    // ── 01. Профилей ещё нет ─────────────────────────────────────────────────
    await openSettingsTab(page, web, 'models', 3000);
    await shotCard(scenario, page, '01-empty', box);

    // ── 02. Профиль ──────────────────────────────────────────────────────────
    // Профиль заводится запросом настроек, а не кнопкой карточки: кнопка на
    // момент съёмки не работает (дефект назван в отчёте — пустой адрес нового
    // профиля не проходит проверку настроек, и весь патч отвергается). Поля
    // ниже правятся уже в интерфейсе, как их правит человек.
    await patch(panel, {
      endpointProfiles: [
        {
          id: 'ep-guide-gateway',
          name: 'Профиль 1',
          baseUrl: upstream,
          apiKind: 'openai-compat',
          model: '',
          writeToken: false,
          ownerPlatformId: '',
        },
      ],
    });
    await openSettingsTab(page, web, 'models', 3000);
    await fillUntilSaved(page, box, panel, 'Шлюз отдела');
    // Вид API — не украшение: от него зависит и смысл адреса, и то, какие CLI
    // вообще смогут этот профиль принять.
    await page
      .locator(box)
      .getByLabel(/^(Вид API|API kind)$/)
      .first()
      .selectOption({ label: 'Anthropic' });
    await page.waitForTimeout(1500);
    // Страница перечитывается: список «куда применить» считает сервер, и после
    // смены вида API он обновляется не сразу (дефект назван в отчёте). Кадр со
    // списком, отвечающим за ПРЕДЫДУЩИЙ вид API, показывал бы противоречие.
    await openSettingsTab(page, web, 'models', 3000);
    await shotCard(scenario, page, '02-profile', box);

    // ── 03. Проверка связи ───────────────────────────────────────────────────
    // Спрашивается СПИСОК МОДЕЛЕЙ: он ничего не стоит и отвечает сразу на три
    // вопроса — адрес жив, токен принят, какие имена на нём есть.
    await page
      .locator(box)
      .getByRole('button', { name: /^(Проверить связь|Check connection)$/ })
      .first()
      .click();
    await page.waitForTimeout(4000);
    await shotCard(scenario, page, '03-probe', box);

    // ── 04. Токен эндпоинта ──────────────────────────────────────────────────
    // Значение уходит в зашифрованное хранилище панели; обратно приходит только
    // маска, и в кадре она закрыта ещё раз.
    await page.locator(box).locator('input[type="password"]').first().fill(FAKE_TOKEN);
    await page.waitForTimeout(400);
    await page
      .locator(box)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '04-token', box);

    // ── 05. Тот же адрес, другой вид API ─────────────────────────────────────
    // Список «куда применить» считает не справка, а панель, и считает она его
    // ОТ ВИДА API: тот же адрес при `OpenAI-совместимый` принимают уже другие
    // CLI, а Claude Code отвечает «работает с API другого вида». Кадр нужен
    // именно парой к предыдущему — иначе список читается как свойство адреса.
    await page
      .locator(box)
      .getByLabel(/^(Вид API|API kind)$/)
      .first()
      .selectOption({ label: OPENAI_COMPAT });
    await page.waitForTimeout(1500);
    await openSettingsTab(page, web, 'models', 3000);
    await bringIntoView(page, TARGETS);
    await shotCard(scenario, page, '05-targets', TARGETS);

    // Возвращаем вид API профиля: дальше он применяется к Claude Code.
    await page
      .locator(box)
      .getByLabel(/^(Вид API|API kind)$/)
      .first()
      .selectOption({ label: 'Anthropic' });
    await page.waitForTimeout(1500);
    await openSettingsTab(page, web, 'models', 3000);

    // ── 06. Запись в конфигурацию CLI ────────────────────────────────────────
    // Кадр на всю страницу: сообщение о записи называет путь файла целиком, и
    // обрезанная по карточке область его бы не показала.
    await page
      .locator(targetRow('Claude Code'))
      .getByRole('button', { name: /^(Применить|Apply)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '06-applied');

    // ── 07. Ассистент самой панели ───────────────────────────────────────────
    await page
      .locator(box)
      .getByLabel(/^(Ассистент панели|Panel assistant)$/)
      .first()
      .selectOption({ label: 'Шлюз отдела' });
    await page.waitForTimeout(2000);
    await shotCard(scenario, page, '07-assistant', box);
  } finally {
    await page.close();
  }
}

/** Строка одного CLI в списке «куда применить» — вложенная карточка поменьше. */
const targetRow = (name) =>
  `xpath=//*[normalize-space(text())="${name}"]/ancestor::div[contains(@class,"padding-sm")][1]`;

/**
 * Название профиля — в поле, и ждать, пока сервер его запомнит. Каждая правка поля шлёт
 * весь список профилей из кэша страницы, а кэш обновляется только ответом: под нагрузкой
 * правка настроек отвечает дольше паузы, следующая правка (вид API) уходила со старым
 * именем и затирала новое — профиль оставался «Профиль 1», и шаг 07 падал на выборе
 * «Шлюз отдела» (03.11.2026). Не запомнил за 6 с — поле заполняется ещё раз.
 */
async function fillUntilSaved(page, box, panel, name) {
  const field = page
    .locator(box)
    .getByLabel(/^(Название|Name)$/)
    .first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await field.fill(name);
    for (let wait = 0; wait < 30; wait += 1) {
      await page.waitForTimeout(200);
      const settings = await fetch(`${panel}/api/settings`).then((res) => res.json());
      if (settings.endpointProfiles?.some((item) => item.name === name)) return;
    }
  }
  throw new Error(`название профиля «${name}» сервер так и не запомнил`);
}

async function patch(panel, body) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings: ${response.status}`);
}
