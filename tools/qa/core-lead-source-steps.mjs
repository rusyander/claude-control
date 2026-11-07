/**
 * Шаги источника «Задача трекера» для `check-core-lead-settings.mjs` (ревью W3-16): заглушка Jira
 * на loopback с тремя задачами, повторное чтение другой задачи, поздний ответ после смены ключа,
 * путь секрета из тикета через каждый выход и черновик ведения рядом с записью карточки MCP.
 *
 * Секреты заглушки — выдуманные строки, собранные во время прогона (литерал вида ключа вендора в
 * файле — то, что ловят сторожа секретов); в трекер настоящий не ходит ни один шаг.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const fake = (...parts) => parts.join('');

/** Выдуманные секреты тикета: каждый — форма, которую ловит общий детектор `@agentdeck/dlp`. */
export const PLANTED = {
  vendor: fake('gh', 'p_', 'Zq8Lw2Nx4Vb6Mc1Kd3Fg5Hj7Pr9St0Uy2We4'),
  db: fake('S3cret', 'Passw0rd', 'Qa'),
  header: fake('Qa', 'Planted', '9f8e7d6c5b4aZz'),
  bearer: fake('Qa', 'Planted', 'BearerTok3n987'),
};

const issue = (key, summary, description, ac) => ({
  key,
  fields: {
    summary,
    description,
    status: { name: 'В работе', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['report'],
    updated: '2026-11-05T10:00:00.000+0000',
    customfield_10042: ac,
  },
  names: { customfield_10042: 'Acceptance Criteria' },
});

/** Задачи заглушки: обычная, с секретами в каждом тексте и медленная (ответ через 2,5 с). */
export const ISSUES = {
  plain: issue(
    'PROJ-12',
    'Кнопка экспорта в отчёте',
    'Добавить кнопку экспорта CSV на странице отчёта.',
    '- Кнопка видна на странице отчёта\n- Файл CSV содержит все строки',
  ),
  secret: issue(
    'PROJ-13',
    `Вход падает, ключ ${PLANTED.vendor}`,
    `Строка базы postgres://admin:${PLANTED.db}@db.local/app, ${fake('api', '_key')}=${PLANTED.header}.`,
    `- Заголовок Authorization: Bearer ${PLANTED.bearer} принят\n- Вход проходит`,
  ),
  slow: issue('PROJ-14', 'Медленная задача', 'Ответ трекера приходит поздно.', '- Пришло'),
};

const SLOW_MS = 2_500;

/** Заглушка Jira своей установки (`/rest/api/2`, Bearer): задачи из `ISSUES`, прочее — 404. */
export function startJiraStub() {
  const calls = [];
  const byPath = new Map(Object.values(ISSUES).map((i) => [`/rest/api/2/issue/${i.key}`, i]));
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? '/', 'http://stub');
    const found = byPath.get(url.pathname);
    const send = () => {
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ?? { errorMessages: ['Issue does not exist'] }));
    };
    if (found === ISSUES.slow) setTimeout(send, SLOW_MS);
    else send();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const flat = (text) => text.replace(/\s+/g, ' ');

/** Прочитать ключ: дождаться ответа маршрута снимка по этому ключу и кадра после него. */
async function readKey(page, form, key) {
  await form.getByLabel('Ключ задачи трекера').fill(key);
  const answered = page.waitForResponse(
    (r) => r.url().includes('/core-intake/tracker-snapshot') && r.url().includes(key),
    { timeout: 20_000 },
  );
  await form.locator('[data-source-tracker-read]').click();
  await answered.catch(() => undefined);
  await page.waitForTimeout(300);
}

/**
 * Повторное чтение: PROJ-12 заполнил пустые название и требования, другой ключ PROJ-13 — они
 * от PROJ-13 (правок человека нет). Поздний ответ: чтение PROJ-14, ключ сменён до ответа — снимок
 * PROJ-14 не ложится под чужой ключ и не пишет своё название в форму.
 */
