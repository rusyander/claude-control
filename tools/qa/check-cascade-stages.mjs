/**
 * Прогон видимой части конвейера «работа → ревью → фикс».
 *
 * Сам конвейер живёт на сервере и покрыт тестами; здесь проверяется ровно то,
 * что тестами не проверить, — видит ли человек, ЧТО панель завела за него. Три
 * разговора одной группы идут подряд в списке и отличаются только тем, зачем их
 * завели: без подписи это три одинаковых строки, а без карточки вердикта —
 * простыня JSON вместо списка замечаний.
 *
 * Данные подменяются целиком: ни прогонов, ни копий репозитория прогон не
 * создаёт и ничего за собой не оставляет.
 *
 * Запуск: `node tools/qa/check-cascade-stages.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const CHAT_ID = 'qa-cascade-review';
/** Второй случай ревью — и он же частый: проверено, править нечего. */
const CLEAN_ID = 'qa-cascade-clean';
/** Каталога на диске нет: копий и веток прогон не заводит. */
const PROJECT = { name: 'QA конвейер', path: 'C:/qa-cascade-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const FINDINGS = [
  'ChatSplit.ts:88 — ошибка одной группы гасит остальные',
  'нет теста на пустой дифф',
];

const verdict = (findings) =>
  ['```agentdeck:review', JSON.stringify({ findings }), '```'].join('\n');

/** Три звена одной группы: работа, её проверка и правки по замечаниям. */
const chat = (id, title, stage, updatedAt) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 2,
  createdAt: '2026-09-07T10:00:00.000Z',
  updatedAt,
  branch: 'split/rename',
  parentId: 'qa-cascade-parent',
  ...(stage ? { stage } : {}),
});

const CHATS = [
  chat(CHAT_ID, 'Ревью работы «Переименования»', 'review', '2026-09-07T10:20:00.000Z'),
  chat('qa-cascade-work', 'Переименования по файлам', 'work', '2026-09-07T10:10:00.000Z'),
  chat('qa-cascade-fix', 'Правки по замечаниям', 'fix', '2026-09-07T10:30:00.000Z'),
  chat(CLEAN_ID, 'Ревью работы «Шапка»', 'review', '2026-09-07T10:25:00.000Z'),
];

const messages = (text) => ({
  messages: [
    {
      id: 'm-review',
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: '2026-09-07T10:20:00.000Z',
    },
  ],
  total: 1,
  hasMore: false,
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page, CEILING);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

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
        lastActivity: '2026-09-07T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route(`**/api/chats/${CHAT_ID}/messages*`, (route) =>
  route.fulfill({ json: messages(`Прочитал дифф ветки против задания.\n\n${verdict(FINDINGS)}`) }),
);
await page.route(`**/api/chats/${CLEAN_ID}/messages*`, (route) =>
  route.fulfill({ json: messages(`Прочитал дифф ветки против задания.\n\n${verdict([])}`) }),
);
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

// Снимки берутся из того же прогона, что и проверяет: картинка и вердикт иначе
// разъедутся при первой же правке. `SHOTS=<папка> node tools/qa/…`.
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: false });
};

/**
 * Звенья конвейера — чаты проекта, а без открытого проекта список показывает
 * только песочницу (`pages/Chat/lib/visibleChats.ts`). Поэтому сначала проект.
 */
const openProject = async () => {
  await page.getByRole('tab', { name: 'Проекты' }).click();
  await page.waitForTimeout(800);
  await page
    .getByRole('button', { name: new RegExp(PROJECT.name) })
    .first()
    .click();
  await page.waitForTimeout(1200);
};

await openProject();

// Метки звеньев в списке. Работа своей метки не получает намеренно: подписать
// каждый второй чат «работа» значит спрятать те два, ради которых метка и есть.
check(
  (await page.getByText('ревью', { exact: true }).count()) > 0,
  'звено ревью подписано в списке',
);
check(
  (await page.getByText('правки', { exact: true }).count()) > 0,
  'звено правок подписано в списке',
);

await page
  .getByRole('button', { name: /Ревью работы «Переименования»/ })
  .first()
  .click();
await page.waitForTimeout(1200);

const body = await page.locator('body').innerText();

// Главное: вместо блока с JSON человек видит состав замечаний.
check(!body.includes('agentdeck:review'), 'служебный блок вердикта в ленту не попал');
check(body.includes('Ревью работы'), 'карточка вердикта показана');
check(body.includes('2 замечания'), 'замечания посчитаны');
for (const finding of FINDINGS) {
  check(body.includes(finding), `замечание видно целиком: ${finding.slice(0, 32)}…`);
}
// Слова агента вокруг блока остаются: карточка их заменять не должна.
check(body.includes('Прочитал дифф ветки против задания.'), 'разбор словами остался в ленте');
await shot('review-findings');

// Второй случай, который человек увидит чаще первого: проверено, править нечего.
// Пустой список — не пустая карточка: молчать о нём значило бы показывать
// проверку только тогда, когда она нашла плохое.
await page
  .getByRole('button', { name: /Ревью работы «Шапка»/ })
  .first()
  .click();
await page.waitForTimeout(1500);

const clean = await page.locator('body').innerText();
check(
  clean.includes('исправлять нечего'),
  'ревью без замечаний тоже показано, а не молча пропущено',
);
await shot('review-clean');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Конвейер виден человеку' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
