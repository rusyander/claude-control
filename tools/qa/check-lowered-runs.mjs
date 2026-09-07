/**
 * Карточка «Понижённые прогоны веера» на странице аналитики.
 *
 * Проверяется то, ради чего карточка и заведена: пустой журнал не оставляет на
 * странице пустого блока, а непустой честно разделяет прогоны на те, где панель
 * видела команды проверок, и те, где не видела. Ошибиться тут дороже обычного —
 * блок обвиняет агента в невыполненной планке сдачи, поэтому формулировка
 * «проверок не видно» обязана быть именно такой, а не «агент не проверял».
 *
 * Журнал подменяется целиком: прогон не зависит от того, чем человек пользовался
 * на этой машине, и сам ничего не запускает.
 *
 * Запуск: `node tools/qa/check-lowered-runs.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const run = (chatId, model, checks, ok = true, kind, tokens = 12_000) => ({
  chatId,
  projectPath: `C:/qa-lowered/${chatId}`,
  model,
  effort: 'high',
  ...(kind ? { kind } : {}),
  // Время — миллисекунды, как в `LoweredRunRecord`: подмена обязана повторять
  // форму сервера, иначе зонд проверяет не то, что приходит на самом деле.
  startedAt: 1_757_236_800_000,
  finishedAt: 1_757_237_040_000,
  ok,
  checks,
  tokens,
});

// Три записи закрывают все три состояния строки: проверки видели, не видели,
// и прогон упал — у последнего свой значок, потому что до проверок он не дошёл.
const RUNS = [
  run('qa-seen', 'claude-sonnet-5', ['pnpm type-check', 'pnpm lint'], true, 'mechanical', 400_000),
  run('qa-unseen', 'claude-haiku-4-5', [], true, 'tests', 30_000),
  run('qa-failed', 'claude-haiku-4-5', [], false, undefined, 5_000),
];

const JOURNAL = {
  runs: RUNS,
  summary: {
    total: 3,
    withChecks: 1,
    withoutChecks: 1,
    failed: 1,
    tokens: 435_000,
    // Разрез по классам: сверху съевший больше окна, прогон без класса —
    // отдельной строкой (ручной веер рода работы не называет).
    byKind: [
      {
        kind: 'mechanical',
        total: 1,
        withChecks: 1,
        withoutChecks: 0,
        failed: 0,
        tokens: 400_000,
      },
      { kind: 'tests', total: 1, withChecks: 0, withoutChecks: 1, failed: 0, tokens: 30_000 },
      { kind: '', total: 1, withChecks: 0, withoutChecks: 0, failed: 1, tokens: 5_000 },
    ],
  },
};
const EMPTY = {
  runs: [],
  summary: { total: 0, withChecks: 0, withoutChecks: 0, failed: 0, tokens: 0, byKind: [] },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

let journal = EMPTY;
await page.route('**/api/chat/lowered-runs*', (route) => route.fulfill({ json: journal }));

const open = async () => {
  await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
};

// --- Пустой журнал: блока быть не должно --------------------------------

await open();
const title = page.getByText('Понижённые прогоны веера');
check((await title.count()) === 0, 'при пустом журнале карточки нет');

// --- Журнал с записями --------------------------------------------------

journal = JOURNAL;
await open();
check((await title.count()) === 1, 'с записями карточка появилась');

// Строки карточки различимы сами по себе — сужать до контейнера незачем, а
// попытка сузиться по `div` попадает во внутренний Stack и теряет их.
const card = page;
// По два: значок стоит и в общей сводке, и в строке класса, которому это число
// принадлежит. Разрез по классам появился 08.09.2026 вместе с журналом окна.
check((await card.getByText('без видимых проверок: 1').count()) === 2, 'сводка без проверок');
check((await card.getByText('упало: 1').count()) === 2, 'сводка упавших');
check(
  (await card.getByText('«проверок не видно» значит именно это', { exact: false }).count()) === 1,
  'оговорка про Bash на месте',
);
check(
  (await card.getByText('агент их не делал', { exact: false }).count()) === 1,
  'подпись прямо отделяет «не видно» от «не проверял»',
);

// --- Разрез по классам работы -------------------------------------------
// Числа здесь для человека: он правит таблицу «класс → модель». Классификатору
// цена классов не сообщается никогда, иначе он пометит механикой всё подряд.

check(
  (await card.getByText('По классам работы', { exact: false }).count()) === 1,
  'разрез по классам показан',
);
check(
  (await card.getByText('прогонов: 1 · 400.0k tok', { exact: true }).count()) === 1,
  'у класса своё окно рядом с числом прогонов',
);
check(
  (await card.getByText('без класса', { exact: true }).count()) === 1,
  'ручной веер класса не называет — ему отдельная строка, а не молчание',
);
const kinds = await card.getByText(/^(mechanical|tests|без класса)$/).allInnerTexts();
check(
  kinds.join(',') === 'mechanical,tests,без класса',
  `порядок классов как у сервера: ${kinds.join(',')}`,
);

// Значки строк ищем точным совпадением: «проверок: 2» иначе находится и внутри
// сводки «без видимых проверок: 2».
check(
  (await card.getByText('проверок: 2', { exact: true }).count()) === 1,
  'у прогона с проверками их число',
);
check(
  (await card.getByText('проверок не видно', { exact: true }).count()) === 1,
  'один прогон без видимых проверок',
);
check(
  (await card.getByText('прогон упал', { exact: true }).count()) === 1,
  'упавший прогон подписан падением, а не отсутствием проверок',
);
check(
  (await card.getByText('C:/qa-lowered/qa-seen').count()) === 1,
  'строка знает каталог прогона',
);
check(
  (await card.getByText('claude-sonnet-5 · high').count()) === 1,
  'в строке развёрнутая модель и глубина',
);

// Порядок журнала — как отдал сервер: свежие сверху, панель не пересортировывает.
const rows = await card.getByText(/^C:\/qa-lowered\//).allInnerTexts();
check(
  rows.slice(0, 3).join(',') ===
    'C:/qa-lowered/qa-seen,C:/qa-lowered/qa-unseen,C:/qa-lowered/qa-failed',
  `порядок строк сохранён: ${rows.slice(0, 3).join(',')}`,
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Карточка понижённых прогонов честна' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
