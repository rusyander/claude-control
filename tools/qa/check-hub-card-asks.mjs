/**
 * Хаб родителя: запрос прав и вопрос группы — в карточке ЭТОЙ группы
 * (замечание владельца 23.10).
 *
 * Было: «Агент просит разрешение» висел отдельной плашкой над хабом с подписью
 * «Просит «<группа>»», а вопрос группы, пришедший под временным ключом прогона
 * (`new-…`), — там же. Теперь:
 *
 * 1. Запрос прав группы, записанный сервером под временным ключом прогона, —
 *    островок в карточке группы (`data-group-permission`), над хабом его нет.
 * 2. Вопрос группы — островок в карточке своей группы (`data-group-ask`).
 * 3. «Разрешить» в карточке уходит в прогон ребёнка — по тому ключу, под
 *    которым он спросил.
 * 4. Ручной ребёнок родителя (не группа плана) карточку в хабе имеет — его
 *    запрос тоже в ней. Запрос разговора без своей карточки (вложенный чат
 *    группы) — по-прежнему полосой над хабом (`data-child-asks`) с подписью.
 * 5. Клавиатура: «Разрешить» в карточке берёт фокус Tab-ом и жмётся Enter-ом,
 *    растянутая кнопка карточки её не перекрывает; обе темы.
 *
 * Стенд одноразовый (`throwaway-stand.mjs`), данные хаба подменены целиком:
 * ни копий, ни прогонов прогон не создаёт и настоящий `~/.claude` не читает.
 *
 * Запуск: `node tools/qa/check-hub-card-asks.mjs`; `SHOTS=<папка>` и
 * `PHASE=before|after` — снимки обеих тем.
 */
import { chromium } from 'playwright';
import { runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const PROJECT = { name: 'QA запросы групп', path: 'C:/qa-hub-card-asks-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-asks-parent';
const MANUAL = 'qa-asks-manual';
const NESTED = 'qa-asks-nested';

const GROUPS = [
  { index: 0, title: 'Вход', branch: 'feature/login', status: 'started' },
  { index: 1, title: 'Отчёты', branch: 'feature/reports', status: 'started' },
  { index: 2, title: 'Схема', branch: 'feature/schema', status: 'done' },
];

const chatIdOf = (group) => `qa-asks-${group.index}`;
/** Ключ прогона, заведённого панелью: CLI ещё не назвал сессию. */
const runIdOf = (group) => `new-qa-asks-${group.index}`;
const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:05:00.000Z',
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.stage ? { stage: extra.stage } : {}),
  ...(extra.groupTitle ? { groupTitle: extra.groupTitle } : {}),
  ...(extra.groupIndex !== undefined ? { groupIndex: extra.groupIndex } : {}),
  ...(extra.branch ? { branch: extra.branch } : {}),
});

const chats = [
  chat(PARENT, { title: 'Пачка задач' }),
  ...GROUPS.map((group) =>
    chat(chatIdOf(group), {
      title: group.title,
      parentId: PARENT,
      stage: 'work',
      groupTitle: group.title,
      groupIndex: group.index,
      branch: group.branch,
      projectPath: copyOf(group),
    }),
  ),
  // Ребёнок без группы плана: чат, выделенный из родителя руками.
  chat(MANUAL, { title: 'Ручной чат из родителя', parentId: PARENT }),
  // Чат, выделенный из группы «Вход»: потомок дерева, своей карточки в этом хабе нет.
  chat(NESTED, { title: 'Вложенный чат входа', parentId: chatIdOf(GROUPS[0]) }),
];

const QUESTION = JSON.stringify({
  questions: [
    {
      question: 'Какую таблицу отчётов оставить?',
      header: 'Таблица',
      multiSelect: false,
      options: [
        { label: 'Старую', description: 'без миграции' },
        { label: 'Новую', description: 'с миграцией' },
      ],
    },
  ],
});

