/**
 * Ответ ядру кнопками из Telegram (этап 12, D29, P187–P190): НАСТОЯЩЕЕ ядро стенда с открытым
 * вопросом запуска, НАСТОЯЩИЙ сервер панели, заглушка Bot API на свободном порту
 * (`AGENTDECK_TELEGRAM_API`). Подменена только сеть Telegram.
 *
 * Что проверяется:
 * 1. Привязки нет — сервер называет отпечаток чата бота ответов, ядро его владельцем не числит;
 *    вопрос приходит текстом со ссылкой, кнопок у вопроса ядра нет.
 * 2. Привязка — НАСТОЯЩИЙ переключатель «Отвечать ядру из Telegram» на карточке Telegram (браузер,
 *    число страницы окна → `set-config` `telegram.owner`); после неё сервер видит `bound`.
 * 2б. Поле «Репозитории для задач из Telegram»: девять строк — отказ, сохранить нельзя; две —
 *    `telegram.repos` в настройке ядра, владелец не тронут.
 * 3. Вопрос приходит ОДНИМ сообщением с кнопками и ссылкой «Открыть задачу →» на вопрос ядра;
 *    «Правка деления» (экран панели) не показана.
 * 4. Нажатие чужого `from.id` ничего не меняет — вопрос в виде задачи открыт.
 * 5. Нажатие владельца «Отменить задачу» — ядро отменяет задачу (команда `cancel` пришла каналом
 *    Telegram и прошла суд области), сообщение закрыто итогом; повтор — «Уже отвечено».
 * 6. Переключатель выключен — `telegram.owner` в настройке ядра `null`, сервер видит `unbound`;
 *    репозитории `/task` выключение не стирает.
 *
 * Вопрос в журнале — кодом ядра до его старта (`core-ask-seed.mjs`). Сеть не нужна.
 * Запуск: `node tools/qa/check-telegram-core.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { startBotStub } from './telegram-bot-stub.mjs';

const { writeToken } = await import('../../apps/server/src/domains/integrations/store/store.ts');
const SHOTS = join(REPO, '.agent/screenshots/before-after/core-s12-z16');

const OWNER = 424245;
const STRANGER = 999001;
const TOKEN = '7000005:QA_core_buttons_secret_ABCDEFGH';
const TITLE = 'Кнопки вопроса ядра';
const REPOS = [
  { path: 'C:/work/demo-app', baseRef: 'main' },
  { path: 'C:/work/demo-lib', baseRef: null },
];

const tgStub = await startBotStub({
  botId: 7000005,
  username: 'qa_core_buttons_bot',
  tokens: [TOKEN],
  owner: OWNER,
  firstMessageId: 1200,
});
const { bot } = tgStub;

const sent = () => bot.calls.filter((call) => call.method === 'sendMessage');
const keyboardOf = (call) => (call?.body?.reply_markup?.inline_keyboard ?? []).flat();
const withButtons = () =>
  sent().filter(
    (call) => String(call.body.text).includes('Launch the task?') && keyboardOf(call).length,
  );
const textAsks = () => sent().filter((call) => String(call.body.text).includes('Ядро ждёт ответа'));
const toasts = () =>
  bot.calls
    .filter((call) => call.method === 'answerCallbackQuery')
    .map((c) => String(c.body.text ?? ''));
/** Текст, как его отдаёт Telegram в нажатии: HTML снят, сущности раскрыты. */
const plain = (html) =>
  String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

