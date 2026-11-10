/**
 * Уведомления о задачах ядра в боте ответов (этап 12, P191–P194): НАСТОЯЩЕЕ ядро стенда с
 * законченными задачами в журнале, НАСТОЯЩИЙ сервер панели, заглушка Bot API на свободном порту
 * (`AGENTDECK_TELEGRAM_API`). Подменена только сеть Telegram.
 *
 * Что проверяется:
 * 1. Конец задачи — одно сообщение: MR наружу — кнопкой-ссылкой, MR на loopback — строкой без
 *    кнопки; падение — своим сообщением; следующие проходы не плодят копий.
 * 2. `/status` — строки задач ядра.
 * 3. `/task <текст>` без репозиториев для Telegram — запись во «Входящие» доски ядра (источник
 *    telegram), ответ без «В работу», с подсказкой и ссылкой на доску; то же сообщение второй раз —
 *    ни второй записи, ни второго ответа; чужой `/task` — ничего.
 * 4. Репозитории заданы (`telegram.repos`) — следующая запись несёт их, ответ с «В работу»; нажатие —
 *    ход доски через запускатель ядра; путь нарочно не git-репозиторий — оценка ядра отбивает
 *    запись, под сообщением русская строка «…не git-репозиторий…», без пути и прозы ядра.
 * 5. «На доработку» — подсказка с принудительным ответом; ответ на неё уходит в ядро командой.
 * 6. Нажатие с чужим номером сообщения — «Кнопка устарела», команды нет.
 * 7. Тихие часы сохраняются карточкой; кривое время — отказ схемы.
 *
 * Журнал задач — кодом ядра до его старта (`core-ask-seed.mjs`, `core-notice-seed.mjs`). Сеть не
 * нужна. Запуск: `node tools/qa/check-telegram-notices.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { startBotStub } from './telegram-bot-stub.mjs';

const { writeToken } = await import('../../apps/server/src/domains/integrations/store/store.ts');
const { newId } = await import('../../apps/core/src/lib/ids/uuidv7.ts');

const OWNER = 424250;
const STRANGER = 999002;
const TOKEN = '7000007:QA_core_notices_secret_ABCDEFGH';
const LIVE_TITLE = 'Уведомления: живая задача';

const tgStub = await startBotStub({
  botId: 7000007,
  username: 'qa_core_notices_bot',
  tokens: [TOKEN],
  owner: OWNER,
  firstMessageId: 1500,
});
const { bot, say, press, push } = tgStub;

const sent = () => bot.calls.filter((call) => call.method === 'sendMessage');
const textOf = (call) => String(call?.body?.text ?? '');
const keyboardOf = (call) => (call?.body?.reply_markup?.inline_keyboard ?? []).flat();
const sentWith = (needle) => sent().filter((call) => textOf(call).includes(needle));
const edits = () => bot.calls.filter((call) => call.method === 'editMessageText');
const toasts = () =>
  bot.calls
    .filter((call) => call.method === 'answerCallbackQuery')
    .map((call) => String(call.body.text ?? ''));

async function until(probe, ms = 20_000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

const seedStep = (script, args) => {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(REPO, 'tools/qa', script), ...args],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(`${script}: ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split('\n').at(-1));
};

let seeded;
try {
  await runOnStand(
    {
      label: 'tg-notices',
      core: true,
      web: false,
      // Предполётная проверка носителя доработки ищет CLI маршрута; модель стенду не нужна —
      // фальшивый `claude` называет версию и выходит, ходов он не ведёт.
      fakeCli: {
        claude:
          "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)');\nprocess.exit(0);\n",
      },
      env: {
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_TELEGRAM_API: tgStub.url,
        AGENTDECK_TELEGRAM_SEND_GRACE_MS: '0',
      },
      settings: {
        integrations: {
          telegram: { enabled: true, chatId: String(OWNER), events: ['runError'] },
        },
      },
      seed: ({ cfg, coreHome }) => {
        // Черновик с вопросом запуска: в строки `/status` не попадает (проверка ниже).
        seedStep('core-ask-seed.mjs', [coreHome, LIVE_TITLE]);
        seeded = seedStep('core-notice-seed.mjs', [coreHome, join(cfg, 'agentdeck')]);
        writeToken(join(cfg, 'agentdeck'), 'telegram', TOKEN);
      },
    },
    async (stand, check) => {
      const answers = await stand.api('/integrations/telegram/answers', {
        method: 'PUT',
        body: { enabled: true, afterMinutes: 0, ownerId: String(OWNER), token: TOKEN },
      });
      check('ответы из Telegram включены', answers.status === 200, answers.text.slice(0, 300));

      // ── привязка владельца в ядре (команды кнопок и /task идут каналом владельца) ─────────
      const unbound = await until(async () => {
        const got = await stand.api('/integrations/telegram/answers/core-binding');
        return got.body?.reachable ? got.body : null;
      });
      const config = await stand.api('/core/config');
      const page = newId();
      const minted = await stand.api(`/core/nonce?page=${page}`);
      const bound = await stand.api('/core/config', {
        method: 'POST',
        body: {
          cmdId: newId(),
          doc: { ...config.body.doc, telegram: { owner: unbound?.fingerprint } },
          baseDigest: config.body.digest,
          proof: { nonce: minted.body?.nonce, page },
        },
      });
      check(`привязка владельца записана (${bound.status})`, bound.status === 200, bound.text);

      // ── 1. конец задачи — одно сообщение ──────────────────────────────────────────────────
      const done = await until(() => sentWith('Уведомление: готова с MR')[0], 40_000);
      const doneButtons = keyboardOf(done);
      check(
        'готова с MR: одно сообщение, кнопка-ссылка MR наружу и «На доработку»',
        textOf(done).includes('✅ Задача готова') &&
          doneButtons.some(
            (one) =>
              one.text === '🔀 Открыть MR' &&
              one.url === 'https://tracker.example.com/group/app/-/merge_requests/4',
          ) &&
          doneButtons.some((one) => one.text === '🔁 На доработку' && one.callback_data),
        JSON.stringify({ text: textOf(done), doneButtons }),
      );
      const loop = await until(() => sentWith('Уведомление: MR на стенде')[0]);
      check(
        'MR на loopback: без кнопки-ссылки, адрес строкой в тексте',
        Boolean(loop) &&
          !keyboardOf(loop).some((one) => one.url) &&
          textOf(loop).includes('127.0.0.1:8929'),
        JSON.stringify({ text: textOf(loop), buttons: keyboardOf(loop) }),
      );
      const failed = await until(() => sentWith('Уведомление: упала')[0]);
      check(
        'падение (подписка runError): «Задача упала» с «На доработку»',
        textOf(failed).includes('⛔ Задача упала') &&
          keyboardOf(failed).some((one) => one.text === '🔁 На доработку'),
        textOf(failed),
      );
      await wait(12_000);
      check(
        'через два прохода копий нет: по одному сообщению на конец',
        sentWith('Уведомление: готова с MR').length === 1 &&
          sentWith('Уведомление: MR на стенде').length === 1 &&
          sentWith('Уведомление: упала').length === 1,
        JSON.stringify(
          sent()
            .map(textOf)
            .map((text) => text.slice(0, 60)),
        ),
      );

      // ── 2. /status ────────────────────────────────────────────────────────────────────────
      // Строки — по списку самого ядра: живые не черновики, черновик (задача с вопросом запуска)
      // строки не получает.
      const statusRow = async (label) => {
        const list = (await stand.api('/core/tasks')).body?.tasks ?? [];
        const moving = list.filter((task) => task.ended === null && task.state !== 'draft');
        const before = sent().length;
        say('/status');
        // Ответ /status — по его первой строке: уведомление ядра (например MR задачи после
        // доработки) может уйти в тот же миг и встать перед ответом.
        const status = await until(() =>
          sent()
            .slice(before)
            .find((c) => textOf(c).includes('Работают:')),
        );
        const text = textOf(status);
        check(
          `${label}: /status — строки задач ядра по его списку (${moving.length} живых не черновиков)`,
          !text.includes(LIVE_TITLE) &&
            (moving.length === 0
              ? !text.includes('Задачи ядра')
              : text.includes(`Задачи ядра: ${moving.length}`) &&
                moving.every((task) => !task.title || text.includes(task.title.slice(0, 40)))),
          JSON.stringify({ text, moving: moving.map((task) => [task.title, task.state]) }),
        );
      };
      await statusRow('до доработки');

      // ── 3. /task ──────────────────────────────────────────────────────────────────────────
      const boardEntries = async () => (await stand.api('/core/board')).body?.entries ?? [];
      const fromTelegram = async () =>
        (await boardEntries()).filter((one) => one.source?.kind === 'telegram');
      const update = {
        update_id: bot.nextUpdateId++,
        message: {
          message_id: 777001,
          date: Math.floor(Date.now() / 1000),
          text: '/task проверить вход',
          chat: { id: OWNER, type: 'private' },
          from: { id: OWNER, is_bot: false, first_name: 'Анна' },
        },
      };
      push(update);
      const entryReply = await until(() => sentWith('Во «Входящих»: проверить вход')[0], 30_000);
      const entries = await until(async () => {
        const got = await fromTelegram();
        return got.length ? got : null;
      });
      // Репозиториев для Telegram в настройке ещё нет: запись ждёт репозиторий на доске, кнопки,
      // которая заведомо вернётся отказом запускателя, нет — вместо неё подсказка и ссылка на доску.
      check(
        '/task без репозиториев: запись во «Входящих» (источник telegram), «В работу» нет, есть подсказка и ссылка на доску',
        entries?.length === 1 &&
          entries[0].state === 'inbox' &&
          !keyboardOf(entryReply).some((one) => one.text === '▶️ В работу') &&
          textOf(entryReply).includes('Репозиторий не задан') &&
          textOf(entryReply).includes('/core?view=board'),
        JSON.stringify({ entries, reply: textOf(entryReply), buttons: keyboardOf(entryReply) }),
      );
      push({ ...update, update_id: bot.nextUpdateId++ });
      say('/task чужая запись', { from: STRANGER });
      await wait(6_000);
      check(
        'то же сообщение второй раз — ни второй записи, ни второго ответа; чужой /task — ничего',
        (await fromTelegram()).length === 1 &&
          sentWith('Во «Входящих»').length === 1 &&
          !sent().some((call) => String(call.body.chat_id) === String(STRANGER)),
        JSON.stringify({
          entries: await fromTelegram(),
          replies: sentWith('Во «Входящих»').length,
        }),
      );

      // ── 4. «В работу» ─────────────────────────────────────────────────────────────────────
      // Человек задаёт репозитории для Telegram (`set-config`, как поле карточки): следующая запись
      // несёт их и получает «В работу».
      const REPOS = [{ path: join(stand.home, 'tg-repo'), baseRef: null }];
      const current = await stand.api('/core/config');
      const reposPage = newId();
      const reposNonce = await stand.api(`/core/nonce?page=${reposPage}`);
      const reposSet = await stand.api('/core/config', {
        method: 'POST',
        body: {
          cmdId: newId(),
          doc: {
            ...current.body.doc,
            telegram: { ...current.body.doc.telegram, repos: REPOS },
          },
          baseDigest: current.body.digest,
          proof: { nonce: reposNonce.body?.nonce, page: reposPage },
        },
      });
      check(
        `репозитории для задач из Telegram записаны (${reposSet.status})`,
        reposSet.status === 200,
        reposSet.text,
      );
      say('/task проверить выход');
      const launchReply = await until(() => sentWith('Во «Входящих»: проверить выход')[0], 30_000);
      const launchEntry = await until(async () =>
        (await fromTelegram()).find((one) =>
          JSON.stringify(one.launch).includes('проверить выход'),
        ),
      );
      check(
        '/task с репозиториями: запись несёт их в полях запуска, ответ с «В работу»',
        JSON.stringify(launchEntry?.launch?.fields?.repos) === JSON.stringify(REPOS) &&
          keyboardOf(launchReply).some((one) => one.text === '▶️ В работу'),
        JSON.stringify({
          entry: launchEntry,
          reply: textOf(launchReply),
          buttons: keyboardOf(launchReply),
        }),
      );
      const work = keyboardOf(launchReply).find((one) => one.text === '▶️ В работу');
      const editsBefore = edits().length;
      // Нажатие как у Telegram: сообщение бота несёт, на какой `/task` оно ответило, — по этому
      // ключу (`tg:<чат>:<сообщение>`) панель находит запись на живой доске, не по файлу.
      if (work) {
        push({
          update_id: bot.nextUpdateId++,
          callback_query: {
            id: `cb-work-${bot.nextUpdateId}`,
            from: { id: OWNER, is_bot: false, first_name: 'Q' },
            message: {
              message_id: launchReply.messageId,
              chat: { id: OWNER, type: 'private' },
              reply_to_message: { message_id: launchReply.body.reply_parameters?.message_id },
            },
            data: work.callback_data,
          },
        });
      }
      const workEdit = await until(() =>
        edits()
          .slice(editsBefore)
          .find((call) => Number(call.body.message_id) === launchReply.messageId),
      );
      // Запускатель решает сам и не сразу: «В очереди» — до его решения, затем итог под тем же
      // сообщением по записям доски — «Запущена» или причина возврата во «Входящие».
      const settled = await until(
        () =>
          edits()
            .slice(editsBefore)
            .find(
              (call) =>
                Number(call.body.message_id) === launchReply.messageId &&
                /Запущена|Не запущена/.test(textOf(call)),
            ),
        30_000,
      );
      const afterWork = (await fromTelegram()).find((one) => one.entryId === launchEntry?.entryId);
      const settledLine = textOf(settled)
        .split('\n')
        .find((line) => /Запущена|Не запущена/.test(line));
      console.log(`  · итог «В работу»: ${settledLine ?? '—'} (ядро: ${afterWork?.reason ?? '—'})`);
      // Отказ запускателя — английская проза ядра; в Telegram уходит русская строка, никогда она.
      // Путь стенда — не git-репозиторий нарочно: оценка ядра отбивает запись, это и проверяется.
      const refusedRu =
        afterWork?.state === 'inbox' &&
        /not a git repository/.test(String(afterWork.reason)) &&
        textOf(settled).includes('Не запущена: путь репозитория — не git-репозиторий') &&
        !textOf(settled).includes('not a git') &&
        !textOf(settled).includes('tg-repo');
      check(
        '«В работу»: ход доски дошёл до ядра; отказ оценки («не git-репозиторий») русской строкой под сообщением, без пути и прозы ядра',
        Boolean(workEdit) && Boolean(settled) && refusedRu,
        JSON.stringify({ first: textOf(workEdit), settled: textOf(settled), entry: afterWork }),
      );

      // ── 5. «На доработку» ─────────────────────────────────────────────────────────────────
      const rework = keyboardOf(done).find((one) => one.text === '🔁 На доработку');
      const sentBefore = sent().length;
      press(rework.callback_data, done.messageId);
      const prompt = await until(() =>
        sent()
          .slice(sentBefore)
          .find((call) => call.body.reply_markup?.force_reply),
      );
      check(
        '«На доработку»: подсказка с принудительным ответом',
        Boolean(prompt) && textOf(prompt).includes('Что доработать'),
        JSON.stringify(
          sent()
            .slice(sentBefore)
            .map((call) => call.body),
        ),
      );
      const afterPrompt = sent().length;
      say('добавь проверку пустого пароля', { replyTo: prompt?.messageId });
      const verdict = await until(
        () =>
          sent()
            .slice(afterPrompt)
            .find((call) => /Доработка принята|Ядро отказало|не отвечает/.test(textOf(call))),
        30_000,
      );
      check(
        'ответ на подсказку дошёл до ядра командой rework: «Доработка принята»',
        textOf(verdict).includes('Доработка принята'),
        textOf(verdict),
      );
      await statusRow('после доработки');

      // ── 6. подделанное нажатие ────────────────────────────────────────────────────────────
      const toastsBefore = toasts().length;
      press(rework.callback_data, failed.messageId);
      await until(() => toasts().length > toastsBefore);
      check(
        'нажатие с чужим номером сообщения — «Кнопка устарела»',
        toasts().slice(toastsBefore).includes('Кнопка устарела'),
        JSON.stringify(toasts().slice(toastsBefore)),
      );

      // ── 7. тихие часы ─────────────────────────────────────────────────────────────────────
      const quiet = { from: '23:00', to: '08:00', asks: false };
      const saveQuiet = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: {
          settings: { enabled: true, chatId: String(OWNER), events: ['runError'], quiet },
        },
      });
      const settings = await stand.api('/settings');
      check(
        'тихие часы сохранены и читаются из настроек',
        saveQuiet.status === 200 &&
          JSON.stringify(settings.body?.integrations?.telegram?.quiet) === JSON.stringify(quiet),
        `${saveQuiet.status} ${JSON.stringify(settings.body?.integrations?.telegram)}`,
      );
      const badQuiet = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: {
          settings: {
            enabled: true,
            chatId: String(OWNER),
            events: ['runError'],
            quiet: { from: '24:00', to: '08:00', asks: false },
          },
        },
      });
      check(
        'время 24:00 — отказ схемы, сохранённое не тронуто',
        badQuiet.status >= 400 &&
          badQuiet.status < 500 &&
          JSON.stringify((await stand.api('/settings')).body?.integrations?.telegram?.quiet) ===
            JSON.stringify(quiet),
        `${badQuiet.status} ${badQuiet.text.slice(0, 200)}`,
      );
      check(
        'токен бота не ушёл ни в один ответ API',
        ![answers, saveQuiet, settings].some((reply) => reply.text.includes(TOKEN)),
      );
      void seeded;
    },
  );
} finally {
  tgStub.close();
}
