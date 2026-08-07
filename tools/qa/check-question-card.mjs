/**
 * Прогон карточки вопроса агента.
 *
 * Проверяется то, что живьём ломалось: вопросов в одном вызове бывает до
 * четырёх, а ответ уходит одним сообщением — значит, отвечать вразнобой нельзя,
 * промах по варианту должен быть исправим ДО отправки, а сама отправка обязана
 * отзываться мгновенно: агент думает десятки секунд, и всё это время карточка
 * должна выглядеть отправленной.
 *
 * Данные подменяются целиком: прогон обязан быть воспроизводимым на любой
 * машине, а разговор с незакрытым вопросом в чужой истории — случайность.
 * `POST /api/chat/send` намеренно отвечает с задержкой — это и есть тот самый
 * «клод подтверждает через сорок секунд».
 *
 * Запуск: `node tools/qa/check-question-card.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const CHAT_ID = 'qa-question-chat';
/** Столько «думает» сервер после клика: карточка не имеет права этого ждать. */
const SEND_DELAY = 4000;

const QUESTIONS = {
  questions: [
    {
      question: 'Чем строить редактор?',
      header: 'Редактор',
      multiSelect: false,
      options: [
        { label: 'CodeMirror 6', description: 'Лёгкий, есть готовый дифф.' },
        { label: 'Monaco', description: 'Тяжелее, зато как в VS Code.' },
      ],
    },
    {
      question: 'Что брать за базу сравнения?',
      header: 'База диффа',
      multiSelect: false,
      options: [
        { label: 'Правки агента в этом чате', description: 'Из транскрипта.' },
        { label: 'Рабочее дерево против HEAD', description: 'Обычный git diff.' },
      ],
    },
    {
      question: 'Что входит в первую итерацию?',
      header: 'Объём',
      multiSelect: true,
      options: [
        { label: 'Дерево', description: 'Список файлов проекта.' },
        { label: 'Дифф', description: 'Правки агента поверх файла.' },
        { label: 'Правка файла', description: 'Запись на диск.' },
      ],
    },
  ],
};

const CHAT = {
  id: CHAT_ID,
  title: 'Вопрос агента',
  project: 'qa',
  projectPath: 'C:/qa-project',
  isSandbox: true,
  messageCount: 2,
  createdAt: '2026-08-07T10:00:00.000Z',
  updatedAt: '2026-08-07T10:05:00.000Z',
  preview: 'Нужен ваш выбор',
};

