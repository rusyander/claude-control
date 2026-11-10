/**
 * Доска ядра на настоящей дороге (этап 12, W1-D): одноразовая панель, своё ядро, настоящий `claude`
 * из PATH против сценария `packages/stub-model` (модель — единственное, что подменено). Браузер
 * ходит через прокладку панели, ответы ядра не перехватываются; `check-core-board.mjs` судит
 * разметку на подменённом ответе, этот — что ядро само кладёт в колонки.
 *
 * Что видно:
 *   - раздел `board` настройки негоден (`inWork: 5`) — доска на умолчаниях (в работе — предел 2) и
 *     называет это значком «Умолчания»; годная запись раздела значок снимает;
 *   - «В очередь» формы запуска для группы из трёх пунктов — ОДНА запись доски со всеми пунктами
 *     `group-item`; на паузе обе записи (группа и одиночная) стоят в колонке «Очередь»;
 *   - пауза снята — старт группы ставит задачу на пункт с одним `groupId`, у каждой карточки та же
 *     запись; полоса группы (`?lane=group`) — три карточки; одиночная ждёт в очереди, пока задачи
 *     группы едят места (3 из 2);
 *   - задачи группы встают на вопросе приёма без живого сеанса — места свободны, одиночная
 *     стартует; чип «Ждёт вас» и колонка «Ждёт вас» показывают задачи группы;
 *   - одиночная (остановка «до плана») ждёт запуска человеком в «Разборе», после него идёт
 *     колонками стадий (работа → ревью → проверка) и снова встаёт в «Ждёт вас» на вопросе конца
 *     сценария — карточка со значком в колонке «Ждёт вас», чип считает её.
 *
 * Запуск: `node tools/qa/check-core-board-live.mjs` (стенд свой, `pnpm dev` не нужен; нужен
 * `claude` в PATH). `SHOTS=<dir>` — кадры доски (обе темы). Код выхода: 0 — сходится, 1 — провал,
 * 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { stepDoneScript } from './check-core-timeline.mjs';
import { coreDirect, uuidv7 } from './core-scenario-stand.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const TIMELINE = join(dirname(fileURLToPath(import.meta.url)), 'check-core-timeline.mjs');
const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
const GROUP_TITLE = 'Доска: группа из трёх';
const SINGLE_TITLE = 'Доска: одиночная задача';
const ITEMS = [
  { title: 'Пункт один', body: 'Создать one.txt со строкой one.' },
  { title: 'Пункт два', body: 'Создать two.txt со строкой two.' },
  { title: 'Пункт три', body: 'Создать three.txt со строкой three.' },
];
/** Разведка сдаёт карту — приём ведущего доходит до вопроса карточки (как check-core-group-launch). */
const RESEARCH = {
  map: {
    lines: ['README.md — единственный файл репозитория стенда'],
    files: [{ path: 'README.md', why: 'stand file' }],
    tests: [],
    owners: [],
  },
  classProposal: 'M',
};
/** Негодный раздел доски: `inWork` только 1, 2, 4 или 6 — ядро берёт умолчания и называет жалобу. */
const BAD_BOARD = {
  inWork: 5,
  perDay: null,
  paused: false,
  stopOnQuestion: false,
  defaultStop: 'mr',
};
const SHOTS = process.env.SHOTS ?? '';
/**
 * Та же заглушка для дороги входа CLI: старт с доски сразу открывает шаг на маршруте по умолчанию
 * (`cli-login:claude`), и `set-route` после старта к первому сеансу не успевает. Настоящий `claude`
 * читает settings.json стенда — адрес модели этой заглушки, ключ подставной; аккаунт и сеть не нужны.
 */
const cliStub = await startStubModel({
  script: stepDoneScript({ checkArgv: CHECK_ARGV, research: RESEARCH }),
});

