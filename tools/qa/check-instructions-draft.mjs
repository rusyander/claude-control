/**
 * Черновик файла инструкций проекта не врёт про «не сохранено» и не прячет
 * чужую запись (ревью 28.09: F-90, F-91).
 *
 * - Claude (`CLAUDE.md` проекта): после сохранения черновик снят — запись,
 *   сделанная потом мимо панели (агент, редактор), доходит до редактора, и
 *   «Сохранить» не возвращает старое поверх неё. Правка поверх чужой записи
 *   остаётся цела, а страница говорит словами, что файл изменился вне панели;
 *   «Отменить правки» показывает новый текст.
 * - Прочий CLI (`AGENTS.md` у Codex): файл с CRLF не горит «не сохранено» от
 *   набранной и стёртой буквы и после своего сохранения; внешняя запись после
 *   сохранения доходит до редактора.
 *
 * Файл на диске — подмена в памяти прогона: PUT кладёт присланный текст с
 * CRLF, как его сохранил бы сервер на Windows. Реестр проектов, файл проекта
 * и сведения о провайдере подменены; любая иная запись (не GET) до сервера не
 * доходит, настройки подменяются только в ответе этой вкладке — конфигурация
 * человека не трогается. «Запись мимо панели» — смена файла в подмене и
 * переподключение потока изменений (так панель и узнаёт о том, что было без неё).
 *
 * Запуск: `node tools/qa/check-instructions-draft.mjs` при поднятом `pnpm dev`
 * (`APP_URL`, по умолчанию http://localhost:8888). `--only claude,provider,image,switch`.
 *
 * - image (F-21): картинка в файле инструкций не грузится — вместо неё ссылка.
 * - switch (F-299): черновик у каждого проекта свой, смена проекта щелчком.
 * `SHOTS=<каталог>` — кадры этих двух сценариев.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(',')) : undefined;
const wants = (name) => !only || only.has(name);

let ok = 0;
const failures = [];
const check = (pass, label, seen = '') => {
  console.log(`${pass ? 'ок  ' : 'FAIL'} ${label}${seen ? ` — видно: ${seen}` : ''}`);
  if (pass) ok += 1;
  else failures.push(label);
};

const PROJECT = { id: 'qa-draft-project', name: 'QA черновик', path: 'C:/qa-draft-project' };
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
const UNSAVED = 'есть несохранённые правки';
const ELSEWHERE = /изменился вне панели/;

/** Поток `/api/events` подменён: прогон сам «переподключает» его. */
const pageStubs = () => {
  const sources = [];
  class QaEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      sources.push(this);
      setTimeout(() => this.onopen?.(new Event('open')), 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = QaEventSource;
  // Переподключение после обрыва: панель перечитывает всё, что могло
  // измениться без неё.
  window.__qaReopen = () => {
    for (const source of sources) {
      if (source.readyState === 1) source.onopen?.(new Event('open'));
    }
  };
};

const browser = await chromium.launch();

/** Вкладка с подменами; `file` — состояние файла на «диске». */
const openScenario = async (provider, file) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(pageStubs);
  // Сокет горячей перезагрузки Vite: правка чужого файла на стенде иначе
  // перезагружала бы страницу посреди сценария.
  const appPort = new URL(BASE).port;
  await context.routeWebSocket(
    (url) => url.port === appPort && url.pathname === '/',
    () => undefined,
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
  // Сторож записи ставится первым: последняя подмена отвечает первой, и он
  // видит только то, что прочие отдали дальше.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    file.blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route
      .fulfill({ status: 501, json: { error: 'qa: запись закрыта' } })
      .catch(() => undefined);
  });
  await bypassOnboarding(page, { provider });
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [PROJECT] }).catch(() => undefined)
      : route.fallback(),
  );
  const answer = () =>
    provider === 'claude'
      ? {
          content: file.content,
          fileName: 'CLAUDE.md',
          filePath: `${PROJECT.path}/CLAUDE.md`,
          instructionFiles: {
            mode: 'claude-md-or-agents-md',
            source: 'default',
            read: [],
            ignored: [],
            choices: ['CLAUDE.md'],
            proposed: false,
            notes: [],
          },
        }
      : {
          content: file.content,
          exists: true,
          fileName: 'AGENTS.md',
          filePath: `${PROJECT.path}/AGENTS.md`,
          providerId: 'codex',
          providerName: 'Codex',
        };
  const filePath =
    provider === 'claude'
      ? `/api/projects/${PROJECT.id}/rules`
      : `/api/projects/${PROJECT.id}/provider/instructions`;
  await page.route(`**${filePath}`, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: answer() }).catch(() => undefined);
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      file.puts.push(body.content);
      file.content = crlf(body.content);
      return route.fulfill({ json: { ok: true } }).catch(() => undefined);
    }
    return route.fallback();
  });
  if (provider !== 'claude') {
    await page.route(`**/api/projects/${PROJECT.id}/provider`, (route) =>
      route
        .fulfill({
          json: {
            providerId: 'codex',
            providerName: 'Codex',
            projectPath: PROJECT.path,
            sections: ['instructions'],
            instructionsFileName: 'AGENTS.md',
            instructionsPath: `${PROJECT.path}/AGENTS.md`,
          },
        })
        .catch(() => undefined),
    );
  }
  await page.goto(`${BASE}/projects?id=${PROJECT.id}`);
  return { page, context, filePath };
};

