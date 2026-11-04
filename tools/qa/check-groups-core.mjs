/**
 * Страница «Группы» над ядром (этап 10, F1) — настоящая дорога браузера: одноразовая
 * панель + своё ядро (`startStand({ core: true })`), запросы идут через прокладку панели к живому
 * ядру, ответы не перехватываются.
 *
 * Что видно:
 *   - на странице — задачи ядра и вход в запуск (тот же экран оценки этапа 9);
 *   - у прежней группы с «Путём» — «В ядро»: перевод `fromPath` у ядра показывает шаги «Пути» по
 *     порядку + доставку ядра, сохранение кладёт сценарий в библиотеку ядра, запуск открывается с
 *     этим сценарием; оценка создаёт задачу ядра, у которой сценарий = этот, а его шаги = «Путь»;
 *   - в оценку не уходит ничего от прежнего недоведённого запуска (ни копия, ни ветка, ни его
 *     запрос) — ядро не подхватывает прежние запуски (Q10, спека 10:8);
 *   - прежний недоведённый запуск после старта панели остановлен разовой миграцией: в state.json у
 *     него `cancelledAt`, на странице — «Отменён», без кнопок, и в задачах ядра его нет;
 *   - сетка прежних групп только для чтения: у карточки одно действие «В ядро» — ни тумблера, ни
 *     правки, ни копии, ни запуска; кнопки «Создать группу» нет.
 *
 * Запуск: `node tools/qa/check-groups-core.mjs` (стенд свой, `pnpm dev` не нужен). `SHOTS=<dir>` —
 * кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра. Код выхода: 0 — сходится,
 * 1 — провал, 2 — стенд не поднялся.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

// Ядру нужен найденный CLI, чтобы дорога `cli` прошла; сам CLI проверке не нужен.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

const GROUP_ID = '5d1c0b7e-0a9f-4c33-9a51-1f00c0de0f01';
const GROUP_NAME = 'Сценарий из Пути';
const PATH_TITLES = ['Разобрать логи', 'Починить парсер', 'Описать итог'];
const LEGACY_CHAT = 'legacy-chat-1';
const LEGACY_BRANCH = 'feat/legacy-half-run';
const LEGACY_REQUEST = 'прежний запрос недоведённой группы';

const T = (text) => ({ ru: text, en: text });

function pathSteps() {
  // Порядок хранения перемешан: перевод обязан идти по `order`, а не по месту в массиве.
  const order = [2, 0, 1];
  return order.map((i) => ({
    id: `step-${i}`,
    anchor: 'work',
    order: i,
    kind: 'prompt',
    title: T(PATH_TITLES[i]),
    prompt: T(`Сделать: ${PATH_TITLES[i]}`),
    source: 'ru',
    createdAt: '2026-10-01T00:00:00.000Z',
  }));
}

let repo = '';
let legacyCopy = '';
let statePath = '';

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`), fullPage: true });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

await runOnStand(
  {
    label: 'groups-core',
    core: true,
    fakeCli: { claude: FAKE_CLAUDE },
    seed: async ({ root, cfg }) => {
      repo = join(root, 'repo');
      legacyCopy = join(root, 'legacy-copy');
      mkdirSync(repo, { recursive: true });
      const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'stand@example.com');
      git('config', 'user.name', 'stand');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');

      statePath = join(cfg, 'agentdeck', 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.groups = [
        {
          id: GROUP_ID,
          name: GROUP_NAME,
          description: '',
          color: 'accent',
          icon: 'folder',
          members: [],
          env: {},
          flow: 'scenario',
          path: { steps: pathSteps() },
          isEnabled: false,
          order: 0,
        },
      ];
      // Недоведённый запуск прежнего пути: одна группа идёт, вторая кончилась.
      state.splitPlans = {
        [LEGACY_CHAT]: {
          parentChatId: LEGACY_CHAT,
          projectPath: repo,
          copyRoot: legacyCopy,
          createdAt: '2026-10-30T10:00:00.000Z',
          order: [0, 1],
          request: {},
          proposal: {
            shared: LEGACY_REQUEST,
            groups: [
              { title: 'Прежняя группа A', branch: LEGACY_BRANCH, tasks: [LEGACY_REQUEST] },
              { title: 'Прежняя группа B', branch: 'feat/legacy-b', tasks: ['b'] },
            ],
          },
          groups: [
            {
              index: 0,
              title: 'Прежняя группа A',
              branch: LEGACY_BRANCH,
              after: [],
              status: 'started',
              path: legacyCopy,
            },
            {
              index: 1,
              title: 'Прежняя группа B',
              branch: 'feat/legacy-b',
              after: [],
              status: 'done',
            },
          ],
        },
      };
      writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');
    },
  },
  async (stand, check) => {
    // `claude.cmd` формы npm cmd-shim (её одну ядро разбирает на Windows) пишет сам стенд.
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 3200 });
      await page.goto(`${stand.webUrl}/groups?tab=global`);
      await page
        .getByRole('heading', { name: GROUP_NAME })
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      await page.waitForTimeout(800);
      await shoot(page, 'groups-page');

      // 1. Задачи ядра на странице групп.
      const core = page.locator('[data-groups-core]');
      check(
        'на странице групп — раздел задач ядра',
        await core
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false),
      );
      check(
        'раздел задач ядра прочитал список ядра (пусто — честная пустая строка)',
        (await core.locator('[data-core-task-list], [data-groups-core-empty]').count()) > 0,
        await core.innerText().catch(() => '(нет раздела)'),
      );

      // 2. Прежний недоведённый запуск — остановлен миграцией при старте, только чтение, не подхвачен.
      const stored = JSON.parse(readFileSync(statePath, 'utf8')).splitPlans?.[LEGACY_CHAT];
      check(
        'миграция при старте записала прежнему недоведённому запуску cancelledAt',
        typeof stored?.cancelledAt === 'string' && stored.cancelledAt.length > 0,
        JSON.stringify(stored?.cancelledAt),
      );
      check(
        'миграция не тронула группы плана (статусы как были)',
        JSON.stringify(stored?.groups?.map((g) => g.status)) ===
          JSON.stringify(['started', 'done']),
        JSON.stringify(stored?.groups?.map((g) => g.status)),
      );
      const legacy = page.locator(`[data-legacy-run="${LEGACY_CHAT}"]`);
      const legacyShown = await legacy
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      check('прежний недоведённый запуск виден на странице', legacyShown);
      if (legacyShown) {
        check(
          'прежний запуск показан остановленным (cancelled, «Отменён»), а не «не доведён»',
          (await legacy.getAttribute('data-legacy-state')) === 'cancelled' &&
            (await legacy.innerText()).includes('Отменён'),
          `${await legacy.getAttribute('data-legacy-state')}: ${await legacy.innerText()}`,
        );
        check(
          'у прежнего запуска нет действий — ядро его не подхватывает',
          (await legacy.locator('button, a').count()) === 0,
          await legacy.innerHTML(),
        );
      }

      // 3. Сетка прежних групп — только чтение.
      const tile = page
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: GROUP_NAME, exact: true }) });
      const controls = await tile
        .locator(
          'button, a, input, select, textarea, [role="switch"], [role="checkbox"], [role="menu"]',
        )
        .evaluateAll((els) =>
          els.map((el) =>
            el.hasAttribute('data-group-core-import') ? 'core-import' : el.outerHTML.slice(0, 120),
          ),
        );
      check(
        'у карточки прежней группы одно действие — «В ядро» (ни тумблера, ни правки, ни запуска)',
        JSON.stringify(controls) === JSON.stringify(['core-import']),
        controls.join(' | '),
      );
      check(
        'на странице нет кнопки «Создать группу»',
        (await page.getByRole('button', { name: /Создать группу/ }).count()) === 0,
      );
      await tile.click({ position: { x: 20, y: 20 } }).catch(() => undefined);
      await page.waitForTimeout(400);
      check(
        'клик по карточке не открывает окна правки',
        (await page.getByRole('dialog').count()) === 0,
        await page
          .getByRole('dialog')
          .allInnerTexts()
          .then((x) => x.join(' | ')),
      );

      // 4. «В ядро»: перевод «Пути» у ядра.
      const importButton = tile.locator('[data-group-core-import]');
      if (
        !check(
          'у прежней группы есть «В ядро»',
          (await importButton.count()) === 1,
          await tile.innerText().catch(() => '(карточки нет)'),
        )
      ) {
        check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
        return;
      }
      const converted = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('/api/core/scenarios/from-path'),
        { timeout: 20_000 },
      );
      await importButton.click();
      const fromPath = await converted.catch(() => null);
      check(
        'перевод «Пути» ушёл в ядро и вернул 200',
        fromPath?.status() === 200,
        String(fromPath?.status()),
      );
      const dialog = page.locator('[data-core-import]');
      await dialog.waitFor({ timeout: 15_000 });
      await dialog
        .locator('[data-core-import-step], [data-core-import-problems], [data-core-import-failed]')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined);
      const steps = await dialog.locator('[data-core-import-step]').allInnerTexts();
      check(
        'шаги сценария = шаги «Пути» по порядку, затем проверка и публикация ядра',
        steps.length === PATH_TITLES.length + 2 &&
          PATH_TITLES.every((title, i) => steps[i]?.includes(title)),
        steps.join(' | '),
      );
      await shoot(page, 'groups-core-import');

      const saved = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/core\/scenarios$/.test(r.url()),
        { timeout: 20_000 },
      );
      // Кнопка — в подвале окна, вне тела `[data-core-import]`.
      await page.locator('[data-core-import-save]').click();
      const save = await saved.catch(() => null);
      check(
        'сценарий из «Пути» сохранён в библиотеку ядра',
        save !== null && [200, 201].includes(save.status()),
        save ? `${save.status()} ${await save.text()}` : 'запроса нет',
      );
      const saveBody = save ? await save.json().catch(() => ({})) : {};
      const ref = saveBody.ref;

      // 5. Запуск со сценарием группы → задача ядра.
      const form = page.locator('[data-groups-core] [data-core-launch-form]');
      await form.waitFor({ timeout: 15_000 });
      // Список сценариев перечитывается после записи: пока новой версии в нём нет, `<select>`
      // показывает первый вариант. Ждём ответа списка до 10 с, а не судим по первому кадру.
      const want = ref ? `library:${ref.id}@${ref.version}` : '';
      let selected = '';
      for (let i = 0; i < 40 && selected !== want; i += 1) {
        selected = await form
          .locator('select')
          .first()
          .inputValue()
          .catch(() => '');
        if (selected !== want) await page.waitForTimeout(250);
      }
      check(
        'запуск открыт со сценарием группы',
        ref && selected === `library:${ref.id}@${ref.version}`,
        `${selected} vs ${JSON.stringify(ref)}`,
      );
      await form.getByLabel('Требования').fill('Пройти шаги группы.');
      const repoField = form.getByLabel('Путь к репозиторию').first();
      if (!(await repoField.inputValue())) await repoField.fill(repo);
      const sent = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().includes('/api/core/estimate'),
        { timeout: 20_000 },
      );
      await page.locator('[data-groups-core] [data-estimate-button]').click();
      const request = await sent.catch(() => null);
      if (!check('форма отправила оценку', request !== null)) return;
      const body = JSON.parse(request.postData() ?? '{}');
      const fields = body.fields ?? {};
      check(
        'в оценку ушёл сценарий группы',
        ref && fields.scenario?.id === ref.id && fields.scenario?.version === ref.version,
        JSON.stringify(fields.scenario),
      );
      const wire = JSON.stringify(fields);
      check(
        'в оценку не ушло ничего от прежнего запуска (копия, ветка, запрос)',
        !wire.includes(LEGACY_BRANCH) &&
          !wire.includes(LEGACY_REQUEST) &&
          !wire.includes('legacy-copy') &&
          !wire.includes(LEGACY_CHAT),
        wire,
      );

      const estimate = page.locator('[data-groups-core] [data-launch-section="estimate"]');
      const failure = page.locator('[data-groups-core] [data-launch-failure]');
      await estimate.or(failure).first().waitFor({ timeout: 60_000 });
      if (await failure.count()) {
        check(
          'оценка дошла до ядра',
          false,
          `${await failure.first().getAttribute('data-launch-failure')}: ${await failure.first().innerText()}`,
        );
      } else {
        check('оценка дошла до ядра', true);
        const tasks = await stand.api('/core/tasks');
        const list = tasks.body?.tasks ?? [];
        check('у ядра одна задача — та, что создана с группы', list.length === 1, tasks.text);
        const taskId = list[0]?.taskId;
        const task = taskId ? await stand.api(`/core/tasks/${taskId}`) : { body: {} };
        const scenarioRef = task.body?.view?.scenario?.ref;
        check(
          'сценарий задачи ядра = сценарий из «Пути» группы',
          ref && scenarioRef?.id === ref.id && scenarioRef?.version === ref.version,
          JSON.stringify(scenarioRef),
        );
        const scenario = ref
          ? await stand.api(`/core/scenarios/${ref.id}@${ref.version}`)
          : { body: {} };
        const titles = (scenario.body?.scenario?.steps ?? []).map((s) => s.title);
        check(
          'шаги сценария задачи = «Путь» группы (+ доставка ядра)',
          JSON.stringify(titles.slice(0, PATH_TITLES.length)) === JSON.stringify(PATH_TITLES) &&
            titles.length === PATH_TITLES.length + 2,
          titles.join(' | '),
        );
        check(
          'задача ядра не про прежний запуск',
          !JSON.stringify(list).includes(LEGACY_CHAT),
          JSON.stringify(list),
        );
        // Без перезагрузки: список обязан перечитаться сам после оценки (5 с на ответ ядра).
        await page
          .locator(`[data-groups-core] [data-core-task="${taskId}"]`)
          .waitFor({ timeout: 5_000 })
          .catch(() => undefined);
        check(
          'новая задача видна в разделе задач ядра на странице групп',
          (await page.locator(`[data-groups-core] [data-core-task="${taskId}"]`).count()) === 1,
          await core.innerText(),
        );
        await shoot(page, 'groups-core-launched');
      }
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
