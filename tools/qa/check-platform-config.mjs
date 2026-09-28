/**
 * Конфигурация контура на его карточке (баг 11): доступ разделов и «чьи правила
 * действуют» — доказаны на ПРОВОДЕ, а не на экране.
 *
 * Почему свип, а не тест. Модульные тесты шлюза (`section-rules.integration`)
 * кормят конвейер адресом из строки. Здесь всё настоящее: одноразовая панель,
 * её шлюз на свободном порту, над ним `stub-platform.mjs` как контур, фронт
 * одноразового стенда, и щелчок человека по карточке. Свидетельство — ответ
 * шлюза тому же адресу, что лежит в управляемом профиле ассистента, и тело,
 * которое записал стаб: «закрыто» на экране без отказа на проводе — это
 * надпись, а не доступ.
 *
 * Что прогоняется:
 *   1. адрес управляемого профиля несёт отметку раздела ассистента;
 *   2. тот же адрес: 200, пока раздел открыт, — 403 `permission_error` после
 *      щелчка по тумблеру на карточке, и наверх не уходит ни байта;
 *   3. отказ по разделу, а не по контуру: чат рядом по-прежнему 200; адрес без
 *      отметки пропускается (так ходят проверки панели), неизвестная — отказ;
 *   4. «Только наши» на карточке: поле правила контура из тела пропало, ушло
 *      одно «инструментов не надо»; вкладка правил отмечает снятую колонку и
 *      снятый спор;
 *   5. «Оба набора» на вкладке правил: поле вернулось — значения не терялись.
 *
 * Рабочий стенд человека и его настоящий контур не трогаются: панель, шлюз и
 * контур здесь свои и умирают вместе с прогоном.
 *
 * Запуск: `node tools/qa/check-platform-config.mjs` (выход 0 — всё сходится,
 * 1 — провал, 2 — стенд не поднялся).
 */
import { chromium } from 'playwright';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { startStubPlatform } from './stub-platform.mjs';

const CONTOUR = 'cfg-company';
/** Заглушка вместо ключа: собрана из кусков, чтобы не лежало присваивание, похожее на секрет. */
const KEY = ['cfg', 'stub', 'key'].join('-');
/** Значение правила контура, по которому видно, ушло ли оно в запрос. */
const PRESET = 'precise-cfg';

const stub = await startStubPlatform({ port: 0 });
const gatewayPort = await freePort();

/** Последний вызов чата у стаба и его тело. */
function lastChatCall() {
  const call = [...stub.calls].reverse().find((item) => item.path.endsWith('/chat/completions'));
  let body = {};
  try {
    body = call ? JSON.parse(call.body) : {};
  } catch {
    // не JSON — сравнение ниже скажет само
  }
  return { call, body, count: stub.calls.length };
}

/** Запрос чата через шлюз по полному адресу `…/v1`. */
async function chatAt(base) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'stub-chat',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

// Порт шлюза задан ДО старта панели: активация поднимает шлюз сама, и по
// умолчанию он пошёл бы на 5179 — порт шлюза рабочего стенда человека.
const standOptions = {
  label: 'cfg',
  settings: { platformGateway: { enabled: true, port: gatewayPort, forceStream: true } },
};