export async function checkTrackerReRead(page, form, check) {
  await form.getByLabel('Источник').selectOption('tracker');
  await form.getByLabel('Название', { exact: true }).fill('');
  await form.getByLabel('Требования').fill('');
  await readKey(page, form, ISSUES.plain.key);
  const title = () => form.getByLabel('Название', { exact: true }).inputValue();
  const request = () => form.getByLabel('Требования').inputValue();
  check(
    `снимок ${ISSUES.plain.key} заполнил пустое название (${await title()})`,
    (await title()) === ISSUES.plain.fields.summary,
  );
  await readKey(page, form, ISSUES.secret.key);
  const second = { title: await title(), request: await request() };
  check(
    `другой ключ: название и требования — от ${ISSUES.secret.key}, не от ${ISSUES.plain.key} (${flat(second.title).slice(0, 24)}…)`,
    second.title === ISSUES.secret.fields.summary &&
      second.request === ISSUES.secret.fields.description,
  );
  await form.getByLabel('Ключ задачи трекера').fill(ISSUES.slow.key);
  await form.locator('[data-source-tracker-read]').click();
  await form.getByLabel('Ключ задачи трекера').fill(ISSUES.secret.key);
  await page.waitForTimeout(SLOW_MS + 1_500);
  const stale = await form.locator('[data-source-snapshot]').count();
  const lateTitle = await title();
  check(
    `поздний ответ ${ISSUES.slow.key} после смены ключа не лёг (снимков ${stale}, название «${flat(lateTitle).slice(0, 24)}»)`,
    stale === 0 && lateTitle !== ISSUES.slow.fields.summary,
  );
  await readKey(page, form, ISSUES.secret.key);
}