const permission = (runId, toolUseId, command) => ({
  kind: 'permission',
  runId,
  toolUseId,
  toolName: 'Bash',
  input: { command },
  askedAt: '2026-10-23T10:04:00.000Z',
});

const asksOf = {
  [chatIdOf(GROUPS[0])]: [permission(runIdOf(GROUPS[0]), 'tu-perm-0', 'git fetch origin')],
  [chatIdOf(GROUPS[1])]: [
    {
      kind: 'question',
      runId: runIdOf(GROUPS[1]),
      toolUseId: 'tu-ask-1',
      input: QUESTION,
      askedAt: '2026-10-23T10:04:30.000Z',
    },
  ],
  [MANUAL]: [permission(`new-${MANUAL}`, 'tu-perm-manual', 'rm -rf build')],
  [NESTED]: [permission(`new-${NESTED}`, 'tu-perm-nested', 'npm publish')],
};

const split = () => ({
  parentChatId: PARENT,
  order: GROUPS.map((group) => group.index),
  groups: GROUPS.map((group) => ({
    index: group.index,
    title: group.title,
    branch: group.branch,
    after: [],
    chatId: chatIdOf(group),
    path: copyOf(group),
    seated: true,
    deliver: true,
    status: group.status,
    ...(group.status === 'done' ? { result: { kind: 'pushed', commits: 1 } } : {}),
  })),
});

const tree = () => ({
  root: PARENT,
  running: 2,
  split: split(),
  nodes: chats
    .filter((item) => item.parentId)
    .map((item) => ({
      chatId: item.id,
      aliases: [`new-${item.id}`],
      parentChatId: item.parentId,
      ...(item.groupTitle ? { title: item.groupTitle } : {}),
      ...(item.groupIndex !== undefined ? { groupIndex: item.groupIndex } : {}),
      running: item.groupIndex === 0 || item.groupIndex === 1,
      ...(asksOf[item.id] ? { asks: asksOf[item.id] } : {}),
    })),
});

/** Решения по правам, ушедшие с экрана: ключ прогона и вызов. */
const decisions = [];

