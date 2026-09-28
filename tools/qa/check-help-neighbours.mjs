/**
 * Кейс help-003: внизу документа справки — переходы «Предыдущий раздел» и
 * «Следующий раздел»; «следующий» открывает соседний документ, и прокрутка
 * стоит в его начале, а не там, где читатель бросил прошлый. Кнопка браузера
 * «Назад» возвращает прошлый документ на ту высоту, где с него ушли.
 *
 * Документ берётся из середины реестра (у него есть оба соседа). Какой сосед
 * «следующий», не угадывается: название на ссылке сверяется с заголовком
 * открывшегося документа.
 *
 * Запуск: `node tools/qa/check-help-neighbours.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const START = 'tests';

/** Прокрутка страницы: окно или внутренняя колонка раздела — что из них прокручено. */
const scrollOf = (page) =>
  page.evaluate(() => {
    const scroller = document.scrollingElement;
    const inner = [...document.querySelectorAll('*')].find((node) => node.scrollTop > 0);
    return Math.max(scroller?.scrollTop ?? 0, inner?.scrollTop ?? 0);
  });

await runOnStand({ label: 'help-neighbours' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 800 });
    await page.goto(`${stand.webUrl}/help?topic=${START}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
    await wait(800);

    const prev = page.getByRole('link').filter({ hasText: 'Предыдущий раздел' });
    const next = page.getByRole('link').filter({ hasText: 'Следующий раздел' });
    check('внизу есть «Предыдущий раздел»', (await prev.count()) === 1);
    check('внизу есть «Следующий раздел»', (await next.count()) === 1);

    // Пролистать до низа — как читатель, дочитавший документ.
    await next.scrollIntoViewIfNeeded();
    await wait(300);
    const startTitle = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    const scrolledTo = await scrollOf(page);
    check(
      'документ пролистан вниз (иначе проверка прокрутки ничего не докажет)',
      scrolledTo > 200,
      `${scrolledTo}`,
    );

    const nextTitle = (await next.innerText()).replace('Следующий раздел', '').trim();
    const nextHref = await next.getAttribute('href');
    await next.click();
    await page
      .waitForURL((url) => !url.search.includes(`topic=${START}`), { timeout: 10_000 })
      .catch(() => undefined);
    // Запас на отрисовку: прокрутку меряем, когда документ уже сменился и улёгся.
    await wait(2500);
    const heading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    check(
      `открыт соседний документ «${nextTitle}»`,
      heading === nextTitle,
      `заголовок «${heading}», ссылка ${nextHref}`,
    );
    check(
      'адрес сменил тему',
      !page.url().includes(`topic=${START}`) && page.url().includes('topic='),
      page.url(),
    );
    const top = await scrollOf(page);
    check('прокрутка в начале нового документа', top < 50, `прокрутка ${top}px`);
    const heading1Box = await page.getByRole('heading', { level: 1 }).first().boundingBox();
    check(
      'заголовок нового документа в видимой области',
      Boolean(heading1Box) && heading1Box.y >= 0 && heading1Box.y < 800,
      JSON.stringify(heading1Box),
    );

    // «Назад» браузера — прошлый документ на той высоте, где с него ушли.
    await page.goBack();
    await page
      .waitForURL((url) => url.search.includes(`topic=${START}`), { timeout: 10_000 })
      .catch(() => undefined);
    await wait(2500);
    const backHeading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    check(`«Назад» вернул документ «${startTitle}»`, backHeading === startTitle, backHeading);
    const back = await scrollOf(page);
    check(
      '«Назад» вернул прокрутку туда, где с документа ушли',
      Math.abs(back - scrolledTo) < 60,
      `было ${scrolledTo}px, стало ${back}px`,
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