/** Строки потока событий задачи до решения `intake` (тот же поток, что читает лента панели). */
export async function eventsUntilIntake(page, taskId) {
  return page.evaluate(
    async ({ id }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      let buf = '';
      try {
        const res = await fetch(`/api/core/tasks/${encodeURIComponent(id)}/events`, {
          signal: ctrl.signal,
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return { text: buf, intake: null };
          buf += decoder.decode(value, { stream: true });
          for (const line of buf.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const row = JSON.parse(line.slice(5));
              for (const r of Array.isArray(row) ? row : [row])
                if (r?.kind === 'decision' && r.data?.class === 'intake')
                  return { text: buf, intake: r.data.output };
            } catch {
              // строка ещё не дочитана — ждём следующий кусок
            }
          }
        }
      } catch {
        return { text: buf, intake: null };
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
    },
    { id: taskId },
  );
}

/** Файлы под каталогом (без `node_modules`), до 5 МБ, где есть хоть один секрет. */
function filesWithSecret(dir, secrets, depth = 0, out = []) {
  if (depth > 8 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') filesWithSecret(path, secrets, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || statSync(path).size > 5_000_000) continue;
    const text = readFileSync(path, 'utf8');
    if (secrets.some((s) => text.includes(s))) out.push(path);
  }
  return out;
}

/**
 * Секрет тикета на каждом выходе (P61): панель отдаёт снимок своему человеку как есть, ядро —
 * ни в ответе оценки, ни в списке и виде задач, ни в потоке событий, ни в одном файле стенда, ни
 * в журналах процессов. `estimate` — оценка с текстом из снимка (название и требования не набраны).
 */
export async function checkTrackerSecrets({ page, stand, check, estimate }) {
  const secrets = Object.values(PLANTED);
  const leaked = (value) => secrets.filter((s) => JSON.stringify(value ?? '').includes(s));
  const shown = await page
    .locator('[data-source-snapshot]')
    .innerText()
    .catch(() => '');
  check(`снимок ${ISSUES.secret.key} виден человеку на форме`, shown.includes(ISSUES.secret.key));
  const sent = await estimate();
  const body = JSON.parse(sent.request?.postData() ?? '{}');
  check(
    `оценка (${sent.label}) несёт снимок ${body.fields?.source?.key} и текст формы из него`,
    body.fields?.source?.key === ISSUES.secret.key &&
      body.fields?.request === ISSUES.secret.fields.description &&
      sent.status === 202,
  );
  check(
    `ответ оценки без секретов (${leaked(sent.reply).length})`,
    leaked(sent.reply).length === 0,
  );
  const taskId = sent.reply?.taskId ?? '';
  const events = taskId ? await eventsUntilIntake(page, taskId) : { text: '', intake: null };
  check(
    `поток событий до решения intake без секретов (решение ${events.intake ? 'есть' : 'нет'}, утечек ${leaked(events.text).length})`,
    Boolean(events.intake) && leaked(events.text).length === 0,
  );
  const listed = await stand.api('/core/tasks');
  check(
    `список задач без секретов (${listed.status}, ${leaked(listed.body).length})`,
    listed.status === 200 && leaked(listed.body).length === 0,
  );
  const view = taskId ? await stand.api(`/core/tasks/${encodeURIComponent(taskId)}`) : null;
  check(
    `вид задачи без секретов (${view?.status}, ${leaked(view?.body).length})`,
    view?.status === 200 && leaked(view.body).length === 0,
  );
  const files = filesWithSecret(stand.root, secrets);
  check(
    `ни один файл стенда не держит секрет тикета (${files.length})`,
    files.length === 0,
    files.join('\n'),
  );
  const logs = `${stand.log()}\n${stand.coreLog()}`;
  check(`журналы панели и ядра без секретов (${leaked(logs).length})`, leaked(logs).length === 0);
}

/**
 * «Несколько пунктов» группой (W3-18 через форму): те же пункты уходят видом `group-item`, ни
 * одного другого вида (смесь ядро отвергает); ядро ставит задачу на пункт с одним `groupId`, список
 * задач ядра по этому `groupId` называет все; оценка показывает группу и ссылку на каждую задачу.
 * Пункты уже на форме (шаг «одной задачей» перед этим), после шага выбор возвращается к «одной».
 */
export async function checkItemsAsGroup({ page, form, stand, check, estimate, items }) {
  await form.getByLabel('Как запустить пункты').selectOption('group');
  const sent = await estimate('Ведущий: пункты группой');
  const body = JSON.parse(sent.request?.postData() ?? '{}');
  const kinds = (body.fields?.sources ?? []).map((s) => s.kind);
  check(
    `группой: в оценку ушли только пункты группы (${sent.label}): ${kinds.join(', ')}`,
    kinds.length === items.length && kinds.every((k) => k === 'group-item'),
  );
  const group = sent.reply?.group;
  const groupId = group?.groupId ?? '';
  const listed = groupId
    ? await stand.api(`/core/tasks?groupId=${encodeURIComponent(groupId)}`)
    : { status: 0, body: null };
  const tasks = listed.body?.tasks ?? [];
  check(
    `группой: задач ${tasks.length} с одной группой ${groupId} (ответ ${group?.taskIds?.length ?? 0}, список ${listed.status})`,
    groupId.startsWith('group-') &&
      group.taskIds.length === items.length &&
      tasks.length === items.length &&
      tasks.every((t) => t.groupId === groupId) &&
      tasks
        .map((t) => t.taskId)
        .sort()
        .join() === [...group.taskIds].sort().join(),
  );
  const links = page.locator('[data-estimate-group] [data-estimate-group-task] a');
  await links
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  check(
    `оценка группы называет каждую задачу ссылкой на ленту (${hrefs.length})`,
    hrefs.length === items.length &&
      hrefs.every((h, i) => h === `/core?id=${encodeURIComponent(group?.taskIds?.[i] ?? '')}`),
  );
  // Кнопка запуска называет группу; запуск всех задач — на стенде с моделью (check-core-group-launch).
  const size = await page
    .locator('[data-launch-button]')
    .getAttribute('data-launch-group-size')
    .catch(() => null);
  check(`кнопка запуска — для всей группы (задач ${size})`, size === String(items.length));
  await form.getByLabel('Как запустить пункты').selectOption('one');
}

/** «Сбросить» карточки ведения, если правка есть (кнопки без правки нет). */
async function resetLead(card) {
  const reset = card.locator('[data-lead-reset]');
  if ((await reset.count()) > 0) await reset.click();
}

/**
 * Правка уровня ведения руками (область машины, без записи): унаследованный профиль можно
 * закрепить за областью нажатием на уже отмеченный; число набирается по знаку — пустое поле не
 * откатывается к унаследованному, «0.» не теряет точку.
 */
export async function checkLeadEditing(card, check) {
  await resetLead(card);
  const save = card.locator('[data-lead-save]');
  const inherited = card.locator('[data-lead-profile="balanced"]');
  const wasChecked = await inherited.isChecked();
  await inherited.click();
  const pinned = await save.isEnabled();
  check(
    `унаследованный профиль закрепляется за областью (отмечен ${wasChecked}, «Сохранить» ${pinned})`,
    wasChecked && pinned,
  );
  await resetLead(card);
  const parallel = card.locator('[data-lead-parallelism] input');
  await parallel.click();
  await parallel.press('Control+A');
  await parallel.press('Backspace');
  const cleared = await parallel.inputValue();
  await parallel.pressSequentially('3');
  const typed = await parallel.inputValue();
  const threshold = card.locator('[data-lead-promotion-threshold] input');
  await threshold.click();
  await threshold.press('Control+A');
  await threshold.pressSequentially('0.5');
  const decimal = await threshold.inputValue();
  await threshold.blur();
  check(
    `числа набираются по знаку: пустое «${cleared}», затем «${typed}»; порог «${decimal}»`,
    cleared === '' && typed === '3' && decimal === '0.5',
  );
  await resetLead(card);
}

/** Правка после записи снимает «Сохранено»: оно было про записанное, а не про то, что на экране. */
export async function checkSavedClearsOnEdit(card, check) {
  const shown = await card.locator('[data-lead-saved]').count();
  await card.locator('[data-lead-profile="max-quality"]').click();
  const after = await card.locator('[data-lead-saved]').count();
  await resetLead(card);
  check(
    `правка после записи снимает «Сохранено» (было ${shown}, стало ${after})`,
    shown === 1 && after === 0,
  );
}

/**
 * Ответ на перечитывание настройки ядра после записи (статус; 0 — не было). Проверка карточек
 * ждёт именно его: сброс черновика случается на новом чтении, а не через сколько-то секунд.
 */
function configReread(page) {
  return page
    .waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/core/config',
      { timeout: 20_000 },
    )
    .then((r) => r.status())
    .catch(() => 0);
}

