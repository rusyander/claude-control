/**
 * Сквозной ход агента панели по блоку «Тестирование»: «заведи тест-план» →
 * карточка → план на диске и во вкладке «Планы»; отклонённая карточка — плана
 * нет; «какие тест-планы» → ответ из отчёта панели, без карточек. Кейс
 * panel-agent-tests-block-002.
 *
 * Подменена только модель — фальшивый `claude`
 * (`fake-cli-panel-agent-tests-block.mjs`) на PATH одноразовой панели. Путь
 * целиком настоящий: `POST /api/agent/run` → процесс CLI с `--mcp-config` панели
 * → настоящий переходник `tools/mcp/panel.mjs` → действия панели → реестр
 * возможностей → карточки → решение человека (`/api/agent/pending/:id` с Origin
 * окна) → файл плана во временном проекте → страница проекта во фронте.
 *
 * Стенд и проект одноразовые: хранилище тестов этого репозитория и стенд
 * человека не трогаются. Запуск: `node tools/qa/check-agent-tests-block-walk.mjs`.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_TESTS_BLOCK_CLI_SOURCE } from './fake-cli-panel-agent-tests-block.mjs';

const PROJECT = 'u4b-walk';
const PLAN = 'Дым входа';
const REJECTED_PLAN = 'Отклонённый план';

const testCase = (id, title) => ({
  id,
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открыто' }],
  status: 'unknown',
  source: 'human',
});

await runOnStand(
  {
    label: 'agent-tests-block-walk',
    fakeCli: { claude: FAKE_PANEL_AGENT_TESTS_BLOCK_CLI_SOURCE },
    seed: ({ home }) => {
      const tests = join(home, PROJECT, '.agent', 'tests');
      mkdirSync(tests, { recursive: true });
      writeFileSync(
        join(tests, 'gui.tests.json'),
        JSON.stringify({
          version: 1,
          title: 'GUI',
          cases: [
            testCase('gui-001', 'Вход в панель'),
            testCase('gui-002', 'Выход из панели'),
            testCase('gui-003', 'Смена темы'),
          ],
        }),
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const origin = stand.webUrl;
    const project = join(stand.home, PROJECT);
    const plansDir = join(project, '.agent', 'tests', 'plans');
    const planFiles = () =>
      existsSync(plansDir)
        ? readdirSync(plansDir)
            .filter((name) => name.endsWith('.plan.json'))
            .map((name) => JSON.parse(readFileSync(join(plansDir, name), 'utf8')))
        : [];
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check('проект заведён в реестр стенда', added.status === 200, added.text.slice(0, 200));

    async function turn(conversationId, messages, decide) {
      const cards = [];
      let settled = false;
      const running = fetch(`${stand.apiUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ messages, conversationId, context: { route: '/projects' } }),
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .finally(() => (settled = true));
      const seen = new Set();
      for (let t = 0; t < 120_000 && !settled; t += 200) {
        const pending = (await stand.api('/agent/pending')).body ?? [];
        for (const card of pending) {
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          cards.push(card);
          const answer = await stand.api(`/agent/pending/${card.id}`, {
            method: 'POST',
            headers: { origin },
            body: { decision: decide(card) },
          });
          if (answer.status !== 200) throw new Error(`решение карточки: HTTP ${answer.status}`);
        }
        await wait(200);
      }
      const response = await running;
      const conversation = (await stand.api(`/agent/conversations/${conversationId}`)).body;
      return { response, cards, reply: conversation?.messages?.at(-1)?.content ?? '' };
    }

    // ── Ход 1: заведи план — одобрено ──────────────────────────────────────
    const first = await turn(
      `walk-${randomUUID()}`,
      [
        {
          role: 'user',
          content: `Заведи тест-план «${PLAN}» из кейсов gui-001, gui-002 в проекте «${PROJECT}»`,
        },
      ],
      () => 'approve',
    );
    check(
      'ход 1: запуск принят (200)',
      first.response.status === 200,
      first.response.text.slice(0, 400),
    );
    check(
      'ход 1: одна карточка save_test_plan — изменение, сводка по-русски',
      first.cards.length === 1 &&
        first.cards[0].name === 'save_test_plan' &&
        first.cards[0].risk === 'change' &&
        first.cards[0].preview?.summary === `Создать тест-план «${PLAN}»`,
      JSON.stringify(first.cards.map((card) => [card.name, card.risk, card.preview?.summary])),
    );
    const saved = planFiles().find((plan) => plan.title === PLAN);
    check(
      'ход 1: файл плана во временном проекте со своими кейсами',
      saved !== undefined && JSON.stringify(saved.caseIds) === '["gui-001","gui-002"]',
      JSON.stringify(planFiles()),
    );
    check(
      'ход 1: ответ агента называет план и его id из ответа панели',
      saved !== undefined && first.reply.includes(`«${PLAN}» (${saved.id})`),
      first.reply,
    );

    // План виден человеку — вкладка «Планы» раздела тестов проекта.
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      const view = (await stand.api(`/project-tests?path=${encodeURIComponent(project)}`)).body;
      check(
        'раздел отдаёт план',
        view?.plans?.some((plan) => plan.title === PLAN),
      );
      // Та же страница, что открывает агенту `testsPage(path, 'plans')`.
      await page.goto(`${stand.webUrl}/tests?project=${encodeURIComponent(project)}&tab=plans`);
      const visible = await page
        .getByText(PLAN, { exact: false })
        .first()
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      check('ход 1: план виден во вкладке «Планы»', visible, page.url());
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }

    // ── Отрицательная ветка: человек отклоняет ─────────────────────────────
    const rejected = await turn(
      `walk-${randomUUID()}`,
      [
        {
          role: 'user',
          content: `Заведи тест-план «${REJECTED_PLAN}» из кейсов gui-003 в проекте «${PROJECT}»`,
        },
      ],
      () => 'reject',
    );
    check('отказ: карточка была показана', rejected.cards.length === 1);
    check(
      'отказ: отклонённого плана нет на диске',
      !planFiles().some((plan) => plan.title === REJECTED_PLAN),
      JSON.stringify(planFiles().map((plan) => plan.title)),
    );
    check(
      'отказ: агент говорит, что план не заведён',
      rejected.reply.includes('не заведён'),
      rejected.reply,
    );

    // ── Ход 2: только чтение ───────────────────────────────────────────────
    const second = await turn(
      `walk-${randomUUID()}`,
      [{ role: 'user', content: `Какие тест-планы в проекте «${PROJECT}»?` }],
      () => 'approve',
    );
    check('ход 2: ни одной карточки — только чтение', second.cards.length === 0);
    check(
      'ход 2: ответ перечисляет план с кейсами из отчёта панели',
      second.reply.includes(`«${PLAN}» — gui-001, gui-002`) &&
        !second.reply.includes(REJECTED_PLAN),
      second.reply,
    );
  },
);
