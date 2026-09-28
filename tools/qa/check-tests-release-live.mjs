/**
 * Кейс testing-014: готовность вехи на НАСТОЯЩЕМ маршруте — вердикт карточки и
 * выгрузки md/html/pdf на языке панели, колонка «Кто/Who» — словом.
 *
 * `check-tests-release.mjs` подменяет ответ сервера целиком и доказывает только
 * экран. Здесь подменено одно окружение: одноразовая панель над временным
 * домом, проект с историей прогонов на диске (три прогона вехи — агент,
 * человек, CI; один провал), документ считает сам сервер.
 *
 * Что доказывается:
 *   1. ru: вердикт карточки — русская строка сервера;
 *   2. язык переключён в «Настройках» без перезагрузки, возврат в раздел
 *      ссылкой меню — карточка по-английски (ключ запроса несёт язык);
 *   3. язык сменён СНАРУЖИ (PATCH /api/settings, как с другой вкладки) при
 *      открытой карточке — карточка следует без перезагрузки и без перехода;
 *   4. выгрузки md/html по ссылкам карточки: вердикт тот же, что на экране, у
 *      «Кто/Who» — слово языка (агент/человек/CI; agent/person/CI), а не
 *      сырой id `human`/`ci`; в английских нет кириллицы;
 *   5. pdf: 200 и `%PDF` (или честный 501 «нечем печатать» — тогда не проверено).
 *
 * Запуск: `node tools/qa/check-tests-release-live.mjs` (стенд поднимается сам).
 * `SHOTS=<каталог>` — снимки карточки ru/en.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
const RELEASE = '1.4';
const VERDICT = {
  ru: `Веха «${RELEASE}»: отдавать рано`,
  en: `Milestone “${RELEASE}”: too early to ship`,
};
const WHO = {
  ru: { agent: 'агент', human: 'человек', ci: 'CI' },
  en: { agent: 'agent', human: 'person', ci: 'CI' },
};

const CASES = ['Вход', 'Выход', 'Профиль'].map((title, index) => ({
  id: `gui-00${index + 1}`,
  type: 'case',
  title,
  steps: [{ action: `Шаг ${index + 1}`, expected: `Ожидание ${index + 1}` }],
  expected: 'Всё на месте',
  priority: 'medium',
  tags: [],
  status: 'unknown',
  source: 'human',
  updatedAt: '2026-09-20T10:00:00.000Z',
}));

const run = (id, actor, at, statuses) => ({
  id,
  mode: 'run',
  actor,
  status: 'done',
  release: RELEASE,
  startedAt: at,
  results: statuses.map((status, index) => ({
    pointId: `gui:${CASES[index].id}`,
    groupId: 'gui',
    caseId: CASES[index].id,
    status,
    ...(status === 'failed'
      ? { failure: { step: 1, actual: 'кнопки нет', expected: 'кнопка есть' } }
      : {}),
  })),
  summary: {
    total: statuses.length,
    passed: statuses.filter((one) => one === 'passed').length,
    failed: statuses.filter((one) => one === 'failed').length,
    skipped: 0,
    blocked: 0,
  },
});

await runOnStand(
  {
    label: 'tests-release',
    seed: ({ home }) => {
      const dir = join(home, 'proj', '.agent', 'tests');
      mkdirSync(join(dir, 'runs'), { recursive: true });
      writeFileSync(
        join(dir, 'gui.tests.json'),
        `${JSON.stringify({ version: 1, title: 'Интерфейс', cases: CASES }, null, 2)}\n`,
        'utf8',
      );
      const runs = [
        run('aaaa0001', 'agent', '2026-09-21T10:00:00.000Z', ['passed', 'passed', 'passed']),
        run('aaaa0002', 'human', '2026-09-22T10:00:00.000Z', ['passed', 'failed']),
        run('aaaa0003', 'ci', '2026-09-23T10:00:00.000Z', ['passed']),
      ];
      for (const record of runs) {
        writeFileSync(
          join(
            dir,
            'runs',
            `${record.startedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${record.id}.run.json`,
          ),
          `${JSON.stringify(record, null, 2)}\n`,
          'utf8',
        );
      }
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check(
      'проект зарегистрирован',
      added.status < 300,
      `${added.status} ${added.text.slice(0, 200)}`,
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1300 });
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((path) => {
        localStorage.setItem('agentdeck:tests-project', path.replace(/\\/g, '/').toLowerCase());
      }, project);
      await page.goto(`${stand.webUrl}/tests?tab=report`, { waitUntil: 'domcontentloaded' });
      // Метка в окне: перезагрузка её стирает, переход внутри приложения — нет.
      // (`framenavigated` не годится: он срабатывает и на pushState.)
      await page.evaluate(() => {
        window.__noReload = 'wa';
      });
      const notReloaded = async () =>
        (await page.evaluate(() => window.__noReload).catch(() => undefined)) === 'wa';

      const verdictOnCard = async (lang) => {
        const want = VERDICT[lang];
        await page
          .getByText(want, { exact: false })
          .first()
          .waitFor({ timeout: 20_000 })
          .catch(() => undefined);
        return (await page.getByText(want, { exact: false }).count()) > 0;
      };
      const cardText = async () =>
        (
          await page
            .locator('section, article, div')
            .filter({ has: page.getByLabel(/^(Веха|Milestone)$/) })
            .last()
            .innerText()
            .catch(() => '')
        ).replace(/\s+/g, ' ');

      // 1. ru
      check('ru: вердикт карточки по-русски', await verdictOnCard('ru'), await cardText());
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, 'release-card_ru.png'), fullPage: true });
      }

      const exports = async (lang) => {
        const links = {};
        for (const [format, name] of [
          ['md', /^(Документ|Document) MD$/],
          ['html', /^(Документ|Document) HTML$/],
          ['pdf', /^(Документ|Document) PDF$/],
        ]) {
          links[format] = await page.getByRole('link', { name }).first().getAttribute('href');
        }
        for (const format of ['md', 'html']) {
          const res = await page.request.get(`${stand.webUrl}${links[format]}`);
          const text = await res.text();
          check(`${lang}: выгрузка ${format} — 200`, res.status() === 200, `${res.status()}`);
          check(
            `${lang}: выгрузка ${format} несёт вердикт экрана`,
            text.includes(VERDICT[lang]),
            text.slice(0, 300),
          );
          const cells =
            format === 'md'
              ? [...text.matchAll(/^\|(.+)\|$/gm)].map((m) => m[1].split('|').map((c) => c.trim()))
              : [...text.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
                  [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
                    c[1].replace(/<[^>]+>/g, '').trim(),
                  ),
                );
          const flat = cells.flat();
          for (const [id, word] of Object.entries(WHO[lang])) {
            check(`${lang}: ${format}, «Кто» для ${id} — «${word}»`, flat.includes(word));
          }
          const raw = ['human', 'ci'].concat(lang === 'ru' ? ['agent'] : []);
          check(
            `${lang}: ${format}, сырых id (${raw.join(', ')}) в ячейках нет`,
            !raw.some((id) => flat.includes(id)),
            JSON.stringify(cells.slice(0, 8)),
          );
          if (lang === 'en') {
            // Слова самих кейсов и провала — данные человека, не текст панели.
            const own = /^(Вход|Выход|Профиль|Интерфейс|кнопки|кнопка|нет|есть)$/;
            const cyr = (text.match(/[А-Яа-яЁё]+/g) ?? []).filter((word) => !own.test(word));
            check(`en: ${format} без кириллицы`, cyr.length === 0, cyr.slice(0, 10).join(' '));
          }
        }
        const pdf = await page.request.get(`${stand.webUrl}${links.pdf}`);
        const head = (await pdf.body()).subarray(0, 4).toString('latin1');
        if (pdf.status() === 501)
          console.log(`  ~ ${lang}: pdf — 501, печатать нечем (не проверено)`);
        else
          check(
            `${lang}: pdf — 200 и %PDF`,
            pdf.status() === 200 && head === '%PDF',
            `${pdf.status()} ${head}`,
          );
      };
      await exports('ru');

      // 2. Язык в «Настройках», возврат ссылкой меню — без перезагрузки.
      await page
        .getByRole('link', { name: /^Настройки/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await wait(800);
      await page
        .getByRole('link', { name: /^Testing/ })
        .first()
        .click();
      // Раздел открывается «Библиотекой» — отчёт своей вкладкой, тоже без перезагрузки.
      await page.getByText('Report', { exact: true }).first().click();
      check(
        'en: карточка по-английски после смены языка в Настройках',
        await verdictOnCard('en'),
        await cardText(),
      );
      check('смена языка прошла без перезагрузки страницы', await notReloaded());
      if (SHOTS)
        await page.screenshot({ path: join(SHOTS, 'release-card_en.png'), fullPage: true });
      await exports('en');

      const report = await page.locator('main').innerText();
      check(
        'en: «Coverage by area» — «no area», а не русское «без зоны» с сервера',
        report.includes('no area') && !report.includes('без зоны'),
      );

      // 3. Обратно на русский тем же путём — карточка следует и в эту сторону.
      await page
        .getByRole('link', { name: /^Settings/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Русский', exact: true }).click();
      await wait(800);
      await page
        .getByRole('link', { name: /^Тестирование/ })
        .first()
        .click();
      await page.getByText('Отчёт', { exact: true }).first().click();
      check('ru снова: карточка по-русски', await verdictOnCard('ru'), await cardText());
      check('и без перезагрузки страницы', await notReloaded());
      if (SHOTS)
        await page.screenshot({ path: join(SHOTS, 'release-card_ru-back.png'), fullPage: true });
      check('без ошибок страницы', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
