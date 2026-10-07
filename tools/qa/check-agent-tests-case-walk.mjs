/**
 * Агент панели и раздел тестов через ОКНО (Ф22): кейсы panel-agent-002 и
 * panel-agent-004, ни разу не гонявшиеся.
 *
 * Подменена только модель — фальшивый `claude`
 * (`fake-cli-panel-agent-tests-case.mjs`) на PATH одноразовой панели. Путь
 * целиком настоящий: поле окна агента → `POST /api/agent/run` → процесс CLI с
 * `--mcp-config` панели → переходник `tools/mcp/panel.mjs` → действия панели →
 * карточка в окне → щелчок человека → файл группы во временном проекте → кадр
 * страницы → переход окна.
 *
 * - panel-agent-002: в браузере выбран проект Б; «открой тестирование проекта
 *   «А»» → раздел «Тестирование», в поле «Проект» — А, в памяти браузера — А,
 *   в адресе нет `?project=`.
 * - panel-agent-004: «добавь в группу «chat» кейс …» → карточка с названием и
 *   группой; «Отклонить» — кейса нет; «Подтвердить» — кейс в файле группы,
 *   источник `agent`, шаги и оракул на месте, виден в библиотеке.
 *
 * Стенд и проекты одноразовые: хранилище тестов этого репозитория и стенд
 * человека не трогаются. Запуск: `node tools/qa/check-agent-tests-case-walk.mjs`.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_TESTS_CASE_CLI_SOURCE } from './fake-cli-panel-agent-tests-case.mjs';
import { dismissAccess } from './chat-walk.mjs';

const ALPHA = 'qa-alpha-proj';
const BETA = 'qa-beta-proj';
const CASE_TITLE = 'Пустое сообщение не уходит';
const REJECTED_TITLE = 'Отклонённый кейс';

const groupFile = (home, project) => join(home, project, '.agent', 'tests', 'chat.tests.json');
const seedGroup = (home, project) => {
  mkdirSync(join(home, project, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    groupFile(home, project),
    JSON.stringify({
      version: 1,
      title: 'Chat',
      cases: [
        {
          id: 'chat-001',
          type: 'case',
          title: 'Отправка сообщения',
          steps: [{ action: 'Отправить', expected: 'Ушло' }],
          status: 'unknown',
          source: 'human',
        },
      ],
    }),
    'utf8',
  );
};

await runOnStand(
  {
    label: 'agent-tests-case-walk',
    fakeCli: { claude: FAKE_PANEL_AGENT_TESTS_CASE_CLI_SOURCE },
    seed: ({ home }) => {
      seedGroup(home, ALPHA);
      seedGroup(home, BETA);
    },
  },
  async (stand, check) => {
    const casesOf = () => JSON.parse(readFileSync(groupFile(stand.home, ALPHA), 'utf8')).cases;
    const ids = {};
    for (const name of [ALPHA, BETA]) {
      const added = await stand.api('/projects', {
        method: 'POST',
        body: { path: join(stand.home, name) },
      });
      ids[name] = added.body?.id;
      check(`проект ${name} в реестре стенда`, added.status === 200 && Boolean(ids[name]));
    }

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      // В памяти браузера выбран НЕ тот проект, о котором попросят.
      await page.evaluate((id) => localStorage.setItem('agentdeck:tests-project', id), ids[BETA]);
      await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
      await dismissAccess(page);
      const trigger = page.locator('[data-panel-agent-trigger]');
      const win = page.locator('[data-panel-agent-window]');
      const input = win.locator('[data-agent-input]');
      await trigger.waitFor({ timeout: 60_000 });
      await trigger.click();
      await input.waitFor();

      const ask = async (text, expectReply) => {
        await input.fill(text);
        await input.press('Enter');
        const said = await win
          .getByText(expectReply, { exact: false })
          .first()
          .waitFor({ timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        return said;
      };

      // ── panel-agent-002 ──────────────────────────────────────────────────
      console.log('panel-agent-002: открой тестирование проекта');
      const opened = await ask(
        `Открой тестирование проекта «${ALPHA}»`,
        `Открыл тестирование проекта «${ALPHA}»`,
      );
      check('агент сказал, что открыл раздел', opened);
      let url = new URL(page.url());
      for (
        let i = 0;
        i < 40 && (url.pathname !== '/tests' || url.searchParams.has('project'));
        i += 1
      ) {
        await wait(250);
        url = new URL(page.url());
      }
      check('панель перешла в «Тестирование»', url.pathname === '/tests', page.url());
      check('в адресе нет лишнего ?project=', !url.searchParams.has('project'), page.url());
      const select = page.getByLabel('Проект', { exact: true }).first();
      await select.waitFor({ timeout: 20_000 }).catch(() => undefined);
      const chosen = await select
        .evaluate((node) =>
          node instanceof HTMLSelectElement
            ? (node.selectedOptions[0]?.textContent ?? '')
            : (node.textContent ?? ''),
        )
        .catch(() => '');
      check(`в поле «Проект» выбран ${ALPHA}`, chosen.includes(ALPHA), chosen);
      check(
        'память браузера — тот же проект',
        (await page.evaluate(() => localStorage.getItem('agentdeck:tests-project'))) === ids[ALPHA],
      );

      // ── panel-agent-004 ──────────────────────────────────────────────────
      console.log('panel-agent-004: агент заводит кейс по просьбе');
      const decide = async (decision) => {
        const card = win.locator('[data-agent-decision="approve"]').first();
        await card.waitFor({ timeout: 60_000 });
        const text = await win.innerText();
        await wait(700); // кнопки карточки оживают через полсекунды
        await win.locator(`[data-agent-decision="${decision}"]`).first().click();
        return text;
      };

      await input.fill(`Добавь в группу «chat» проекта «${ALPHA}» кейс «${REJECTED_TITLE}»`);
      await input.press('Enter');
      const rejectedCard = await decide('reject');
      check(
        'карточка называет кейс',
        rejectedCard.includes(REJECTED_TITLE),
        rejectedCard.slice(0, 400),
      );
      const refused = await win
        .getByText(`«${REJECTED_TITLE}» не заведён`, { exact: false })
        .first()
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      check('отказ: агент говорит, что кейс не заведён', refused);
      check(
        'отказ: в файле группы кейса нет',
        !casesOf().some((one) => one.title === REJECTED_TITLE),
      );

      await input.fill(`Добавь в группу «chat» проекта «${ALPHA}» кейс «${CASE_TITLE}»`);
      await input.press('Enter');
      const card = await decide('approve');
      check(
        'карточка с группой и названием',
        card.includes(CASE_TITLE) && card.includes('chat.tests.json'),
        card.slice(0, 400),
      );
      const done = await win
        .getByText(`Завёл кейс «${CASE_TITLE}»`, { exact: false })
        .first()
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      check('агент назвал заведённый кейс', done);
      const saved = casesOf().find((one) => one.title === CASE_TITLE);
      check(
        'кейс в файле группы chat, источник — агент',
        saved?.source === 'agent',
        JSON.stringify(saved ?? casesOf().map((one) => one.title)),
      );
      check(
        'шаги и оракул на месте',
        saved?.steps?.[0]?.expected?.includes('не уходит') && Boolean(saved?.oracle),
      );
      check(
        'старый кейс группы не тронут',
        casesOf().some((one) => one.id === 'chat-001'),
      );

      await page.goto(`${stand.webUrl}/tests?tab=library`, { waitUntil: 'domcontentloaded' });
      const listed = await page
        .locator('main')
        .getByText(CASE_TITLE, { exact: false })
        .first()
        .waitFor({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check('кейс виден в «Тестирование → Библиотека»', listed);
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
