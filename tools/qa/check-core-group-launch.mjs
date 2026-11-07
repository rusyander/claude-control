/**
 * Запуск группы с экрана запуска (этап 11, W3-18) — настоящая дорога: одноразовая панель, своё
 * ядро, настоящий `claude` из PATH против сценария `packages/stub-model` (модель — единственное,
 * что подменено; без неё задачи группы не доходят до деления и запускать нечего). Браузер ходит
 * через прокладку панели, ответы ядра не перехватываются.
 *
 * Что видно:
 *   - «Несколько пунктов» → «Группой — задач на пункт» → оценка: в теле только `group-item`, ядро
 *     ставит задачу на пункт с одним `groupId`;
 *   - каждой задаче группы — маршрут-заглушка (подготовка данных, прямо в ядро); ведущий
 *     спрашивает карточку приёма каждой задачи (у каждой свой вопрос `intake`);
 *   - `classify` в `lead.alwaysAsk` ядра стенда, разведка сдаёт карту: ведущий спрашивает и класс —
 *     вопрос того же источника `intake` с ключом `classify:<id>` (ключ виден в виде задачи через
 *     прокладку). Пока открыт только вопрос класса, кнопка карточек его не считает. Отрицательный —
 *     мутант «вопрос карточки = любой вопрос источника intake»: красная строка «вопрос класса — не
 *     карточка». Раздел запуска называет ожидание строкой «Ждут вашего ответа о классе задачи —
 *     задач: 3.» со ссылкой на ленту каждой. Класс отвечается прямо в ядро (подготовка), дальше —
 *     карточки;
 *   - ОДНО нажатие «Подтвердить карточки группы» → каждая задача получает ответ человека
 *     (строка `human.answered` «Подтвердить карточку» от `human:panel` и `intake.card` человека в
 *     журнале задачи), карточка говорит «Подтверждено карточек: 3 из 3», каждая задача доходит до
 *     деления, принятого проверкой, и ждёт запуска. Отрицательный — мутант «только задача 0»:
 *     красная строка «карточки группы подтверждены»;
 *   - ОДНО нажатие «Запустить группу» → все задачи группы выходят из ожидания запуска с делением,
 *     утверждённым человеком (состояние и `split.state approved` — вид задачи через прокладку,
 *     утверждение — строка `split.decided approved` журнала задачи от `human:panel`), карточка
 *     говорит «Запущены все задачи группы». Отрицательный — мутант «только задача 0»: красная
 *     строка «группа запущена».
 *
 * Запуск: `node tools/qa/check-core-group-launch.mjs` (стенд свой, `pnpm dev` не нужен; нужен
 * `claude` в PATH). `SHOTS=<dir>` — кадры раздела запуска (обе темы). Код выхода: 0 — сходится, 1 — провал,
 * 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { coreDirect, uuidv7 } from './core-scenario-stand.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const TIMELINE = join(dirname(fileURLToPath(import.meta.url)), 'check-core-timeline.mjs');
const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
const ITEMS = [
  { title: 'Файл один', body: 'Создать one.txt со строкой one.' },
  { title: 'Файл два', body: 'Создать two.txt со строкой two.' },
  { title: 'Файл три', body: 'Создать three.txt со строкой three.' },
];
const WAITING = new Set(['draft', 'estimating', 'awaiting-launch']);
/** Деление принято проверкой (или правкой человека) и ждёт утверждения человеком. */
const LAUNCHABLE = new Set(['accepted', 'edited']);
/**
 * Разведка сдаёт карту (иначе класса нет и вопроса класса тоже) и предлагает «M» — класс, при
 * котором форма задачи та же, что без карты: план идёт, деления «одна единица» ядро не ставит.
 */
const RESEARCH = {
  map: {
    lines: ['README.md — единственный файл репозитория стенда'],
    files: [{ path: 'README.md', why: 'stand file' }],
    tests: [],
    owners: [],
  },
  classProposal: 'M',
};
const intakeKey = (taskId) => `intake:${taskId}`;
const classKey = (taskId) => `classify:${taskId}`;
const SHOTS = process.env.SHOTS ?? '';