const editorText = (page) => page.locator('.cm-content').first().innerText();
const unsavedShown = (page) => page.getByText(UNSAVED).isVisible();
const settle = (page) => page.waitForTimeout(700);
/** Ждёт, пока файл перечитан после записи или переподключения. */
const reread = (page, filePath) =>
  page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === filePath && response.request().method() === 'GET',
      { timeout: 10_000 },
    )
    .then(() => settle(page))
    .catch(() => undefined);
const typeAtEnd = async (page, text) => {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
};
const externalWrite = async (page, file, filePath, text) => {
  file.content = crlf(text);
  const done = reread(page, filePath);
  await page.evaluate(() => window.__qaReopen());
  await done;
};
const save = async (page, filePath) => {
  const done = reread(page, filePath);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await done;
};

if (wants('claude')) {
  console.log('\n— Claude: CLAUDE.md проекта');
  const file = { content: crlf('Первая строка\nВторая строка\n'), puts: [], blocked: [] };
  const { page, context, filePath } = await openScenario('claude', file);
  await page.getByRole('button', { name: 'Править', exact: true }).click();
  await page.locator('.cm-content').first().waitFor({ timeout: 15_000 });

  await typeAtEnd(page, 'Своя правка');
  check(await unsavedShown(page), 'набранное отмечено как несохранённое');
  await save(page, filePath);
  check(file.puts.length === 1, 'сохранение ушло одной записью', String(file.puts.length));
  check(!(await unsavedShown(page)), 'после сохранения (диск вернул CRLF) — «не сохранено» нет');

  await externalWrite(page, file, filePath, 'Записал агент\n');
  check(
    (await editorText(page)).includes('Записал агент'),
    'запись мимо панели после сохранения дошла до редактора',
    (await editorText(page)).slice(0, 60),
  );
  check(!(await unsavedShown(page)), 'после чужой записи «не сохранено» не горит');
  check(!(await page.getByText(ELSEWHERE).isVisible()), 'без своих правок расхождения не показано');

  await typeAtEnd(page, ' и моя строка');
  await externalWrite(page, file, filePath, 'Второй раз записал агент\n');
  check(
    (await editorText(page)).includes('и моя строка'),
    'набранное поверх чужой записи цело',
    (await editorText(page)).slice(0, 60),
  );
  check(await page.getByText(ELSEWHERE).isVisible(), 'сказано, что файл изменился вне панели');
  check(await unsavedShown(page), 'правка по-прежнему несохранённая');
  await page.getByRole('button', { name: 'Отменить правки', exact: true }).click();
  await settle(page);
  check(
    (await editorText(page)).includes('Второй раз записал агент'),
    '«Отменить правки» показывает новый текст с диска',
    (await editorText(page)).slice(0, 60),
  );
  check(!(await page.getByText(ELSEWHERE).isVisible()), 'после отмены расхождения нет');
  check(file.puts.length === 1, 'чужая запись ни разу не перезаписана', String(file.puts.length));
  check(file.blocked.length === 0, 'иных записей не было', file.blocked.join(', '));
  await context.close();
}

if (wants('provider')) {
  console.log('\n— Codex: AGENTS.md проекта');
  const file = { content: crlf('Строка один\nСтрока два\n'), puts: [], blocked: [] };
  const { page, context, filePath } = await openScenario('codex', file);
  await page.getByRole('button', { name: 'Править', exact: true }).click();
  await page.locator('.cm-content').first().waitFor({ timeout: 15_000 });

  await typeAtEnd(page, 'Q');
  await page.keyboard.press('Backspace');
  await settle(page);
  check(!(await unsavedShown(page)), 'набранная и стёртая буква не оставляет «не сохранено»');

  await typeAtEnd(page, 'Правка');
  check(await unsavedShown(page), 'настоящая правка отмечена');
  await save(page, filePath);
  check(file.puts.length === 1, 'сохранение ушло одной записью', String(file.puts.length));
  check(!(await unsavedShown(page)), 'после сохранения (диск вернул CRLF) — «не сохранено» нет');

  await externalWrite(page, file, filePath, 'Записал агент в AGENTS\n');
  check(
    (await editorText(page)).includes('Записал агент в AGENTS'),
    'запись мимо панели после сохранения дошла до редактора',
    (await editorText(page)).slice(0, 60),
  );
  check(!(await unsavedShown(page)), 'после чужой записи «не сохранено» не горит');
  check(file.blocked.length === 0, 'иных записей не было', file.blocked.join(', '));
  await context.close();
}