/**
 * Две карточки блока «Ведение задачи» пишут одну настройку: запись выбора MCP не сбрасывает
 * несохранённый профиль ведения (правка чужого раздела — не правка уровня ведения).
 */
export async function checkDraftKeptAcrossCards(block, card, check) {
  const mcp = block.locator('[data-launch-section="mcp-picks"]');
  const pick = mcp.locator('[data-mcp-pick="chat:probe"]');
  const ready = await pick
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!check('карточка MCP предлагает сервер probe стенда', ready)) return;
  await card.locator('[data-lead-profile="max-quality"]').check();
  await pick.click();
  const reread = configReread(card.page());
  await mcp.locator('[data-mcp-picks-save]').click();
  const saved = await mcp
    .locator('[data-mcp-picks-saved]')
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const refetched = await reread;
  await card.page().waitForTimeout(500);
  const kept = await card.locator('[data-lead-profile="max-quality"]').isChecked();
  const savable = await card.locator('[data-lead-save]').isEnabled();
  check(
    `запись MCP (${saved ? 'принята' : 'нет'}, настройка перечитана ${refetched}) не сбросила несохранённый профиль ведения (отмечен ${kept}, «Сохранить» ${savable})`,
    saved && refetched === 200 && kept && savable,
  );
  await card.locator('[data-lead-profile="balanced"]').check();
}

/**
 * Обратная сторона: несохранённая отметка MCP переживает запись ведения (область проекта, чтобы
 * умолчания машины остались нетронутыми). Шаг последний — после него стенд только закрывается.
 */
export async function checkPicksKeptAcrossCards(block, card, check) {
  const mcp = block.locator('[data-launch-section="mcp-picks"]');
  const pick = mcp.locator('[data-mcp-pick="chat:probe"]');
  const before = await pick.isChecked();
  await pick.click();
  const next = card.locator('[data-lead-profile="max-quality"]');
  await ((await next.isChecked()) ? card.locator('[data-lead-profile="balanced"]') : next).check();
  const reread = configReread(card.page());
  await card.locator('[data-lead-save]').click();
  const saved = await card
    .locator('[data-lead-saved]')
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const refetched = await reread;
  await card.page().waitForTimeout(500);
  const after = await pick.isChecked();
  check(
    `запись ведения (${saved ? 'принята' : 'нет'}, настройка перечитана ${refetched}) не сбросила несохранённую отметку MCP (было ${before}, стало ${after})`,
    saved && refetched === 200 && after === !before,
  );
}