/** Кадр самого раздела запуска (обе темы), а не всей страницы: его вёрстку и смотрят. */
async function shootSection(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const section = page.locator('[data-launch-section="launch"]');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await section.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

// Стенд вырезает из PATH каталоги `claude`; дорога сессий идёт через настоящий CLI — его каталог
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

/** Вид задачи ядра через прокладку: состояние и решение по делению. */
async function taskState(stand, taskId) {
  const got = await stand.api(`/core/tasks/${encodeURIComponent(taskId)}`);
  const view = got.body?.view;
  const open = (view?.asks ?? []).filter((a) => a.state === 'open');
  return {
    taskId,
    state: view?.state ?? `http ${got.status}`,
    split: view?.split?.state ?? null,
    open,
    why: [view?.attention, ...open.map((a) => a.source)].filter(Boolean).join('+'),
  };
}

await runOnStand(
  {
    label: 'core-group-launch',
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
    seed: ({ root, coreHome }) => {
      // `classify` в `lead.alwaysAsk`: ведущий спрашивает класс — вопрос того же источника
      // `intake`, что и карточка, но не её; кнопка карточек группы обязана его не трогать.
      const configFile = join(coreHome, 'config.json');
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      config.lead = { defaults: { alwaysAsk: ['classify'] } };
      writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      repo = join(root, 'repo');
      mkdirSync(join(repo, '.agentdeck'), { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.name', 'stand']);
      git(repo, ['config', 'user.email', 'stand@example.invalid']);
      writeFileSync(join(repo, 'README.md'), 'stand\n');
      // Проверка в реестре репозитория: argv вне реестра ядро отклоняет (`not-registered`).
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
    /** Строки журнала задачи с диска одноразового ядра. */
    const journal = (taskId) => {
      const dir = join(stand.coreHome, 'tasks', taskId);
      const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
      return readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    };
    /** Кто утвердил деление — по журналу задачи (строка `split.decided approved`). */
    const humanApproval = (taskId) =>
      journal(taskId).find(
        (l) =>
          l.kind === 'split.decided' && l.data?.outcome === 'approved' && l.data?.by === 'human',
      )?.actor ?? 'нет';
    /**
     * Подтверждение карточки — по журналу задачи: ответ «Подтвердить карточку» на вопрос `intake`
     * (кто ответил) и принятая карточка `intake.card` человека с тем же вопросом.
     */
    const humanIntake = (taskId) => {
      const lines = journal(taskId);
      const asked = lines.find(
        (l) => l.kind === 'human.asked' && l.data?.dedupe === intakeKey(taskId),
      );
      const askId = asked?.data?.askId;
      const answer = lines.find(
        (l) =>
          l.kind === 'human.answered' &&
          l.data?.askId === askId &&
          l.data?.answer === 'Подтвердить карточку',
      );
      const card = lines.find(
        (l) => l.kind === 'intake.card' && l.data?.by === 'human' && l.data?.askId === askId,
      );
      return askId && answer && card ? answer.actor : 'нет';
    };
    const command = async (taskId, kind, fields) =>
      core.direct('POST', '/v1/commands', {
        cmdId: uuidv7(),
        kind,
        target: { taskId },
        fields,
        proof: await core.proof(),
      });

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { width: 1440, height: 4400 });
      await page.goto(`${stand.webUrl}/core/launch`);
      await page.locator('[data-core-launch-form]').waitFor({ timeout: 120_000 });
      const form = page.locator('[data-core-launch-form]');

      // ── оценка группой через форму ──────────────────────────────────────────────────────
      await form.getByLabel('Название', { exact: true }).fill('Группа: три файла');
      await form.getByLabel('Требования').fill('Создать три файла.');
      await form.getByLabel('Путь к репозиторию').fill(repo);
      // Пункты группы читает сценарий ведущего (снимок источника), `bug-fix` их отвергает.
      await form.getByLabel('Сценарий').selectOption('preset:lead');
      await form.getByLabel('Источник').selectOption('items');
      for (const [i, item] of ITEMS.entries()) {
        if (i > 0) await form.getByRole('button', { name: 'Добавить пункт' }).click();
        await form.getByLabel(`Название пункта ${i + 1}`).fill(item.title);
        await form.getByLabel(`Текст пункта ${i + 1}`).fill(item.body);
      }
      await form.getByLabel('Как запустить пункты').selectOption('group');
      const sent = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().includes('/api/core/estimate'),
        { timeout: 20_000 },
      );
      const answered = page.waitForResponse((r) => r.url().includes('/api/core/estimate'), {
        timeout: 180_000,
      });
      await page.locator('[data-estimate-button]').click();
      const request = await sent.catch(() => null);
      const response = await answered.catch(() => null);
      const reply = response ? await response.json().catch(() => null) : null;
      const kinds = (JSON.parse(request?.postData() ?? '{}').fields?.sources ?? []).map(
        (s) => s.kind,
      );
      const taskIds = reply?.group?.taskIds ?? [];
      if (
        !check(
          `оценка группой (${response?.status() ?? 'нет ответа'}): пункты ${kinds.join(', ')}, задач ${taskIds.length}`,
          kinds.length === ITEMS.length &&
            kinds.every((k) => k === 'group-item') &&
            taskIds.length === ITEMS.length,
          JSON.stringify(reply).slice(0, 600),
        )
      )
        return;

      // ── подготовка: маршрут-заглушка каждой задаче, все доходят до деления ─────────────────
      for (const id of taskIds) {
        const route = await command(id, 'set-route', {
          scope: 'task',
          scopeId: id,
          allowedRoutes: [
            { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
          ],
        });
        const model = await command(id, 'set-model', {
          scope: 'task',
          scopeId: id,
          model: 'stub-model',
          effort: null,
          timing: 'now',
        });
        if (route.body?.status !== 'applied' || model.body?.status !== 'applied')
          throw new Error(`маршрут/модель задачи ${id}: ${route.text} ${model.text}`);
      }
      // ── вопрос класса (`classify` в alwaysAsk): тот же источник `intake`, но не карточка ───────
      /** Открытый вопрос задачи с ключом `key(taskId)` — по виду задачи через прокладку панели. */
      const openBy = (s, key) => s.open.find((a) => a.dedupe === key(s.taskId));
      let states = [];
      for (let i = 0; i < 300; i++) {
        states = await Promise.all(taskIds.map((id) => taskState(stand, id)));
        if (states.every((s) => openBy(s, classKey) || openBy(s, intakeKey))) break;
        if (states.some((s) => s.state === 'failed' || s.state === 'cancelled')) break;
        await wait(1000);
      }
      const describe = (list) =>
        list
          .map(
            (s) => `${s.state}${s.open.length ? `/${s.open.map((a) => a.dedupe).join('+')}` : ''}`,
          )
          .join(', ');
      if (
        !check(
          `вид задачи несёт ключ вопроса: у каждой задачи открыт вопрос ведущего (${describe(states)})`,
          states.every((s) => openBy(s, classKey) || openBy(s, intakeKey)),
        )
      )
        return;
      const classOnly = states.filter((s) => openBy(s, classKey) && !openBy(s, intakeKey));
      if (classOnly.length > 0) {
        // Виды перечитываются каждые 1,5 с: за 6 с кнопка успела бы появиться, если бы считала
        // вопрос класса вопросом карточки.
        await page.waitForTimeout(6000);
        const shown = page.locator('[data-launch-intake-button]');
        const pending = (await shown.count())
          ? await shown.getAttribute('data-launch-intake-pending')
          : '0';
        check(
          `вопрос класса — не карточка: открыт у ${classOnly.length} задач, кнопка карточек ждёт ${pending} (надо ${taskIds.length - classOnly.length})`,
          Number(pending) === taskIds.length - classOnly.length,
          await page.locator('[data-launch-section="launch"]').innerText(),
        );
        // Что держит группу — названо: строка ответа о классе и ссылка на ленту каждой ждущей задачи.
        const classLine = page.locator(`[data-launch-class-wait="${classOnly.length}"]`);
        const waitText = (await classLine.count()) ? await classLine.innerText() : 'строки нет';
        const links = await classLine
          .locator('a[href^="/core?id="]')
          .evaluateAll((as) =>
            as.map((a) => decodeURIComponent(a.getAttribute('href').slice('/core?id='.length))),
          );
        check(
          `раздел запуска называет ожидание класса: «${waitText.split('\n')[0]}», ссылок на ленты ${links.length}`,
          waitText.includes(`Ждут вашего ответа о классе задачи — задач: ${classOnly.length}.`) &&
            classOnly.every((s) => links.includes(s.taskId)) &&
            links.length === classOnly.length,
          await page.locator('[data-launch-section="launch"]').innerText(),
        );
        await shootSection(page, 'group-intake-class-ask');
      }
      // Класс отвечает человек в ленте задачи; здесь — прямо в ядро, как подготовка.
      for (const s of states) {
        const ask = openBy(s, classKey);
        if (!ask) continue;
        const got = await command(s.taskId, 'answer', { askId: ask.askId, answer: 'M' });
        if (got.body?.status !== 'applied')
          throw new Error(`ответ класса задачи ${s.taskId}: ${got.text}`);
      }

      // ── карточки приёма: ведущий спрашивает каждую задачу, человек отвечает одной кнопкой ─────
      for (let i = 0; i < 300; i++) {
        states = await Promise.all(taskIds.map((id) => taskState(stand, id)));
        if (states.every((s) => openBy(s, intakeKey))) break;
        if (states.some((s) => s.state === 'failed' || s.state === 'cancelled')) break;
        await wait(1000);
      }
      if (
        !check(
          `каждая задача группы спрашивает карточку приёма (${describe(states)})`,
          states.every((s) => openBy(s, intakeKey)),
        )
      )
        return;
      const intakeButton = page.locator(
        `[data-launch-intake-button][data-launch-intake-pending="${taskIds.length}"]`,
      );
      const intakeReady = await intakeButton
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (
        !check(
          `кнопка «Подтвердить карточки группы: ${taskIds.length}» видна`,
          intakeReady,
          `ждут карточки: ${(await page.locator('[data-launch-intake]').count()) ? await page.locator('[data-launch-intake]').getAttribute('data-launch-intake') : 'блока нет'}`,
        )
      )
        return;
      await shootSection(page, 'group-intake-before');
      // Виды задач идут настоящие, только медленнее (сеть — внешняя граница): окно между ответом
      // ядра и перечитанным видом становится 1,2 с, а не миллисекунды гонки.
      const VIEW_GET = /\/api\/core\/tasks\/[0-9a-f-]{36}(\?|$)/;
      // Маршрут не снимается (`unroute` при задержанном запросе роняет его `continue`): после
      // проверки задержка просто выключается.
      let slow = true;
      const slowViews = async (route) => {
        if (slow && route.request().method() === 'GET') await wait(1200);
        await route.continue().catch(() => undefined);
      };
      await page.route(VIEW_GET, slowViews);
      await intakeButton.click();
      const done = page.locator('[data-launch-intake-done]');
      await done.waitFor({ timeout: 60_000 }).catch(() => undefined);
      const doneText = (await done.count()) ? await done.innerText() : 'нет строки исхода';
      // Строка исхода и число на кнопке — из одного обновления: «3 из 3» рядом со старой кнопкой
      // «Подтвердить карточки группы: 1» звала бы нажать ещё раз то, что уже подтверждено.
      const staleButton = await page.locator('[data-launch-intake-button]').count();
      check(
        'вместе с исходом «подтверждено всё» кнопки карточек уже нет',
        staleButton === 0,
        await page.locator('[data-launch-section="launch"]').innerText(),
      );
      slow = false;
      const intakeBy = taskIds.map((id) => humanIntake(id));
      check(
        `карточки группы подтверждены одним нажатием: в журнале каждой задачи ответ человека (${intakeBy.join(', ')}); «${doneText}»`,
        intakeBy.every((a) => a === 'human:panel') &&
          doneText.includes(`Подтверждено карточек: ${taskIds.length} из ${taskIds.length}`),
        await page.locator('[data-launch-section="launch"]').innerText(),
      );
      await shootSection(page, 'group-intake-after');

      for (let i = 0; i < 300; i++) {
        states = await Promise.all(taskIds.map((id) => taskState(stand, id)));
        if (states.every((s) => s.state === 'awaiting-launch' && LAUNCHABLE.has(s.split))) break;
        if (states.some((s) => s.state === 'failed' || s.state === 'cancelled')) break;
        // Задача ждёт ответа человека на другой вопрос — с этой проверки дальше не пойдёт.
        if (i > 60 && states.some((s) => s.open.some((a) => a.source !== 'launch'))) break;
        await wait(1000);
      }
      if (
        !check(
          `каждая задача группы ждёт запуска с принятым проверкой делением (${states.map((s) => `${s.state}/${s.split}${s.why ? `/${s.why}` : ''}`).join(', ')})`,
          states.every((s) => s.state === 'awaiting-launch' && LAUNCHABLE.has(s.split)),
        )
      )
        return;

      // ── доступ из ответа оценки подтверждается, как человеком ─────────────────────────────
      const pending = page.locator('[data-grant-row="pending"] [data-grant-confirm]');
      for (let n = await pending.count(); n > 0; n = await pending.count()) {
        await pending.first().click();
        await page.waitForTimeout(1500);
      }

      // ── одна кнопка — вся группа ────────────────────────────────────────────────────────
      const button = page.locator(
        `[data-launch-button][data-launch-group-size="${taskIds.length}"]`,
      );
      const ready = await button
        .and(page.locator(':enabled'))
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (
        !check(
          `кнопка «Запустить группу: задач ${taskIds.length}» доступна`,
          ready,
          (await page.locator('[data-launch-blockers]').getAttribute('data-launch-blockers')) ?? '',
        )
      )
        return;
      await shootSection(page, 'group-launch-before');
      await button.click();
      await page
        .locator('[data-launch-section="launch"] [role="status"], [data-launch-group]')
        .first()
        .waitFor({ timeout: 90_000 })
        .catch(() => undefined);
      const after = await Promise.all(
        taskIds.map(async (id) => ({ ...(await taskState(stand, id)), human: humanApproval(id) })),
      );
      const card = await page.locator('[data-launch-section="launch"]').innerText();
      check(
        `группа запущена: каждая задача вышла из ожидания, деление утвердил человек (${after.map((a) => `${a.state}/${a.human}`).join(', ')})`,
        after.every((a) => !WAITING.has(a.state) && a.human === 'human:panel'),
        card,
      );
      // Утверждение после `accepted` проверки — переход, а не «решено дважды»: вид задачи,
      // который читает панель, показывает `approved` (свёртка v13).
      check(
        `вид каждой задачи: деление утверждено (${after.map((a) => a.split).join(', ')})`,
        after.every((a) => a.split === 'approved'),
      );
      check(
        'карточка запуска: «Запущены все задачи группы»',
        card.includes(`Запущены все задачи группы: ${taskIds.length}`),
        card,
      );
      await shootSection(page, 'group-launch-after');

      // Задачи не доводятся до конца: стенд одноразовый, его снос снимает их вместе с ядром.
      for (const id of taskIds) await command(id, 'cancel', { reason: 'stand check over' });
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