const MESSAGES = {
  messages: [
    {
      id: 'm-old',
      role: 'assistant',
      blocks: [{ type: 'tool', name: 'AskUserQuestion', input: JSON.stringify(QUESTIONS) }],
      timestamp: '2026-08-07T10:01:00.000Z',
    },
    {
      id: 'm-answer',
      role: 'user',
      blocks: [{ type: 'text', text: 'Редактор: CodeMirror 6' }],
      timestamp: '2026-08-07T10:02:00.000Z',
    },
    {
      id: 'm-last',
      role: 'assistant',
      blocks: [{ type: 'tool', name: 'AskUserQuestion', input: JSON.stringify(QUESTIONS) }],
      timestamp: '2026-08-07T10:05:00.000Z',
    },
  ],
  total: 3,
  hasMore: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

let sentBody;
/** Сколько раз ушла отправка: двойной щелчок обязан остаться одним ходом. */
let sends = 0;

await page.route('**/api/chats', async (route) => route.fulfill({ json: [CHAT] }));
await page.route(`**/api/chats/${CHAT_ID}/messages*`, async (route) =>
  route.fulfill({ json: MESSAGES }),
);
await page.route('**/api/chat/active', async (route) => route.fulfill({ json: [] }));
await page.route(`**/api/chat/${CHAT_ID}/progress*`, async (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route(`**/api/chat/${CHAT_ID}/artifacts*`, async (route) => route.fulfill({ json: [] }));

// Отправка «думает»: ровно тот случай, ради которого карточка гасится сама.
await page.route('**/api/chat/send', async (route) => {
  sentBody = route.request().postDataJSON();
  sends += 1;
  await new Promise((done) => setTimeout(done, SEND_DELAY));
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"done","seq":1}\n\n',
  });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);
await page
  .getByRole('button', { name: /Вопрос агента/ })
  .first()
  .click();
await page.waitForTimeout(1500);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

// Карточек в ленте две: старая (закрытая) и последняя — живая.
// Корневой класс карточки — `_question_<хэш>`; вложенные (`_questionItem_…`)
// под этот шаблон не попадают, поэтому счёт идёт именно по карточкам.
const cards = page.locator('[class*="_question_"]').filter({ hasText: 'Нужен ваш выбор' });
const cardCount = await cards.count();
check(cardCount === 2, `карточек в ленте: ${cardCount}`);

const live = cards.last();
const old = cards.first();

check(
  (await old.getByRole('button', { name: /CodeMirror 6/ }).count()) === 0,
  'вопрос из середины истории только для чтения',
);
check(
  (await live.getByRole('button', { name: /CodeMirror 6/ }).count()) === 1,
  'последний вопрос отвечаем',
);

check(await live.getByText('вопрос 1 из 3').isVisible(), 'показан шаг «вопрос 1 из 3»');
check(
  (await live.getByRole('button', { name: /Правки агента в этом чате/ }).count()) === 0,
  'второй вопрос погашен: варианты не кнопки',
);
check(
  (await live.getByText('Ответьте на предыдущий вопрос').count()) === 2,
  'у погашенных вопросов сказано, чего ждут',
);

// Первый ответ: карточка обязана перейти ко второму вопросу, а не отправиться.
await live.getByRole('button', { name: /CodeMirror 6/ }).click();
await page.waitForTimeout(300);
check(sentBody === undefined, 'после первого выбора ничего не отправлено');
check(await live.getByText('вопрос 2 из 3').isVisible(), 'карточка перешла ко второму вопросу');
check(
  (await live.getByRole('button', { name: 'Изменить' }).count()) === 1,
  'отвеченный вопрос свёрнут и его можно переспросить',
);

// Промах исправим: возвращаемся к первому вопросу и меняем ответ.
await live.getByRole('button', { name: 'Изменить' }).click();
await page.waitForTimeout(200);
check(
  (await live.getByRole('button', { name: /Monaco/ }).count()) === 1,
  'после «Изменить» первый вопрос снова активен',
);
await live.getByRole('button', { name: /Monaco/ }).click();
await page.waitForTimeout(200);

await live.getByRole('button', { name: /Правки агента в этом чате/ }).click();
await page.waitForTimeout(200);
check(await live.getByText('вопрос 3 из 3').isVisible(), 'дошли до третьего вопроса');

// Множественный выбор: копится, пока не нажмут «Дальше».
await live.getByRole('button', { name: /Дерево/ }).click();
await live.getByRole('button', { name: /Дифф/ }).click();
await page.waitForTimeout(200);
check(sentBody === undefined, 'множественный выбор сам по себе ничего не отправляет');
await live.getByRole('button', { name: 'Дальше' }).click();
await page.waitForTimeout(200);

const submit = live.getByRole('button', { name: 'Отправить ответы' });
check(await submit.isVisible(), 'на все вопросы отвечено — появилась кнопка отправки');

// Отправка: реакция обязана быть мгновенной, а не через SEND_DELAY.
const clickedAt = Date.now();
// Два щелчка ОДНОЙ задачей: между ними React не успевает перерисовать карточку,
// и защита от повторной отправки обязана держаться не на состоянии.
await submit.evaluate((node) => {
  node.click();
  node.click();
});
await live.getByText('Ответ отправлен — агент думает').waitFor({ timeout: 1000 });
const reaction = Date.now() - clickedAt;
check(reaction < 1000, `карточка отозвалась за ${reaction} мс, не дожидаясь сервера`);
check(
  (await live.getByRole('button', { name: /Monaco/ }).count()) === 0,
  'после отправки вариантов-кнопок в карточке нет',
);

await page.waitForTimeout(SEND_DELAY + 500);
check(Boolean(sentBody), 'запрос ушёл на сервер');
check(sends === 1, `двойной щелчок по отправке ушёл одним сообщением: ${sends}`);
const prompt = sentBody?.prompt ?? '';
check(
  prompt.includes('Редактор: Monaco') &&
    prompt.includes('База диффа: Правки агента в этом чате') &&
    prompt.includes('Объём: Дерево, Дифф'),
  `ответ собран одним сообщением по всем вопросам: ${JSON.stringify(prompt)}`,
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Карточка вопроса работает' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