async function until(probe, ms = 30_000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

/** Нажатие, как его шлёт Telegram: показанные текст и клавиатура сообщения внутри. */
function pressButton(call, button, from) {
  const id = `cb-${bot.nextUpdateId}`;
  tgStub.push({
    update_id: bot.nextUpdateId++,
    callback_query: {
      id,
      from: { id: from, is_bot: false, first_name: 'Q' },
      data: button.callback_data,
      message: {
        message_id: call.messageId,
        chat: { id: OWNER, type: 'private' },
        text: plain(call.body.text),
        reply_markup: call.body.reply_markup,
      },
    },
  });
  return id;
}

let seeded;
try {
  await runOnStand(
    {
      label: 'telegram-core',
      core: true,
      web: true,
      env: {
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgStub.port}`,
        AGENTDECK_TELEGRAM_SEND_GRACE_MS: '0',
      },
      settings: {
        integrations: {
          telegram: { enabled: true, chatId: String(OWNER), events: ['question'] },
        },
      },
      seed: ({ cfg, coreHome }) => {
        const out = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            '--no-warnings',
            join(REPO, 'tools/qa/core-ask-seed.mjs'),
            coreHome,
            TITLE,
          ],
          { encoding: 'utf8' },
        );
        if (out.status !== 0) throw new Error(`seed failed: ${out.stderr}`);
        seeded = JSON.parse(out.stdout.trim().split('\n').at(-1));
        writeToken(join(cfg, 'agentdeck'), 'telegram', TOKEN);
      },
    },
    async (stand, check) => {
      const { taskId, askId } = seeded;
      const answers = await stand.api('/integrations/telegram/answers', {
        method: 'PUT',
        body: { enabled: true, afterMinutes: 0, ownerId: String(OWNER), token: TOKEN },
      });
      check('ответы из Telegram включены', answers.status === 200, answers.text.slice(0, 300));

      // ── 1. без привязки: текст, кнопок нет ───────────────────────────────────────────────
      const unbound = await until(async () => {
        const got = await stand.api('/integrations/telegram/answers/core-binding');
        return got.body?.reachable ? got.body : null;
      });
      check(
        'привязки нет: отпечаток чата назван, ядро читается, bound=false',
        /^[0-9a-f]{64}$/.test(unbound?.fingerprint ?? '') && unbound?.bound === false,
        JSON.stringify(unbound),
      );
      const text = await until(() => textAsks()[0]);
      check(
        'вопрос ядра пришёл текстом со ссылкой на задачу, без кнопок',
        Boolean(text) &&
          String(text.body.text).includes(`/core?id=${taskId}`) &&
          !text.body.reply_markup,
        JSON.stringify(sent().slice(-3)),
      );
      await wait(6_000);
      check('без привязки сообщения с кнопками нет', withButtons().length === 0);

      // ── 2. привязка: переключатель карточки в браузере ─────────────────────────────────────
      const browser = await chromium.launch();
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/settings?tab=integrations`);
      const block = page.locator('[data-telegram-core-binding]');
      const shownUnbound = await block
        .and(page.locator('[data-telegram-core-binding="unbound"]'))
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      check(
        'карточка Telegram показывает переключатель «Отвечать ядру из Telegram» выключенным',
        shownUnbound,
        await block.getAttribute('data-telegram-core-binding').catch(() => 'нет блока'),
      );
      await block.getByRole('switch').click();
      const shownBound = await page
        .locator('[data-telegram-core-binding="bound"]')
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check('после нажатия переключатель включён (ядро узнаёт чат)', shownBound);
      mkdirSync(SHOTS, { recursive: true });
      await block.screenshot({ path: join(SHOTS, 'telegram-core-binding_AFTER.png') });
      const bound = await until(async () => {
        const got = await stand.api('/integrations/telegram/answers/core-binding');
        return got.body?.bound ? got.body : null;
      });
      check('после записи сервер видит bound=true', Boolean(bound), JSON.stringify(bound));
      const ownerSet = await stand.api('/core/config');
      check(
        'в настройке ядра telegram.owner — отпечаток чата бота',
        ownerSet.body?.doc?.telegram?.owner === unbound?.fingerprint,
        JSON.stringify(ownerSet.body?.doc?.telegram ?? null),
      );

      // ── 2б. поле «Репозитории для задач из Telegram» (W2-D F2) ────────────────────────────
      const reposField = block.getByLabel('Репозитории для задач из Telegram');
      const reposSave = block.getByRole('button', { name: 'Сохранить репозитории' });
      await reposField.fill(Array.from({ length: 9 }, (_, i) => `C:/work/r${i}`).join('\n'));
      check(
        'девять репозиториев — отказ «Не больше 8», сохранить нельзя',
        (await block.getByText('Не больше 8 репозиториев.').isVisible()) &&
          (await reposSave.isDisabled()),
      );
      await reposField.fill(
        REPOS.map((r) => (r.baseRef ? `${r.path} @ ${r.baseRef}` : r.path)).join('\n'),
      );
      await reposSave.click();
      const reposSet = await until(async () => {
        const got = await stand.api('/core/config');
        return got.body?.doc?.telegram?.repos ? got.body.doc.telegram : null;
      }, 20_000);
      check(
        'поле сохранено: telegram.repos в настройке ядра, владелец не тронут',
        JSON.stringify(reposSet?.repos) === JSON.stringify(REPOS) &&
          reposSet?.owner === unbound?.fingerprint,
        JSON.stringify(reposSet),
      );

      // ── 3. одно сообщение с кнопками ──────────────────────────────────────────────────────
      const card = await until(() => withButtons()[0], 40_000);
      const labels = keyboardOf(card).map((button) => button.text);
      check(
        'вопрос пришёл сообщением с кнопками, «Правки деления» нет',
        labels.some((label) => label.includes('Отменить задачу')) &&
          !labels.some((label) => label.includes('edit-split')),
        JSON.stringify(labels),
      );
      // Ссылка на задачу ядра — та же, что у текстового запасного пути (W2-D F2).
      check(
        'сообщение с кнопками ведёт на задачу ядра и её вопрос («Открыть задачу →»)',
        String(card?.body?.text ?? '').includes(`/core?id=${taskId}&amp;ask=${askId}`) &&
          String(card?.body?.text ?? '').includes('Открыть задачу'),
        String(card?.body?.text ?? '').slice(-200),
      );
      await wait(11_000);
      check('сообщение с кнопками одно (сверки не плодят копии)', withButtons().length === 1);

      // ── 4. чужое нажатие ──────────────────────────────────────────────────────────────────
      const cancel = keyboardOf(card).find((button) => button.text.includes('Отменить задачу'));
      if (!card || !cancel) throw new Error('кнопки «Отменить задачу» нет — нажимать нечего');
      pressButton(card, cancel, STRANGER);
      await wait(4_000);
      const still = await stand.api(`/core/tasks/${taskId}`);
      const openAsk = still.body?.view?.asks?.find((one) => one.askId === askId);
      check(
        'нажатие чужого from.id ничего не меняет',
        openAsk?.state === 'open',
        JSON.stringify(openAsk),
      );

      // ── 5. нажатие владельца → отмена задачи ядром ────────────────────────────────────────
      pressButton(card, cancel, OWNER);
      const done = await until(async () => {
        const got = await stand.api(`/core/tasks/${taskId}`);
        const ask = got.body?.view?.asks?.find((one) => one.askId === askId);
        return ask && ask.state !== 'open' ? got.body : null;
      });
      check(
        'владелец нажал «Отменить задачу» — вопрос закрыт ядром',
        Boolean(done),
        JSON.stringify(done?.view?.asks ?? null).slice(0, 400),
      );
      // Тост уходит после ответа ядра — ждём его, а не берём снимок.
      await until(() => toasts().includes('Принято'), 10_000);
      check('тост нажатия — «Принято»', toasts().includes('Принято'), JSON.stringify(toasts()));
      const edited = await until(() =>
        bot.calls.find(
          (call) => call.method === 'editMessageText' && call.body.message_id === card.messageId,
        ),
      );
      check(
        'сообщение закрыто итогом, кнопок нет',
        Boolean(edited) && keyboardOf(edited).length === 0,
        JSON.stringify(edited?.body ?? null).slice(0, 300),
      );
      pressButton(card, cancel, OWNER);
      await until(() => toasts().includes('Уже отвечено'), 10_000);
      check(
        'повтор нажатия — «Уже отвечено»',
        toasts().includes('Уже отвечено'),
        JSON.stringify(toasts()),
      );

      // ── 6. выключение переключателем ──────────────────────────────────────────────────────
      await block.getByRole('switch').click();
      const shownOff = await page
        .locator('[data-telegram-core-binding="unbound"]')
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const ownerOff = await stand.api('/core/config');
      check(
        'выключение — telegram.owner в настройке ядра null, переключатель выключен; репозитории целы',
        shownOff &&
          ownerOff.body?.doc?.telegram?.owner === null &&
          JSON.stringify(ownerOff.body?.doc?.telegram?.repos) === JSON.stringify(REPOS),
        JSON.stringify(ownerOff.body?.doc?.telegram ?? null),
      );
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join(' | '));
      await browser.close();
    },
  );
} finally {
  await tgStub.close();
}
