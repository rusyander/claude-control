/**
 * Курсор потока принадлежит ХОДУ — во вкладке браузера, на одноразовой панели.
 *
 * Вкладка, скрытая посреди хода, отпускает поток и держит номер его последнего
 * кадра. Пока она скрыта, ход кончился, а под тем же ключом начался новый —
 * он нумерует кадры с нуля. Вернувшись, вкладка подключалась с курсором прошлого
 * хода (`?from=<seq>`) и получала новый ход без начала: без кадра сессии, с
 * прошлым `startedAt`, текст дописывался к пузырю прошлого хода. Исправление:
 * вкладка называет ход курсора (`&startedAt=`), сервер, видя другой ход, отдаёт
 * его с начала, а кадр сессии другого хода начинает пузырь заново.
 *
 * Настоящие: процесс сервера, реестр прогонов, маршрут потока, Vite с его
 * прокси, стор вкладки `shared/lib/agent-runs` — тот самый модуль, что грузит
 * приложение (тот же адрес у Vite — тот же экземпляр). Подменены модель
 * (фальшивый `claude`, ход «ПИНГ» — «Понг» тремя кусочками по 0,9 с) и
 * видимость вкладки (`document.visibilityState` + событие `visibilitychange`).
 *
 * Строки:
 *  1. вкладка подхватила ход 1 и получила его начало;
 *  2. скрытая вкладка отпустила поток (прогон припаркован);
 *  3. ход 2 идёт на сервере под тем же ключом, его `startedAt` больше;
 *  4. вернувшаяся вкладка подключилась с курсором хода 1 и назвала ход 1;
 *  5. стор узнал ход 2 (его `startedAt`) и собрал пузырь ровно из хода 2;
 *  6. ход 2 кончился в сторе: не «работает».
 *
 * Запуск: node tools/qa/check-web-turn-cursor.mjs   (браузеры: pnpm qa:setup)
 * Выход 0 — всё сошлось, 1 — расхождения, 2 — стенд не поднялся.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';

const STORE = '/src/shared/lib/agent-runs/index.ts';

const framesOf = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));

await runOnStand(
  { label: 'web-turn-cursor', fakeCli: { claude: FAKE_BASICS_CLI } },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const chatId = randomUUID();
      const projectPath = join(stand.root, 'qa-web-cursor');
      mkdirSync(projectPath, { recursive: true });

      const page = await stand.newPage(browser);
      const streams = [];
      page.on('request', (request) => {
        if (request.url().includes(`/api/chat/${chatId}/stream`)) streams.push(request.url());
      });
      await page.goto(stand.webUrl, { waitUntil: 'domcontentloaded' });

      /** Состояние прогона в сторе вкладки. */
      const runInTab = () =>
        page.evaluate(
          async ([store, id]) => {
            const runs = await import(store);
            const run = runs.getRun(id);
            return {
              text: run.text,
              startedAt: run.startedAt,
              status: run.status,
              parked: run.parked,
            };
          },
          [STORE, chatId],
        );
      const until = async (probe, seconds = 15) => {
        for (let i = 0; i < seconds * 10; i += 1) {
          const value = await probe();
          if (value) return value;
          await wait(100);
        }
        return undefined;
      };
      const setVisibility = (state) =>
        page.evaluate((value) => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => value,
          });
          document.dispatchEvent(new Event('visibilitychange'));
        }, state);
      const send = (prompt, extra = {}) =>
        stand
          .api('/chat/send', { method: 'POST', body: { chatId, prompt, projectPath, ...extra } })
          .then((sent) => ({ status: sent.status, frames: framesOf(sent.text) }));

      // Ход 1 начат не вкладкой (телефон, соседнее окно) — вкладка его подхватывает.
      const first = send('ПИНГ');
      const listedFirst = await until(async () => {
        const active = (await stand.api('/chat/active')).body;
        return Array.isArray(active) ? active.find((run) => run.chatId === chatId) : undefined;
      });
      // Пузырь открытого разговора: законченный ход держит текст, пока лента не перечитана.
      await page.evaluate(
        async ([store, id]) => {
          const runs = await import(store);
          runs.agentRuns.setActiveId(id);
          await runs.agentRuns.resumeActive();
        },
        [STORE, chatId],
      );
      const begun = await until(async () => {
        const run = await runInTab();
        return run.text.length > 0 ? run : undefined;
      });
      check(
        '1. вкладка подхватила ход 1 и получила его начало',
        Boolean(listedFirst?.startedAt) && begun?.startedAt === listedFirst?.startedAt,
        JSON.stringify({ listedFirst, begun }),
      );

      await setVisibility('hidden');
      const parked = await until(async () => {
        const run = await runInTab();
        return run.parked ? run : undefined;
      }, 5);
      check(
        '2. скрытая вкладка отпустила поток: прогон припаркован',
        Boolean(parked),
        JSON.stringify(parked),
      );

      const firstDone = await first;
      const firstSession = firstDone.frames.find((frame) => frame.kind === 'session');
      // Ход 2 под тем же ключом, пока вкладка скрыта.
      await wait(20);
      const second = send('ПИНГ', { sessionId: firstSession?.sessionId });
      const listedSecond = await until(async () => {
        const active = (await stand.api('/chat/active')).body;
        const run = Array.isArray(active)
          ? active.find((item) => item.chatId === chatId)
          : undefined;
        return run?.status === 'running' && run.startedAt > (firstSession?.startedAt ?? 0)
          ? run
          : undefined;
      });
      check(
        '3. ход 2 идёт на сервере под тем же ключом, его startedAt больше',
        Boolean(listedSecond),
        `${firstSession?.startedAt} → ${listedSecond?.startedAt}`,
      );
      // Пусть ход 2 успеет выпустить кусочек — курсор хода 1 тогда что-то прячет.
      await wait(1_000);

      const before = streams.length;
      await setVisibility('visible');
      const whole = await until(async () => {
        const run = await runInTab();
        return run.startedAt === listedSecond?.startedAt && run.text === 'Понг' ? run : undefined;
      });
      const back = streams.slice(before)[0] ?? '';
      console.log(`подключение вернувшейся вкладки: ${back.replace(stand.webUrl, '')}`);
      check(
        '4. вернувшаяся вкладка назвала ход своего курсора (startedAt хода 1)',
        /[?&]from=[1-9]\d*/.test(back) && back.includes(`startedAt=${firstSession?.startedAt}`),
        back || '(запроса потока не было)',
      );
      const seen = whole ?? (await runInTab());
      check(
        '5. стор узнал ход 2 и собрал пузырь ровно из него: «Понг», startedAt хода 2',
        Boolean(whole),
        JSON.stringify(seen),
      );

      await second;
      const ended = await until(async () => {
        const run = await runInTab();
        return run.status !== 'running' ? run : undefined;
      });
      check(
        '6. ход 2 кончился и в сторе: не «работает»',
        Boolean(ended),
        JSON.stringify(ended ?? (await runInTab())),
      );
      check('   без ошибок страницы', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