async function stubHub(page) {
  await page.route('**/api/project-git*', (route) =>
    route.fulfill({
      json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
    }),
  );
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: PROJECT.path,
          name: PROJECT.name,
          exists: true,
          lastActivity: '2026-10-23T10:00:00.000Z',
          chats: [],
        },
      ],
    }),
  );
  await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
  await page.route('**/api/chat/*/tree', (route) => route.fulfill({ json: tree() }));
  await page.route('**/api/chat/*/permission-decision', async (route) => {
    const target = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
    decisions.push({ target, ...route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/chats/*/messages*', (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'm-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Разделил задачи на три группы.' }],
            timestamp: '2026-10-23T10:02:00.000Z',
          },
        ],
        total: 1,
        hasMore: false,
      },
    }),
  );
  await page.route('**/api/chat/*/progress*', (route) =>
    route.fulfill({ json: { steps: [], isComplete: false } }),
  );
  await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
}

async function openHub(stand, page) {
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  // На стенде без входа в CLI поверх всего встаёт окно «нужен доступ» — его
  // закрывают, как закрыл бы человек: к хабу оно отношения не имеет.
  const gate = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
  await gate.waitFor({ timeout: 5000 }).catch(() => {});
  if (await gate.count()) await gate.getByRole('button', { name: 'Закрыть' }).last().click();
  await page.getByRole('tab', { name: 'Проекты' }).click();
  await page
    .getByRole('button', { name: new RegExp(PROJECT.name) })
    .first()
    .click();
  await page
    .getByRole('button', { name: /Пачка задач/ })
    .first()
    .click();
  await page.waitForSelector('[data-child-hub] [data-hub-row]', { timeout: 20000 });
  // Дерево опрашивается раз в пять секунд — запросы приходят с первым ответом.
  await page.waitForTimeout(1500);
}

const suffix = process.env.PHASE ? `_${process.env.PHASE.toUpperCase()}` : '';

await runOnStand({ label: 'hub-card-asks' }, async (stand, check) => {
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const page = await stand.newPage(browser, { width: 1400, height: 2400 });
      await bypassOnboarding(page, { ...CEILING, theme });
      await stubHub(page);
      await openHub(stand, page);
      console.log(`Тема: ${theme}`);

      const hub = page.locator('[data-child-hub]');
      const card = (title) => hub.locator('[data-hub-row]').filter({ hasText: title });
      const strip = page.locator('[data-child-asks]');

      if (process.env.SHOTS) {
        // Полоса над хабом и сам хаб — одним кадром: видно, где стоит запрос.
        const top = page.locator('[data-child-asks], [data-child-hub]');
        await top.first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
        const boxes = await top.evaluateAll((list) =>
          list.map((node) => node.getBoundingClientRect().toJSON()),
        );
        const x = Math.min(...boxes.map((box) => box.x));
        const y = Math.min(...boxes.map((box) => box.y));
        const right = Math.max(...boxes.map((box) => box.x + box.width));
        const bottom = Math.max(...boxes.map((box) => box.y + box.height));
        await page.screenshot({
          path: `${process.env.SHOTS}/hub-asks-${theme}${suffix}.png`,
          clip: { x, y, width: right - x, height: Math.min(bottom, 2400) - y },
        });
      }

      const login = card('Вход');
      const island = login.locator('[data-group-permission]');
      const inCard = (await island.count()) === 1;
      check(`${theme}: запрос прав «Входа» — в его карточке`, inCard);
      check(
        `${theme}: в карточке видна команда запроса`,
        inCard && ((await island.textContent()) ?? '').includes('git fetch origin'),
      );
      check(
        `${theme}: вопрос «Отчётов» — в их карточке`,
        (await card('Отчёты').locator('[data-group-ask]').count()) === 1,
      );
      const stripText = (await strip.count()) ? ((await strip.textContent()) ?? '') : '';
      check(
        `${theme}: над хабом нет ни запроса «Входа», ни вопроса «Отчётов»`,
        !stripText.includes('git fetch origin') && !stripText.includes('Какую таблицу'),
        stripText.slice(0, 200),
      );
      check(
        `${theme}: запрос ручного ребёнка — в его карточке, не над хабом`,
        (await card('Ручной чат из родителя').locator('[data-group-permission]').count()) === 1 &&
          !stripText.includes('rm -rf build'),
        stripText.slice(0, 200),
      );
      check(
        `${theme}: запрос вложенного чата без своей карточки — полосой над хабом, с подписью`,
        stripText.includes('npm publish') && stripText.includes('Вложенный чат входа'),
        stripText.slice(0, 200),
      );

      // Клавиатура: Tab доходит до «Разрешить» в карточке, Enter решает.
      const allow = login.locator('[data-group-permission]').getByRole('button', {
        name: 'Разрешить',
      });
      let reached = false;
      if ((await allow.count()) === 1) {
        await allow.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        reached = await allow.evaluate((node) => node === document.activeElement);
        const hit = await allow.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return Boolean(top && (top === node || node.contains(top)));
        });
        check(`${theme}: «Разрешить» не перекрыта растянутой кнопкой карточки`, hit);
        const before = decisions.length;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const sent = decisions.slice(before);
        check(
          `${theme}: Enter на «Разрешить» — решение ушло прогону «Входа» (${runIdOf(GROUPS[0])})`,
          sent.length === 1 &&
            sent[0].target === runIdOf(GROUPS[0]) &&
            sent[0].toolUseId === 'tu-perm-0' &&
            sent[0].behavior === 'allow',
          JSON.stringify(sent),
        );
      }
      check(`${theme}: «Разрешить» в карточке достижима Tab-ом`, reached);
      check(
        `${theme}: ошибок страницы нет`,
        page.errors.length === 0,
        page.errors.join(' | ').slice(0, 300),
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
