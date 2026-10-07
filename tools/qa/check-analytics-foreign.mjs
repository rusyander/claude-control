/**
 * Аналитика за Codex и Qwen Code (пункт 7 «Цели», 06.10.2026) — на настоящем
 * сервере и настоящем фронте.
 *
 * Своя одноразовая панель: в её домашнем каталоге лежат `~/.codex/sessions` и
 * `~/.qwen/projects/…/chats` в формах, которые написали настоящие codex 0.160 и
 * qwen 0.25.0 (числа подобраны так, чтобы ошибка была видна), и транскрипт
 * Claude с другой суммой — чтобы отчёт одного CLI нельзя было спутать с другим.
 *
 * 1. Активен Codex — `/api/analytics` отдаёт `providerId: codex`, вход без кэша,
 *    кэш отдельно, дубль `token_count` не удвоен, модель без цены названа.
 * 2. Страница подписывает отчёт как сессии Codex и называет модель без цены;
 *    заметки о лимитах подписки Claude на «Сессиях» нет.
 * 3. Смена CLI в «Настройки → Провайдеры» и возврат на «Аналитику» без
 *    перезагрузки — на экране отчёт Qwen, а не минутный кэш отчёта Codex.
 * 4. Возврат на Claude — отчёт по транскриптам Claude, без подписи.
 * 5. Активен Goose (SF-4: журналы его аналитика не читает) — `/api/analytics` и
 *    `/api/analytics/live` отвечают 409 `analytics-provider-unsupported` с именем
 *    CLI, сумма Claude не появляется ни в одном ответе; страница вместо отчёта
 *    показывает заглушку, ни проекта, ни модели Claude на ней нет. Телефон ходит
 *    в тот же маршрут с тем же токеном — отказ сервера и есть его гейт.
 *
 * Обязан краснеть: со старым маршрутом (отказ убран) шаг 5 видит сумму Claude.
 *
 * Ни настоящий `~/.claude`, ни `~/.codex`, ни `~/.qwen`, ни стенд человека не
 * трогаются. Запуск: `node tools/qa/check-analytics-foreign.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

// Свои дома CLI человека увели бы панель читать настоящие сессии.
delete process.env.CODEX_HOME;
delete process.env.QWEN_HOME;

const SHOTS = '.agent/screenshots/analytics-foreign';
mkdirSync(SHOTS, { recursive: true });

const ts = new Date(Date.now() - 30 * 60_000).toISOString();
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const put = (path, rows) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, jsonl(rows));
};

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const CODEX_SESSION = '01a111ce-08b0-7a12-822a-7abdc4874e3e';
const codexRows = [
  {
    timestamp: ts,
    type: 'session_meta',
    payload: {
      id: CODEX_SESSION,
      session_id: CODEX_SESSION,
      cwd: 'C:\\qa\\codex-demo',
      cli_version: '0.160.0',
    },
  },
  { timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', model: 'qa-codex-model' } },
  {
    timestamp: ts,
    type: 'token_usage_record',
    payload: {
      session_id: CODEX_SESSION,
      turn_id: 't1',
      response_id: 'resp_1',
      usage: usage(1000, 600, 50),
    },
  },
  {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: usage(1000, 600, 50) } },
  },
  {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{}' },
  },
];

const QWEN_SESSION = '8dd3f850-8dba-40e6-9d7b-7de2cd2057e8';
const qwenBase = (type) => ({
  uuid: `${type}-${Math.random()}`,
  sessionId: QWEN_SESSION,
  timestamp: ts,
  type,
  cwd: 'C:\\qa\\qwen-demo',
  version: '0.25.0',
});
const qwenRows = [
  { ...qwenBase('user'), message: { role: 'user', parts: [{ text: 'привет' }] } },
  {
    ...qwenBase('system'),
    subtype: 'ui_telemetry',
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: 'c1',
        model: 'qa-qwen-model',
        input_token_count: 3000,
        output_token_count: 70,
        cached_content_token_count: 1000,
        thoughts_token_count: 0,
      },
    },
  },
  {
    ...qwenBase('assistant'),
    model: 'qa-qwen-model',
    message: { role: 'model', parts: [{ text: 'готово' }] },
    usageMetadata: {
      promptTokenCount: 3000,
      candidatesTokenCount: 70,
      cachedContentTokenCount: 1000,
    },
  },
];

// Сумма Claude нарочно редкая: её появление где угодно под чужим CLI — улика.
const CLAUDE_INPUT = 7_391_457;
const claudeRows = [
  {
    type: 'user',
    timestamp: ts,
    cwd: 'C:\\qa\\claude-demo',
    sessionId: 'qa-claude',
    message: { role: 'user', content: 'hi' },
  },
  {
    type: 'assistant',
    timestamp: ts,
    cwd: 'C:\\qa\\claude-demo',
    sessionId: 'qa-claude',
    requestId: 'req-1',
    message: {
      id: 'msg-1',
      model: 'claude-sonnet-5',
      usage: { input_tokens: CLAUDE_INPUT, output_tokens: 3 },
    },
  },
];

const report = async (stand) => (await stand.api('/analytics?days=30&refresh=true')).body;

await runOnStand(
  {
    label: 'analytics-foreign',
    settings: { provider: 'codex' },
    seed: ({ home, cfg }) => {
      put(
        join(
          home,
          '.codex',
          'sessions',
          '2026',
          '10',
          '06',
          `rollout-2026-10-06T20-21-17-${CODEX_SESSION}.jsonl`,
        ),
        codexRows,
      );
      put(
        join(home, '.qwen', 'projects', 'c--qa-qwen-demo', 'chats', `${QWEN_SESSION}.jsonl`),
        qwenRows,
      );
      put(join(cfg, 'projects', 'C--qa-claude-demo', 'qa-claude.jsonl'), claudeRows);
    },
  },
  async (stand, check) => {
    // 1. Ответ сервера за Codex.
    const codex = await report(stand);
    check(
      'отчёт помечен как Codex',
      codex?.providerId === 'codex',
      JSON.stringify(codex?.providerId),
    );
    check(
      'вход без кэша, кэш отдельно, дубль token_count не удвоен',
      codex?.overall?.input === 400 &&
        codex?.overall?.cacheRead === 600 &&
        codex?.overall?.requests === 1,
      JSON.stringify(codex?.overall),
    );
    check(
      'модель без цены названа',
      JSON.stringify(codex?.unpricedModels) === '["qa-codex-model"]',
      JSON.stringify(codex?.unpricedModels),
    );
    check(
      'вызов инструмента учтён',
      codex?.topTools?.[0]?.name === 'shell',
      JSON.stringify(codex?.topTools),
    );
    check(
      'скиллы Claude в отчёт Codex не попали',
      Array.isArray(codex?.topSkills) && codex.topSkills.length === 0,
    );

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const note = page.getByTestId('analytics-source-note');

      // 2. Страница за Codex.
      await page.goto(`${stand.webUrl}/analytics?tab=overview`);
      await note.waitFor({ timeout: 30_000 });
      const codexText = (await note.innerText()).replace(/\s+/g, ' ');
      check('страница подписывает отчёт как сессии Codex', /Codex/.test(codexText), codexText);
      check('и называет модель без цены', codexText.includes('qa-codex-model'), codexText);
      await page.screenshot({ path: join(SHOTS, 'codex.png'), fullPage: true });

      await page.goto(`${stand.webUrl}/analytics?tab=sessions`);
      await page
        .getByText(CODEX_SESSION.slice(0, 8))
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined);
      check(
        'на «Сессиях» Codex нет заметки о лимитах подписки Claude',
        (await page.getByText('Про лимиты подписки').count()) === 0,
      );

      // 3. Смена CLI в самом приложении, без перезагрузки страницы.
      await page.goto(`${stand.webUrl}/analytics?tab=overview`);
      await note.waitFor({ timeout: 30_000 });
      await page.getByRole('link', { name: 'Настройки', exact: true }).first().click();
      await page.getByRole('tab', { name: 'Провайдеры' }).click();
      const qwenCard = page
        .locator('div')
        .filter({ has: page.getByText('Qwen Code', { exact: true }) })
        .filter({ has: page.getByRole('button', { name: 'Выбрать' }) })
        .last();
      await qwenCard.getByRole('button', { name: 'Выбрать' }).click();
      await wait(1_500);
      await page.getByRole('link', { name: 'Аналитика', exact: true }).first().click();
      await wait(4_000);
      const qwenText = (await note.innerText().catch(() => '')).replace(/\s+/g, ' ');
      check(
        'после смены CLI — отчёт Qwen, не кэш Codex',
        /Qwen/.test(qwenText) && !/Codex/.test(qwenText),
        qwenText,
      );
      check(
        'модель без цены — уже своя',
        qwenText.includes('qa-qwen-model') && !qwenText.includes('qa-codex-model'),
        qwenText,
      );
      await page.screenshot({ path: join(SHOTS, 'qwen.png'), fullPage: true });

      const qwen = await report(stand);
      check(
        'Qwen: телеметрия один раз, usageMetadata того же ответа не удвоила',
        qwen?.providerId === 'qwen' &&
          qwen?.overall?.input === 2000 &&
          qwen?.overall?.cacheRead === 1000 &&
          qwen?.overall?.requests === 1,
        JSON.stringify(qwen?.overall),
      );
    } finally {
      await browser.close();
    }

    // 4. Назад на Claude.
    const back = await stand.api('/settings', { method: 'PATCH', body: { provider: 'claude' } });
    check('провайдер вернулся на Claude', back.status === 200, back.text.slice(0, 200));
    const claude = await report(stand);
    check(
      'отчёт Claude — по транскриптам Claude, без пометки CLI',
      claude?.providerId === undefined &&
        claude?.overall?.input === CLAUDE_INPUT &&
        claude?.overall?.requests === 1,
      JSON.stringify({ providerId: claude?.providerId, overall: claude?.overall }),
    );

    // 5. Goose: аналитика его журналов не читает — честный отказ, не отчёт Claude.
    const toGoose = await stand.api('/settings', { method: 'PATCH', body: { provider: 'goose' } });
    check('провайдер переключён на Goose', toGoose.status === 200, toGoose.text.slice(0, 200));
    const refused = await stand.api('/analytics?days=30&refresh=true');
    check(
      'Goose: /api/analytics — 409 analytics-provider-unsupported с именем CLI',
      refused.status === 409 &&
        refused.body?.messageCode === 'analytics-provider-unsupported' &&
        refused.body?.params?.provider === 'Goose',
      `${refused.status} ${refused.text.slice(0, 300)}`,
    );
    const live = await stand.api('/analytics/live');
    check(
      'Goose: /api/analytics/live — тот же отказ, процессов claude нет',
      live.status === 409 && live.body?.messageCode === 'analytics-provider-unsupported',
      `${live.status} ${live.text.slice(0, 300)}`,
    );
    const leaked = [refused.text, live.text].filter(
      (text) => text.includes(String(CLAUDE_INPUT)) || text.includes('claude-sonnet-5'),
    );
    check('сумма и модель Claude не появились ни в одном ответе', leaked.length === 0, leaked[0]);

    const gooseBrowser = await chromium.launch();
    try {
      const page = await gooseBrowser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${stand.webUrl}/analytics?tab=overview`);
      await page.getByText('Раздел недоступен для «Goose»').waitFor({ timeout: 30_000 });
      const text = await page.locator('body').innerText();
      check(
        'страница Goose — заглушка, без проекта и модели Claude',
        !text.includes('claude-demo') && !text.includes('claude-sonnet-5'),
        text.slice(0, 300),
      );
      await page.screenshot({ path: join(SHOTS, 'goose.png'), fullPage: true });
    } finally {
      await gooseBrowser.close();
    }
  },
);