if (wants('image')) {
  // F-21: картинка в чужом CLAUDE.md — не повод панели идти по её адресу.
  // Открытая вкладка тянула бы пиксель со стороннего сервера (IP, время).
  console.log('\n— Картинка в файле инструкций');
  const file = {
    content: crlf('# Проект\n\n![пиксель](https://tracker.example.com/pixel.png)\n'),
    puts: [],
    blocked: [],
  };
  const { page, context } = await openScenario('claude', file);
  const fetched = [];
  await page.route('**/tracker.example.com/**', (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ status: 204 }).catch(() => undefined);
  });
  const preview = page.getByRole('article', { name: /CLAUDE\.md/ });
  await preview.waitFor({ timeout: 15_000 });
  await settle(page);
  const images = await preview.locator('img').count();
  check(images === 0, 'в просмотре нет <img>', String(images));
  check(fetched.length === 0, 'адрес картинки не запрошен', fetched.join(', '));
  const link = preview.getByRole('link', { name: 'пиксель' });
  check(
    (await link.count()) === 1 &&
      (await link.getAttribute('href')) === 'https://tracker.example.com/pixel.png',
    'вместо картинки — ссылка с её подписью',
    String(await link.count()),
  );
  if (process.env.SHOTS) await preview.screenshot({ path: `${process.env.SHOTS}/F-21-image.png` });
  await context.close();
}

if (wants('switch')) {
  // F-299: черновик у каждого проекта свой. Правка во втором проекте не
  // выбрасывает несохранённое в первом; смена проекта — щелчком по списку, как
  // это делает человек (переход по адресу создал бы страницу заново).
  console.log('\n— Два проекта: черновик у каждого свой');
  const other = { id: 'qa-draft-project-b', name: 'QA черновик Б', path: 'C:/qa-draft-project-b' };
  const files = {
    [PROJECT.id]: crlf('Файл проекта А\n'),
    [other.id]: crlf('Файл проекта Б\n'),
  };
  const file = { content: files[PROJECT.id], puts: [], blocked: [] };
  const { page, context } = await openScenario('claude', file);
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [PROJECT, other] }).catch(() => undefined)
      : route.fallback(),
  );
  await page.route(`**/api/projects/${other.id}/rules`, (route) =>
    route.request().method() === 'GET'
      ? route
          .fulfill({
            json: {
              content: files[other.id],
              fileName: 'CLAUDE.md',
              filePath: `${other.path}/CLAUDE.md`,
              instructionFiles: {
                mode: 'claude-md-or-agents-md',
                source: 'default',
                read: [],
                ignored: [],
                choices: ['CLAUDE.md'],
                proposed: false,
                notes: [],
              },
            },
          })
          .catch(() => undefined)
      : route.fallback(),
  );
  await page.reload();
  const edit = async () => {
    const button = page.getByRole('button', { name: 'Править', exact: true });
    await page
      .getByRole('button', { name: /^(Просмотр|Править)$/ })
      .first()
      .waitFor({ timeout: 15_000 });
    if (await button.isVisible()) await button.click();
    await page.locator('.cm-content').first().waitFor({ timeout: 15_000 });
  };
  const open = async (project) => {
    await page
      .getByRole('button', { name: new RegExp(project.name) })
      .first()
      .click();
    await settle(page);
  };

  await open(PROJECT);
  await edit();
  await typeAtEnd(page, 'Черновик А');
  check(await unsavedShown(page), 'правка в А отмечена');
  await open(other);
  await edit();
  check(
    (await editorText(page)).includes('Файл проекта Б'),
    'у Б — его файл, не черновик А',
    (await editorText(page)).slice(0, 60),
  );
  await typeAtEnd(page, 'Черновик Б');
  await open(PROJECT);
  await edit();
  check(
    (await editorText(page)).includes('Черновик А'),
    'после правки в Б черновик А на месте',
    (await editorText(page)).slice(0, 60),
  );
  check(await unsavedShown(page), 'у А по-прежнему «не сохранено»');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/F-299-switch.png` });
  await open(other);
  await edit();
  check(
    (await editorText(page)).includes('Черновик Б'),
    'и черновик Б на месте',
    (await editorText(page)).slice(0, 60),
  );
  check(file.puts.length === 0, 'ничего не сохранялось', String(file.puts.length));
  check(file.blocked.length === 0, 'иных записей не было', file.blocked.join(', '));
  await context.close();
}

await browser.close();
console.log(`\nок: ${ok}, плохо: ${failures.length}`);
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