/** Кадр доски в обеих темах. */
async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const board = page.locator('[data-core-board]');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await board.screenshot({ path: join(SHOTS, `live-${name}-${theme}_AFTER.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

// Стенд вырезает из PATH каталоги `claude`; сессии идут через настоящий CLI — его каталог
// возвращается в конец PATH панели и ядра. Нет CLI — не проверено, а не провал продукта.
const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
  encoding: 'utf8',
});
const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
let repo = '';

await runOnStand(
  {
    label: 'core-board-live',
    extraPath: claudeAt ? [dirname(claudeAt)] : [],
    core: {
      stub: [
        {
          name: 'stand',
          script: {
            module: TIMELINE,
            export: 'stepDoneScript',
            args: [{ checkArgv: CHECK_ARGV, research: RESEARCH }],
          },
        },
      ],
    },
    seed: ({ root, cfg, coreHome }) => {
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: cliStub.baseUrl,
              ANTHROPIC_API_KEY: 'sk-ant-stand-stub',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            },
          },
          null,
          2,
        )}\n`,
      );
      const configFile = join(coreHome, 'config.json');
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      config.board = BAD_BOARD;
      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      repo = join(root, 'repo');
      mkdirSync(join(repo, '.agentdeck'), { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(join(repo, 'README.md'), 'stand\n');
      writeFileSync(
        join(repo, '.agentdeck', 'checks.json'),
        `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
      );
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'init']);
    },
  },
  async (stand, check) => {
    if (!claudeAt) throw new NotChecked('claude не найден в PATH — сессиям задач нужен CLI');
    const core = coreDirect(stand);
    const command = async (taskId, kind, fields) =>
      core.direct('POST', '/v1/commands', {
        cmdId: uuidv7(),
        kind,
        target: { taskId },
        fields,
        proof: await core.proof(),
      });
    /** Маршрут-заглушка и модель задаче — подготовка, прямо в ядро, один раз на задачу. */
    const routed = new Set();
    const route = async (taskId) => {
      if (routed.has(taskId)) return;
      routed.add(taskId);
      const r = await command(taskId, 'set-route', {
        scope: 'task',
        scopeId: taskId,
        allowedRoutes: [
          { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
        ],
      });
      const m = await command(taskId, 'set-model', {
        scope: 'task',
        scopeId: taskId,
        model: 'stub-model',
        effort: null,
        timing: 'now',
      });
      if (r.body?.status !== 'applied' || m.body?.status !== 'applied')
        throw new Error(`маршрут/модель задачи ${taskId}: ${r.text} ${m.text}`);
    };
    /** Раздел `board` настройки ядра — годной записью, с доказательством человека. */
    const setBoard = async (section) => {
      const view = await core.direct('GET', '/v1/config');
      const doc = { ...view.body.doc, board: { ...BAD_BOARD, inWork: 2, ...section } };
      const got = await core.direct('POST', '/v1/config', {
        cmdId: uuidv7(),
        doc,
        baseDigest: view.body.digest,
        proof: await core.proof(),
      });
      if (got.status !== 200) throw new Error(`запись раздела board: ${got.status} ${got.text}`);
    };
    /** Ответ доски через прокладку панели — тот же, что читает страница. */
    const boardNow = async () => (await stand.api('/core/board')).body;
    const until = async (what, probe, seconds, step = 1000) => {
      for (let i = 0; i < (seconds * 1000) / step; i++) {
        const got = await probe();
        if (got) return got;
        await wait(step);
      }
      throw new Error(`не дождались: ${what}`);
    };

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 2400 });
      const openBoard = async (search = 'view=board') => {
        await page.goto(`${stand.webUrl}/core?${search}`);
        await page.locator('[data-core-board]').waitFor({ timeout: 120_000 });
      };

      // ── негодный раздел доски: умолчания и их значок ──────────────────────────────────────
      await openBoard();
      const issues = page.locator('[data-board-config-issues]');
      await issues.waitFor({ timeout: 15_000 }).catch(() => undefined);
      const first = await boardNow();
      check(
        `негодный раздел board: доска на умолчаниях (в работе — предел ${first?.limits?.inWork?.cap}) и называет жалобу (${(first?.configIssues ?? []).map((i) => i.section).join(', ') || 'нет'})`,
        (await issues.count()) === 1 &&
          first?.limits?.inWork?.cap === 2 &&
          (first?.configIssues ?? []).some((i) => i.section === 'board'),
        await page.locator('[data-board-limits]').innerText(),
      );
      await shoot(page, 'config-defaults');
      // Годная запись (пауза — записи постоят в очереди, пока их видно) снимает значок.
      await setBoard({ paused: true });
      const cleared = await until(
        'значок умолчаний снят',
        async () => ((await issues.count()) === 0 ? true : null),
        20,
      ).catch(() => false);
      check('годная запись раздела board снимает значок «Умолчания»', cleared === true);

      // ── «В очередь»: группа из трёх пунктов — одна запись ──────────────────────────────────
      await page.goto(`${stand.webUrl}/core/launch`);
      const form = page.locator('[data-core-launch-form]');
      await form.waitFor({ timeout: 120_000 });
      await form.getByLabel('Название', { exact: true }).fill(GROUP_TITLE);
      await form.getByLabel('Требования').fill('Создать три файла.');
      await form.getByLabel('Путь к репозиторию').fill(repo);
      // Пункты группы читает только приём ведущего (снимок источника).
      await form.getByLabel('Сценарий').selectOption('preset:lead');
      await form.getByLabel('Источник').selectOption('items');
      for (const [i, item] of ITEMS.entries()) {
        if (i > 0) await form.getByRole('button', { name: 'Добавить пункт' }).click();
        await form.getByLabel(`Название пункта ${i + 1}`).fill(item.title);
        await form.getByLabel(`Текст пункта ${i + 1}`).fill(item.body);
      }
      await form.getByLabel('Как запустить пункты').selectOption('group');
      const queueThroughForm = async () => {
        const sent = page.waitForRequest(
          (r) => r.method() === 'POST' && r.url().includes('/api/core/board/entries'),
          { timeout: 20_000 },
        );
        const answered = page.waitForResponse((r) => r.url().includes('/api/core/board/entries'), {
          timeout: 60_000,
        });
        await page.locator('[data-queue-button]').click();
        const request = await sent.catch(() => null);
        const response = await answered.catch(() => null);
        return {
          body: JSON.parse(request?.postData() ?? '{}'),
          status: response?.status() ?? 0,
          reply: response ? await response.json().catch(() => null) : null,
        };
      };
      const group = await queueThroughForm();
      const sources = group.body.entries?.[0]?.launch?.fields?.sources ?? [];
      const groupEntry = group.reply?.created?.[0];
      if (
        !check(
          `«В очередь» группы (${group.status}): записей ${group.body.entries?.length ?? 0}, пунктов ${sources.length} (${[...new Set(sources.map((s) => s.kind))].join(', ')})`,
          group.status === 200 &&
            group.body.entries?.length === 1 &&
            group.reply?.created?.length === 1 &&
            sources.length === ITEMS.length &&
            sources.every((s) => s.kind === 'group-item'),
          JSON.stringify(group.reply).slice(0, 600),
        )
      )
        return;

      // ── одиночная: остановка «до плана» ──────────────────────────────────────────────────
      await page.goto(`${stand.webUrl}/core/launch`);
      await form.waitFor({ timeout: 60_000 });
      await form.getByLabel('Источник').selectOption('text');
      await form.getByLabel('Название', { exact: true }).fill(SINGLE_TITLE);
      await form.getByLabel('Требования').fill('Write hello.txt');
      await form.getByLabel('Путь к репозиторию').fill(repo);
      await form.getByLabel('Сценарий').selectOption('preset:bug-fix');
      await page.locator('[data-queue-stop] select').selectOption('plan');
      const single = await queueThroughForm();
      const singleEntry = single.reply?.created?.[0];
      if (
        !check(
          `«В очередь» одиночной (${single.status}): остановка ${single.body.entries?.[0]?.stop}`,
          single.status === 200 &&
            Boolean(singleEntry) &&
            single.body.entries?.[0]?.stop === 'plan',
          JSON.stringify(single.reply).slice(0, 600),
        )
      )
        return;

      // ── пауза: обе записи стоят в колонке «Очередь» ──────────────────────────────────────
      await openBoard();
      const queued = page.locator('[data-board-card-kind="entry"][data-board-card-column="queue"]');
      await until(
        'две записи в очереди',
        async () => ((await queued.count()) === 2 ? true : null),
        20,
      ).catch(() => undefined);
      const queueTitles = await queued.allInnerTexts();
      check(
        `на паузе обе записи в колонке «Очередь», группа первой: ${queueTitles.map((t) => t.split('\n')[0]).join(' → ')}`,
        queueTitles.length === 2 &&
          queueTitles[0].includes(GROUP_TITLE) &&
          queueTitles[1].includes(SINGLE_TITLE),
      );
      await shoot(page, 'queue-paused');

      // ── пауза снята: группа — задача на пункт под одним groupId ─────────────────────────────
      await setBoard({ paused: false });
      let singleWaited = null;
      const groupCards = await until(
        'задачи группы на доске',
        async () => {
          const now = await boardNow();
          const cards = (now?.cards ?? []).filter(
            (c) => c.kind === 'task' && c.entryId === groupEntry,
          );
          for (const c of cards) await route(c.taskId);
          if (cards.length < ITEMS.length) return null;
          const entry = (now.entries ?? []).find((e) => e.entryId === singleEntry);
          singleWaited = { state: entry?.state, used: now.limits.inWork.used };
          return cards;
        },
        120,
        250,
      );
      const groupIds = new Set(groupCards.map((c) => c.groupId));
      check(
        `старт группы: задач ${groupCards.length}, groupId ${groupIds.size === 1 ? [...groupIds][0] : [...groupIds].join(' / ')}, у каждой карточки запись группы`,
        groupCards.length === ITEMS.length &&
          groupIds.size === 1 &&
          String([...groupIds][0]).startsWith('group-') &&
          groupCards
            .map((c) => c.title)
            .sort()
            .join('|') ===
            ITEMS.map((i) => i.title)
              .sort()
              .join('|'),
      );
      check(
        `одиночная ждёт в очереди, пока группа ест места: запись ${singleWaited?.state}, в работе ${singleWaited?.used} из 2`,
        singleWaited?.state === 'queued' && singleWaited.used >= 2,
      );
      const groupId = [...groupIds][0];
      await openBoard('view=board&lane=group');
      const lane = page.locator(`[data-board-lane-group="${groupId}"]`);
      await lane.waitFor({ timeout: 20_000 }).catch(() => undefined);
      const laneCount = (await lane.count())
        ? await lane.getAttribute('data-board-lane-count')
        : '0';
      const laneCards = await lane.locator('[data-board-card-kind="task"]').count();
      check(
        `полоса группы: ${laneCount} карточки по ответу, ${laneCards} на экране`,
        laneCount === String(ITEMS.length) && laneCards === ITEMS.length,
      );
      await shoot(page, 'group-lane');

      // ── группа встала на вопросе приёма — место свободно, одиночная стартует ────────────────
      const singleTask = await until(
        'одиночная стартовала',
        async () => {
          const now = await boardNow();
          const entry = (now?.entries ?? []).find((e) => e.entryId === singleEntry);
          if (entry?.state !== 'started' || !entry.taskId) return null;
          await route(entry.taskId);
          return entry.taskId;
        },
        300,
        500,
      );
      const atStart = await boardNow();
      const waitingGroup = (atStart?.cards ?? []).filter(
        (c) => c.entryId === groupEntry && c.waiting,
      );
      check(
        `одиночная стартовала, когда задачи группы встали на вопросе (ждут вас: ${waitingGroup.length} из ${ITEMS.length})`,
        waitingGroup.length >= 1,
      );
      await until(
        'все задачи группы ждут вас',
        async () => {
          const now = await boardNow();
          const waiting = (now?.cards ?? []).filter((c) => c.entryId === groupEntry && c.waiting);
          return waiting.length === ITEMS.length ? true : null;
        },
        300,
      ).catch(() => undefined);
      await openBoard();
      const chip = page.locator('[data-board-waiting]');
      await until(
        'чип «Ждёт вас»',
        async () =>
          Number(await chip.getAttribute('data-board-waiting')) >= ITEMS.length ? true : null,
        20,
      ).catch(() => undefined);
      const chipCount = Number(await chip.getAttribute('data-board-waiting'));
      const waitingColumn = await page
        .locator('[data-board-column="waiting"] [data-board-card-kind="task"]')
        .count();
      check(
        `«Ждёт вас»: чип ${chipCount}, в колонке «Ждёт вас» карточек ${waitingColumn}`,
        chipCount >= ITEMS.length && waitingColumn >= ITEMS.length,
      );
      await shoot(page, 'waiting');

      // ── одиночная: запуск человеком, колонки стадий, снова «Ждёт вас» ───────────────────────
      const columns = [];
      const seen = (column) => {
        if (column && columns.at(-1) !== column) columns.push(column);
      };
      let lastSeen = '';
      const launchAsk = await until(
        'вопрос запуска одиночной',
        async () => {
          const card = (await boardNow())?.cards.find((c) => c.taskId === singleTask);
          seen(card?.column);
          const view = (await stand.api(`/core/tasks/${encodeURIComponent(singleTask)}`)).body
            ?.view;
          const open = (view?.asks ?? []).filter((a) => a.state === 'open');
          lastSeen = `${view?.state}; ${open.map((a) => `${a.source}:${a.dedupe}: ${String(a.question ?? '').slice(0, 160)}`).join(' | ')}`;
          return open.find((a) => a.source === 'launch');
        },
        300,
        500,
      ).catch((error) => {
        throw new Error(`${error.message} (задача: ${lastSeen})`);
      });
      const approved = await command(singleTask, 'approve-split', {
        splitId: launchAsk.dedupe.slice('split:'.length),
      });
      if (approved.body?.status !== 'applied')
        throw new Error(`запуск одиночной: ${approved.text}`);
      // После работы задача снова ждёт человека (вопрос конца сценария) — колонка «Ждёт вас».
      const STAGES = new Set(['work', 'review', 'check', 'ready']);
      const viewOf = async () =>
        (await stand.api(`/core/tasks/${encodeURIComponent(singleTask)}`)).body?.view;
      const lastAsk = await until(
        'одиночная прошла стадии и ждёт вас',
        async () => {
          const card = (await boardNow())?.cards.find((c) => c.taskId === singleTask);
          seen(card?.column);
          if (!columns.some((c) => STAGES.has(c))) return null;
          if (card?.column !== 'waiting' && card?.column !== 'closed') return null;
          const open = ((await viewOf())?.asks ?? []).filter((a) => a.state === 'open');
          return { column: card.column, asks: open.map((a) => a.source).join(', ') || 'нет' };
        },
        420,
        500,
      ).catch(() => ({ column: columns.at(-1), asks: '?' }));
      check(
        `одиночная прошла колонками стадий: ${columns.join(' → ')} (открытые вопросы: ${lastAsk.asks})`,
        columns[0] === 'triage' &&
          columns.some((c) => STAGES.has(c)) &&
          columns.indexOf('triage') < columns.findIndex((c) => STAGES.has(c)) &&
          columns.at(-1) === 'waiting',
      );
      await openBoard();
      const tile = page.locator(
        `[data-board-column="waiting"] [data-board-card-kind="task"][data-board-card-waiting]`,
        { hasText: SINGLE_TITLE },
      );
      await tile.waitFor({ timeout: 20_000 }).catch(() => undefined);
      const chipAfter = Number(await chip.getAttribute('data-board-waiting'));
      check(
        `карточка одиночной в колонке «Ждёт вас» со значком, чип ${chipAfter}`,
        (await tile.count()) === 1 && chipAfter === ITEMS.length + 1,
        await page.locator('[data-board-column="waiting"]').innerText(),
      );
      await shoot(page, 'single-waiting');
    } finally {
      await browser.close();
      await cliStub.close();
    }
  },
);