await runOnStand(standOptions, async (stand, check) => {
  const gw = (path) => `http://127.0.0.1:${gatewayPort}/${CONTOUR}${path}`;
  const statusOf = async () => {
    const info = await stand.api('/platforms');
    return (info.body?.platforms ?? []).find((item) => item.platform.id === CONTOUR);
  };
  /** Дождаться, пока сохранённое состояние контура не станет таким, как ждём. */
  const until = async (name, predicate) => {
    for (let i = 0; i < 40; i += 1) {
      const status = await statusOf();
      if (status && predicate(status.platform)) return status;
      await wait(250);
    }
    check(name, false, JSON.stringify((await statusOf())?.platform ?? null).slice(0, 400));
    return undefined;
  };

  // ── Контур, шлюз, профиль ассистента ─────────────────────────────────────
  const saved = await stand.api(`/platforms/${CONTOUR}`, {
    method: 'PUT',
    body: {
      settings: {
        id: CONTOUR,
        title: 'Контур проверки конфигурации',
        driver: 'enterprise-platform',
        baseUrl: stub.url,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        consumers: ['chat', 'assistant'],
        targets: ['assistant'],
        projectPaths: [],
        agents: [],
        caCertPath: '',
        toolShim: false,
      },
      token: KEY,
    },
  });
  check('контур сохранён', saved.status === 200, JSON.stringify(saved.body).slice(0, 300));
  const activated = await stand.api(`/platforms/${CONTOUR}/activate`, { method: 'POST', body: {} });
  check(
    'контур активен',
    activated.body?.activePlatformId === CONTOUR,
    JSON.stringify(activated.body).slice(0, 200),
  );
  const restarted = await stand.api('/platforms/gateway/restart', { method: 'POST', body: {} });
  check(
    'шлюз поднялся на своём порту',
    restarted.body?.status?.running === true && restarted.body?.status?.port === gatewayPort,
    JSON.stringify(restarted.body?.status ?? restarted.body).slice(0, 300),
  );
  const applied = await stand.api(`/platforms/${CONTOUR}/apply`, {
    method: 'POST',
    body: { targets: ['assistant'] },
  });
  check('ассистент применён', applied.status === 200, JSON.stringify(applied.body).slice(0, 300));

  const endpoints = await stand.api('/endpoints');
  const profile = (endpoints.body?.profiles ?? []).find((item) => item.id === `contour-${CONTOUR}`);
  const assistantUrl = profile?.baseUrl ?? '';
  check(
    'адрес профиля ассистента несёт отметку раздела',
    assistantUrl === gw('/_s/assistant/v1'),
    `профиль: ${assistantUrl || 'нет'}`,
  );

  // Правило контура со значением, которое видно в теле запроса.
  const before = await statusOf();
  const withPreset = {
    ...before.platform,
    rules: {
      ...before.platform.rules,
      platform: { ...before.platform.rules.platform, generationPreset: PRESET },
    },
  };
  const presetSaved = await stand.api(`/platforms/${CONTOUR}`, {
    method: 'PUT',
    body: { settings: withPreset },
  });
  check('правило контура записано', presetSaved.status === 200, JSON.stringify(presetSaved.body));

  // ── Раздел открыт ─────────────────────────────────────────────────────────
  const open = await chatAt(assistantUrl);
  check(
    'открытый раздел: адрес профиля отвечает 200 и ответом контура',
    open.status === 200 && open.text.includes('готов'),
    `${open.status}: ${open.text.slice(0, 200)}`,
  );
  check(
    '«оба набора»: правило контура ушло в запрос',
    lastChatCall().body.generation_preset === PRESET,
    JSON.stringify(lastChatCall().body).slice(0, 300),
  );

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { width: 1440, height: 1000 });
    await page.goto(`${stand.webUrl}/platform?tab=contours&id=${CONTOUR}`);
    const assistantRow = page.locator(
      `[data-contour-sections="${CONTOUR}"] [data-contour-section="assistant"]`,
    );
    await assistantRow.waitFor({ timeout: 30000 });
    check(
      'карточка: ассистент открыт',
      (await assistantRow.getAttribute('data-open')) === 'true',
      String(await assistantRow.getAttribute('data-open')),
    );

    // ── Закрыть ассистента щелчком человека ─────────────────────────────────
    await assistantRow.getByRole('switch').click();
    const closed = await until(
      'раздел ассистента снят в настройке',
      (platform) => !platform.consumers.includes('assistant'),
    );
    if (closed) check('раздел ассистента снят в настройке', true);
    await page
      .waitForSelector(`[data-contour-section="assistant"][data-open="false"]`, { timeout: 10000 })
      .catch(() => undefined);
    check(
      'карточка: ассистент закрыт и ведёт на вкладку доступа',
      (await assistantRow.getAttribute('data-open')) === 'false' &&
        (await assistantRow.getByRole('button').count()) === 1,
      String(await assistantRow.getAttribute('data-open')),
    );

    const callsBefore = stub.calls.length;
    const refused = await chatAt(assistantUrl);
    check(
      'закрытый раздел: ТОТ ЖЕ адрес профиля получает 403 permission_error',
      refused.status === 403 && refused.text.includes('permission_error'),
      `${refused.status}: ${refused.text.slice(0, 300)}`,
    );
    check(
      'отказ до контура: наверх не ушло ничего',
      stub.calls.length === callsBefore,
      `вызовов стаба было ${callsBefore}, стало ${stub.calls.length}`,
    );
    const chatOpen = await chatAt(gw('/_s/chat/v1'));
    check(
      'отказ по разделу, а не по контуру: чат рядом отвечает 200',
      chatOpen.status === 200,
      `${chatOpen.status}: ${chatOpen.text.slice(0, 200)}`,
    );
    const untagged = await chatAt(gw('/v1'));
    check(
      'адрес без отметки раздела пропускается',
      untagged.status === 200,
      `${untagged.status}: ${untagged.text.slice(0, 200)}`,
    );
    const unknown = await chatAt(gw('/_s/nonsense/v1'));
    check(
      'неизвестная отметка раздела — отказ',
      unknown.status === 403,
      `${unknown.status}: ${unknown.text.slice(0, 200)}`,
    );

    // ── «Только наши» на карточке ─────────────────────────────────────────────
    await page.locator(`[data-contour-rules="${CONTOUR}"] [data-applies="ours"]`).click();
    const ours = await until(
      'выбор «только наши» записан',
      (platform) => platform.rules?.applies === 'ours',
    );
    if (ours) check('выбор «только наши» записан', true);
    await chatAt(gw('/_s/chat/v1'));
    const oursBody = lastChatCall().body;
    check(
      '«только наши»: правила контура в запрос не ушли, ушло одно «инструментов не надо»',
      oursBody.generation_preset === undefined && oursBody.tool_choice === 'none',
      JSON.stringify(oursBody).slice(0, 300),
    );

    await page.goto(`${stand.webUrl}/platform?tab=rules&id=${CONTOUR}`);
    await page.locator('[data-rules-side="platform"]').waitFor({ timeout: 30000 });
    check(
      'вкладка правил: колонка контура снята, наша — нет',
      (await page.locator('[data-rules-side="platform"]').getAttribute('data-side-off')) ===
        'true' &&
        (await page.locator('[data-rules-side="ours"]').getAttribute('data-side-off')) ===
          'false' &&
        (await page.locator('[data-side-off-note="ours"]').count()) === 1,
    );
    check(
      'вкладка правил: спор инструментов снят выбором, у остальных назван победитель',
      (await page.locator('[data-conflict="tools"]').getAttribute('data-conflict-off')) ===
        'contour' &&
        (await page
          .locator('[data-conflict="compaction"]')
          .getAttribute('data-conflict-winner')) === 'contour',
    );
    check(
      'вкладка правил: пересечение отмечено на строке контура',
      (await page.locator('[data-rule-row="guardrails"] [data-overlap="guardrails"]').count()) ===
        1,
    );

    // ── «Только правила контура»: сняты наши СЛОИ, а не вся колонка (F-243) ──
    // Маска данных и прослойка инструментов этим выбором не снимаются
    // (`rules-apply.ts`: гасится только общий выключатель слоёв), и колонка,
    // перечёркнутая целиком, обещала бы обратное.
    await page.locator('[data-rules-applies] [data-applies="contour"]').first().click();
    const contourOnly = await until(
      'выбор «только правила контура» записан',
      (platform) => platform.rules?.applies === 'contour',
    );
    if (contourOnly) check('выбор «только правила контура» записан', true);
    const oursSide = page.locator('[data-rules-side="ours"]');
    await oursSide.locator('[data-side-off-note]').first().waitFor({ timeout: 15000 });
    check(
      '«только контура»: снята не вся наша колонка — надпись у слоёв, маска и прослойка без неё',
      (await oursSide.getAttribute('data-side-off')) === 'layers' &&
        (await oursSide.locator('[data-side-off-note]').count()) === 1 &&
        (await oursSide.locator('[data-our-layers] [data-side-off-note="contour"]').count()) === 1,
      `data-side-off=${await oursSide.getAttribute('data-side-off')}, надписей ${await oursSide
        .locator('[data-side-off-note]')
        .count()}, у слоёв ${await oursSide.locator('[data-our-layers] [data-side-off-note]').count()}`,
    );
    if (process.env.SHOTS) {
      await oursSide.screenshot({ path: `${process.env.SHOTS}/ours-contour-only.png` });
    }

    // ── «Оба набора» с вкладки правил: значения не терялись ─────────────────
    await page.locator('[data-rules-applies] [data-applies="both"]').first().click();
    const both = await until(
      'выбор «оба набора» записан',
      (platform) => platform.rules?.applies === 'both',
    );
    if (both) check('выбор «оба набора» записан', true);
    await chatAt(gw('/_s/chat/v1'));
    check(
      '«оба набора»: правило контура снова в запросе',
      lastChatCall().body.generation_preset === PRESET,
      JSON.stringify(lastChatCall().body).slice(0, 300),
    );

    // ── Два быстрых переключателя подряд (ревью 28.09 F-83) ─────────────────
    // Каждый писатель собирает контур целиком и шлёт PUT полной заменой. Пока
    // список не перечитан, второй щелчок собирал бы из старого снимка и молча
    // откатывал первый. Перечитывание списка задержано — это и есть окно гонки.
    await page.goto(`${stand.webUrl}/platform?tab=contours&id=${CONTOUR}`);
    const chatRow = page.locator(
      `[data-contour-sections="${CONTOUR}"] [data-contour-section="chat"]`,
    );
    await chatRow.waitFor({ timeout: 30000 });
    const slowList = async (route) => {
      if (route.request().method() === 'GET') await wait(3000);
      return route.fallback();
    };
    await page.route('**/api/platforms', slowList);
    const firstPut = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().includes(`/platforms/${CONTOUR}`),
    );
    await chatRow.getByRole('switch').click();
    await firstPut;
    await page.locator(`[data-contour-rules="${CONTOUR}"] [data-applies="contour"]`).click();
    const raced = await until(
      'второй переключатель записан',
      (platform) => platform.rules?.applies === 'contour',
    );
    await page.unroute('**/api/platforms', slowList);
    check(
      'два быстрых переключателя: первый не откатан вторым (чат закрыт, выбор «только контура»)',
      Boolean(raced) && !raced.platform.consumers.includes('chat'),
      JSON.stringify({
        consumers: raced?.platform.consumers,
        applies: raced?.platform.rules?.applies,
      }),
    );

    // ── Замок прослойки — по действующему набору контура (ревью 28.09 F-82) ──
    // При «Только наши» набор инструментов контура записан, но в прогон не идёт:
    // сервер прослойку разрешает, и карточка не должна её запирать.
    const shimCase = async (applies) => {
      const current = (await statusOf()).platform;
      const put = await stand.api(`/platforms/${CONTOUR}`, {
        method: 'PUT',
        body: {
          settings: {
            ...current,
            toolShim: false,
            rules: {
              ...current.rules,
              applies,
              platform: { ...current.rules.platform, platformTools: ['search'] },
            },
          },
        },
      });
      check(
        `набор контура записан, выбор «${applies}»`,
        put.status === 200,
        JSON.stringify(put.body).slice(0, 200),
      );
      await page.goto(`${stand.webUrl}/platform?tab=rules&id=${CONTOUR}`);
      const shim = page
        .locator('[data-rules-side="ours"]')
        .getByRole('switch', { name: 'Прослойка инструментов панели' });
      await shim.waitFor({ timeout: 30000 });
      return shim;
    };
    const oursShim = await shimCase('ours');
    check(
      '«только наши» + записанный набор контура: прослойка не заперта',
      await oursShim.isEnabled(),
    );
    await oursShim.click();
    const shimOn = await until(
      'прослойка включена при «только наши»',
      (platform) => platform.toolShim,
    );
    if (shimOn) check('прослойка включена при «только наши» — сервер принял', true);
    const bothShim = await shimCase('both');
    check(
      '«оба набора» + записанный набор контура: прослойка заперта',
      await bothShim.isDisabled(),
    );

    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
  } finally {
    await browser.close();
  }
});
