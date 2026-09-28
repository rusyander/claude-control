/**
 * Окно шага и вставка «+» на вкладке «Порядок работы».
 *
 * Окно шага: щелчок по строке открывает окно поверх окна группы — что это и
 * откуда, файл, где стоит, полный текст (обе стороны своего шага), числа с
 * цитатой; Escape закрывает только его. «+»: вставка встаёт ровно после той
 * строки, где нажата (стадия этого места, порядок среди соседей), путь
 * «Подготовить» → вопросы ассистента → черновик → «Подтвердить» → «сделать
 * ресурсом» или «оставить промптом панели».
 *
 * Вариации: ассистент отвечает с задержкой (окно занято, «Подтвердить»
 * закрыто), одна сторона пуста (сохранить нельзя), ассистент отказал (ничего
 * не записано), тёмная тема.
 *
 * Запуск: `node tools/qa/check-group-steps.mjs` при поднятом `pnpm dev`.
 * Снимки: `.agent/screenshots/before-after/group-cards/check-steps-*.png`.
 */
import { PAIR, SITE, lastSteps, pathList, rowTitles, startRun, visible } from './group-harness.mjs';

const SHOTS = '.agent/screenshots/before-after/group-cards';
const { check, openPage, finish } = await startRun(SHOTS);
const GROUP = 'qa-shop-order-global';

// ---------- 1. Окно шага ----------
{
  const { page, errors, close, open } = await openPage();
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });

  // Свой шаг: происхождение, файл данных панели, обе стороны текста, проверка.
  await list.getByRole('button', { name: /^Прогнать e2e/ }).click();
  const step = page.getByRole('dialog', { name: 'Прогнать e2e', exact: true });
  await step.waitFor({ timeout: 5000 });
  check(
    await visible(step.getByText('Промпт, который панель хранит', { exact: false })),
    'окно своего шага называет происхождение',
  );
  check(await visible(step.getByText('state.json', { exact: false })), 'и файл, где шаг лежит');
  check(await visible(step.getByText('После стадии «Ревью».')), 'и где шаг стоит');
  check(await visible(step.getByText('Прогони e2e и приложи отчёт.')), 'русская сторона целиком');
  check(
    await visible(step.getByText('Run e2e and attach the report.')),
    'и английская, что уходит в прогон',
  );
  check(await visible(step.getByText('отчёт e2e зелёный')), 'и проверка «готово, когда»');
  await page.screenshot({ path: `${SHOTS}/check-steps-modal-light.png` });
  await page.keyboard.press('Escape');
  await step.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
  check(!(await visible(step)), 'Escape закрывает окно шага');
  check(await visible(dialog), 'а окно группы остаётся');

  // Шаг скилла: номер в скилле и числа с цитатой.
  await list.getByRole('button', { name: /^Взять тикет и завести ветку/ }).click();
  const skill = page.getByRole('dialog', { name: 'Взять тикет и завести ветку', exact: true });
  await skill.waitFor({ timeout: 5000 });
  check(
    await visible(skill.getByText('шаг 1 скилла ticket-delivery', { exact: false })),
    'шаг скилла: его номер в скилле',
  );
  const quotes = await skill.getByText('Из текста скилла:', { exact: false }).count();
  check(quotes >= 1, 'числа шага — с цитатой из скилла', `цитат: ${quotes}`);
  check(
    (await skill.getByRole('combobox', { name: /^Кругов ревью/ }).count()) +
      (await list.getByRole('combobox', { name: /^Кругов ревью/ }).count()) >=
      1,
    'выбор числа есть и в окне, и в строке',
  );
  await page.keyboard.press('Escape');

  // Стадия конвейера: номер из шести, правки нет.
  await list.getByRole('button', { name: /^Разбор задачи/ }).click();
  const stage = page.getByRole('dialog', { name: 'Разбор задачи', exact: true });
  await stage.waitFor({ timeout: 5000 });
  check(await visible(stage.getByText('Стадия конвейера 1 из 6.')), 'стадия: её место в конвейере');
  check(
    (await stage.getByRole('button', { name: 'Редактировать' }).count()) === 0,
    'стадию из окна не правят',
  );
  await page.keyboard.press('Escape');

  // Правка из окна шага: редактор встаёт поверх, окно шага остаётся под ним.
  await list.getByRole('button', { name: /^Прогнать e2e/ }).click();
  await step.getByRole('button', { name: 'Редактировать' }).click();
  const editor = page.getByRole('dialog', { name: 'Правка шага' });
  await editor.waitFor({ timeout: 5000 });
  check(await visible(editor), '«Редактировать» открывает правку шага');
  await editor.getByRole('button', { name: 'Отмена' }).click();
  check(await visible(step), 'после отмены окно шага на месте');

  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 2. «+» после шага скилла: место вставки и «оставить промптом» ----------
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  // «+» внутри блока скилла ставит шаг В скилл (тот же ход), окно так и говорит.
  await list
    .getByRole('button', { name: 'Добавить шаг после «Взять тикет и завести ветку»' })
    .click();
  const inside = page.getByRole('dialog', { name: 'Новый шаг' });
  await inside.waitFor({ timeout: 5000 });
  check(
    await visible(
      inside.getByText('Встанет внутрь скилла ticket-delivery, сразу после его шага', {
        exact: false,
      }),
    ),
    '«+» в блоке скилла — вставка внутрь скилла, в том же ходе',
  );
  await inside.getByRole('button', { name: 'Отмена' }).click();
  await inside.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
  await list.getByRole('button', { name: 'Добавить шаг после «Сделать и проверить»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 5000 });
  check(
    await visible(composer.getByText('Встанет после стадии «Работа»')),
    'вставка после шага скилла — в стадию «Работа»',
  );
  await composer.getByLabel('Что сделать на этом шаге').fill('сверить с макетом');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer.getByLabel('Ваш ответ').waitFor({ timeout: 6000 });
  await composer.getByLabel('Ваш ответ').fill('макет в описании тикета');
  await composer.getByRole('button', { name: 'Ответить' }).click();
  await composer.getByText('Шаг готов', { exact: false }).waitFor({ timeout: 6000 });
  await composer.getByRole('button', { name: 'Подтвердить' }).click();
  const promote = page.getByRole('dialog', { name: 'Скилл, хук или правило — или промпт панели?' });
  await promote.waitFor({ timeout: 6000 });
  await promote.getByRole('button', { name: 'Оставить промптом панели' }).click();
  await page.waitForTimeout(700);
  const saved = lastSteps(state, GROUP) ?? [];
  const added = saved.find((item) => !['s-e2e', 's-rel'].includes(item.id));
  check(
    added?.anchor === 'work',
    'новый шаг сохранён в стадии «Работа»',
    JSON.stringify(added?.anchor),
  );
  check(
    !state.calls.some((call) => call.path.endsWith('/path/promote')),
    '«оставить промптом» ничего не превращает',
  );
  check(!(await visible(promote)), 'окно вопроса закрыто');
  const titles = await rowTitles(list);
  const skillAt = titles.findIndex((title) => title.startsWith('Сделать и проверить'));
  check(
    titles[skillAt + 1]?.startsWith('Прогнать e2e на стенде') === true,
    'новый шаг встал ровно после строки, где нажат «+»',
    titles[skillAt + 1],
  );
  await close();
}

// ---------- 3. Ассистент: задержка, вопросы, языки, перевод, «сделать скиллом» ----------
{
  const { page, state, errors, close, open } = await openPage({
    delay: [[/\/path\/draft$/, 1500]],
  });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «Ревью»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 5000 });
  check(
    await visible(composer.getByText('Встанет после стадии «Ревью»')),
    'окно называет место вставки',
  );
  const confirmButton = composer.getByRole('button', { name: 'Подтвердить' });
  check(await confirmButton.isDisabled(), 'без черновика «Подтвердить» закрыто');

  await composer
    .getByLabel('Что сделать на этом шаге')
    .fill('после ревью прогнать e2e и приложить отчёт');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await page.waitForTimeout(400);
  check(
    await visible(composer.getByText('Ассистент разбирает шаг…')),
    'пока ассистент думает, это видно',
  );
  check(await confirmButton.isDisabled(), 'и «Подтвердить» закрыто, пока он думает');
  await composer.getByText('На каком стенде гонять e2e?').waitFor({ timeout: 6000 });
  check(
    await visible(composer.getByText('Есть похожий скилл «e2e-runner»', { exact: false })),
    'ассистент называет похожий ресурс',
  );
  await composer.getByLabel('Ваш ответ').fill('локальный стенд, отчёт в описание MR');
  await composer.getByRole('button', { name: 'Ответить' }).click();
  await composer
    .getByText('Шаг готов — проверьте его ниже и подтвердите.')
    .waitFor({ timeout: 6000 })
    .catch(() => undefined);
  const drafts = state.calls.filter((call) => call.path.endsWith('/path/draft'));
  check(drafts[1]?.body?.conversationId === 'conv-1', 'ответ идёт тем же разговором');
  check(
    (await composer.getByLabel('Название шага').inputValue()) === 'Прогнать e2e на стенде',
    'черновик пришёл в RU',
  );
  await page.screenshot({ path: `${SHOTS}/check-steps-composer-light.png` });

  const langTabs = composer.getByRole('tablist', { name: 'Язык шага' });
  await langTabs.getByRole('tab', { name: 'RU' }).focus();
  await page.keyboard.press('ArrowRight');
  check(
    (await langTabs.getByRole('tab', { name: 'EN' }).getAttribute('aria-selected')) === 'true',
    'стрелка переключает на EN',
  );
  const prompt = composer.getByLabel('Текст для модели');
  await prompt.fill('');
  check(
    await visible(composer.getByText('Сторона EN пуста — без неё шаг не сохранить.')),
    'пустая сторона названа',
  );
  check(await confirmButton.isDisabled(), 'с пустой стороной «Подтвердить» закрыто');
  await prompt.fill('Run e2e on the local stand and attach the report.');
  check(
    await visible(composer.getByText('Вы правили EN — сторона RU устарела.', { exact: false })),
    'правка одной стороны просит перевести другую',
  );
  await composer.getByRole('button', { name: 'Перевести на RU', exact: true }).click();
  await composer
    .getByText('Вы правили EN')
    .waitFor({ state: 'hidden', timeout: 6000 })
    .catch(() => undefined);
  const translate = state.calls.filter((call) => call.path.endsWith('/path/draft')).at(-1);
  check(
    translate?.body?.mode === 'translate' && translate?.body?.lang === 'en',
    'перевод просится с правленой стороны',
  );

  await confirmButton.click();
  const promote = page.getByRole('dialog', { name: 'Скилл, хук или правило — или промпт панели?' });
  await promote.waitFor({ timeout: 6000 }).catch(() => undefined);
  const saved = (lastSteps(state, GROUP) ?? []).find(
    (item) => !['s-e2e', 's-rel'].includes(item.id),
  );
  check(
    saved?.anchor === 'review' && Boolean(saved?.prompt?.ru) && Boolean(saved?.prompt?.en),
    'шаг сохранён после ревью с обеими сторонами',
  );
  const neighbour = (lastSteps(state, GROUP) ?? []).find((item) => item.id === 's-e2e');
  check(
    saved?.order === 0 && neighbour?.order === 1,
    '«+» после стадии ставит шаг первым в ней, соседа — следом',
    JSON.stringify([saved?.order, neighbour?.order]),
  );
  check(
    await visible(promote.getByText('name: e2e-on-stand', { exact: false })),
    'вопрос показывает черновик файла',
  );
  await page.screenshot({ path: `${SHOTS}/check-steps-promote-light.png` });
  await promote.getByRole('button', { name: 'Сделать: скилл' }).click();
  await page.waitForTimeout(2200);
  const promoteCall = state.calls.find((call) => call.path.endsWith('/path/promote'));
  check(
    promoteCall?.body?.stepId === saved?.id && promoteCall?.body?.type === 'skill',
    'превращается именно сохранённый шаг',
  );
  check(
    await visible(
      pathList(dialog).getByRole('button', { name: /^Прогнать e2e на стенде (наш|чужой) скилл$/ }),
    ),
    'шаг в пути помечен видом «скилл»',
  );
  check(errors.length === 0, 'ошибок консоли нет', errors.join(' | '));
  await close();
}

// ---------- 4. Негатив: ассистент отказал ----------
{
  const { page, state, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/groups/*/path/draft', (route) =>
        route.fulfill({ status: 502, json: { error: 'модель недоступна' } }),
      ),
  });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «План»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByLabel('Что сделать на этом шаге').fill('шаг');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer
    .getByRole('alert')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check(
    await visible(composer.getByText('Ассистент не ответил. Повторите.')),
    'отказ ассистента назван словами',
  );
  check(
    await composer.getByRole('button', { name: 'Подтвердить' }).isDisabled(),
    'без черновика сохранить нечего',
  );
  check(!state.calls.some((call) => call.path.endsWith('/path/steps')), 'ничего не записано');
  await close();
}

// ---------- 4б. Правка RU без перевода: «Подтвердить» сначала переводит ----------
// Прогон читает только EN. Раньше «Подтвердить» сохранял правленый RU рядом со
// старым EN — человек читал новый шаг, модель делала старый.
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Править шаг «Прогнать e2e»' }).click();
  const composer = page.getByRole('dialog', { name: /Правка шага/ });
  await composer.waitFor({ timeout: 6000 });
  await composer.getByLabel('Текст для модели').fill('Прогони только smoke-набор.');
  await composer.getByLabel('Готово, когда').fill('smoke зелёный');
  const confirm = composer.getByRole('button', { name: 'Перевести на EN и подтвердить' });
  check(await visible(confirm), 'после правки RU кнопка говорит, что сначала переведёт');
  await confirm.click();
  await page.waitForTimeout(1200);
  const translate = state.calls.filter((call) => call.path.endsWith('/path/draft')).at(-1);
  check(
    translate?.body?.mode === 'translate' &&
      translate?.body?.current?.prompt?.ru === 'Прогони только smoke-набор.' &&
      translate?.body?.current?.gate?.ru === 'smoke зелёный',
    'переводчик получает шаг из окна целиком — промпт и условие',
    JSON.stringify(translate?.body?.current ?? null),
  );
  const saved = (lastSteps(state, GROUP) ?? []).find((item) => item.id === 's-e2e');
  check(
    saved?.prompt?.en === '(en) Прогони только smoke-набор.' &&
      saved?.gate?.en === '(en) smoke зелёный',
    'сохранён ПЕРЕВЕДЁННЫЙ EN, а не старый',
    JSON.stringify({ prompt: saved?.prompt?.en, gate: saved?.gate?.en }),
  );
  await close();
}

// ---------- 4в. Переводчик вернул пустую сторону: не сохраняем ----------
{
  const { page, state, close, open } = await openPage({
    patch: (target) =>
      target.route('**/api/groups/*/path/draft', (route) =>
        route.fulfill({
          json: {
            conversationId: 'conv-1',
            proposal: {
              similar: [],
              questions: [],
              title: { ru: '', en: '' },
              prompt: { ru: '', en: '' },
            },
          },
        }),
      ),
  });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Править шаг «Прогнать e2e»' }).click();
  const composer = page.getByRole('dialog', { name: /Правка шага/ });
  await composer.waitFor({ timeout: 6000 });
  await composer.getByLabel('Текст для модели').fill('Прогони только smoke-набор.');
  await composer.getByRole('button', { name: 'Перевести на EN и подтвердить' }).click();
  await page.waitForTimeout(1200);
  check(
    await visible(composer.getByText('Перевод пришёл неполным', { exact: false })),
    'неполный перевод назван словами',
  );
  check(!state.calls.some((call) => call.path.endsWith('/path/steps')), 'и ничего не записано');
  await close();
}

// ---------- 4д. Перенесённый шаг «нужен перевод»: «Подтвердить» без правки переводит (F-72) ----------
// Текст один на обе стороны: прежде подтверждение без правки снимало пометку, а
// прогон читал русский текст как английский.
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(SITE);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Править шаг «Сверить с макетом»' }).click();
  const composer = page.getByRole('dialog', { name: /Правка шага/ });
  await composer.waitFor({ timeout: 6000 });
  const confirm = composer.getByRole('button', { name: 'Перевести на EN и подтвердить' });
  check(await visible(confirm), 'шаг без перевода: кнопка говорит, что сначала переведёт');
  await confirm.click();
  await page.waitForTimeout(1200);
  const translate = state.calls.filter((call) => call.path.endsWith('/path/draft')).at(-1);
  check(
    translate?.body?.mode === 'translate' && translate?.body?.lang === 'ru',
    'подтверждение ушло переводом с RU',
    JSON.stringify({ mode: translate?.body?.mode, lang: translate?.body?.lang }),
  );
  const saved = (lastSteps(state, 'qa-site-docs') ?? []).find((item) => item.id === 's-old');
  check(
    saved?.prompt?.en === '(en) Сверь страницу с макетом.' && !saved?.needsTranslation,
    'сохранён переведённый EN, пометка снята только после перевода',
    JSON.stringify({ en: saved?.prompt?.en, needs: saved?.needsTranslation }),
  );
  await close();
}

// ---------- 4е. Правлены обе стороны: окно спрашивает, перевод не затирает правку (F-74) ----------
{
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Править шаг «Прогнать e2e»' }).click();
  const composer = page.getByRole('dialog', { name: /Правка шага/ });
  await composer.waitFor({ timeout: 6000 });
  await composer.getByLabel('Текст для модели').fill('RU правка человека.');
  await composer.getByRole('tab', { name: 'EN', exact: true }).click();
  await composer.getByLabel('Текст для модели').fill('EN fix by the human.');
  const question = composer.getByText('Правлены обе стороны', { exact: false });
  check(await visible(question), 'правка обеих сторон — окно спрашивает, какую взять');
  const footer = composer.getByRole('button', { name: /подтвердить$/i }).last();
  check(await footer.isDisabled(), 'пока не выбрано, «Подтвердить» закрыт');
  await composer.getByRole('button', { name: 'Оставить обе как написаны' }).click();
  const plain = composer.getByRole('button', { name: 'Подтвердить', exact: true });
  await plain.click();
  await page.waitForTimeout(1000);
  const translations = state.calls.filter(
    (call) => call.path.endsWith('/path/draft') && call.body?.mode === 'translate',
  );
  check(translations.length === 0, 'перевода не было', String(translations.length));
  const saved = (lastSteps(state, GROUP) ?? []).find((item) => item.id === 's-e2e');
  check(
    saved?.prompt?.ru === 'RU правка человека.' && saved?.prompt?.en === 'EN fix by the human.',
    'сохранены обе правки человека как написаны',
    JSON.stringify(saved?.prompt),
  );
  await close();
}
{
  // Перевод по выбору: «EN → RU» переводит с EN — сторону называет человек.
  const { page, state, close, open } = await openPage();
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog).getByRole('button', { name: 'Править шаг «Прогнать e2e»' }).click();
  const composer = page.getByRole('dialog', { name: /Правка шага/ });
  await composer.waitFor({ timeout: 6000 });
  await composer.getByLabel('Текст для модели').fill('RU правка человека.');
  await composer.getByRole('tab', { name: 'EN', exact: true }).click();
  await composer.getByLabel('Текст для модели').fill('EN fix by the human.');
  await composer.getByRole('button', { name: 'Перевести EN → RU' }).click();
  await page.waitForTimeout(1000);
  const translate = state.calls.filter((call) => call.path.endsWith('/path/draft')).at(-1);
  check(
    translate?.body?.mode === 'translate' && translate?.body?.lang === 'en',
    '«Перевести EN → RU» переводит с EN',
    JSON.stringify({ mode: translate?.body?.mode, lang: translate?.body?.lang }),
  );
  check(
    !(await visible(composer.getByText('Правлены обе стороны', { exact: false }))),
    'после перевода вопрос снят',
  );
  await close();
}

// ---------- 4г. Ассистент нашёл готовый ресурс: ссылка — выбор человека ----------
// Разбор: «Подтвердить» молча превращал шаг в ссылку на найденный ресурс,
// выбора «оставить мой текст» не было.
for (const keep of [false, true]) {
  const { page, state, close, open } = await openPage();
  state.draftMatch = { type: 'skill', id: 'e2e-runner', why: 'гоняет e2e и собирает отчёт' };
  const dialog = await open(PAIR);
  const list = pathList(dialog);
  await list.waitFor({ timeout: 15000 });
  await list.getByRole('button', { name: 'Добавить шаг после «Сделать и проверить»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.waitFor({ timeout: 5000 });
  await composer.getByLabel('Что сделать на этом шаге').fill('прогнать e2e');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer.getByLabel('Ваш ответ').waitFor({ timeout: 6000 });
  await composer.getByLabel('Ваш ответ').fill('на локальном');
  await composer.getByRole('button', { name: 'Ответить' }).click();
  const toggle = composer.getByRole('switch', {
    name: 'Шаг сошлётся на скилл «e2e-runner», а не повторит его текстом',
  });
  await toggle.waitFor({ timeout: 6000 }).catch(() => undefined);
  check(await visible(toggle), `${keep ? 'текст' : 'ссылка'}: выбор «сослаться» виден`);
  check(
    (await toggle.getAttribute('aria-checked').catch(() => null)) === 'true',
    `${keep ? 'текст' : 'ссылка'}: по умолчанию — ссылка на найденный`,
  );
  if (keep) {
    await toggle.click();
    check(
      await visible(composer.getByText('Шаг останется вашим текстом', { exact: false })),
      'текст: выключено — сказано, что шаг останется текстом',
    );
  }
  await composer.getByRole('button', { name: 'Подтвердить' }).click();
  if (keep) {
    const promote = page.getByRole('dialog', {
      name: 'Скилл, хук или правило — или промпт панели?',
    });
    await promote.waitFor({ timeout: 6000 }).catch(() => undefined);
    if (await visible(promote)) {
      await promote.getByRole('button', { name: 'Оставить промптом панели' }).click();
    }
  }
  await page.waitForTimeout(700);
  const added = (lastSteps(state, GROUP) ?? []).find(
    (item) => !['s-e2e', 's-rel'].includes(item.id),
  );
  if (keep) {
    check(
      added?.kind === 'prompt' && !added?.resource,
      'текст: сохранён шаг своим текстом, без ссылки',
      JSON.stringify({ kind: added?.kind, resource: added?.resource }),
    );
  } else {
    check(
      added?.kind === 'resource' && added?.resource?.id === 'e2e-runner',
      'ссылка: сохранён шаг-ссылка на найденный скилл',
      JSON.stringify({ kind: added?.kind, resource: added?.resource }),
    );
  }
  await close();
}

// ---------- 5. Тёмная тема: окно шага и редактор ----------
{
  const { page, close, open } = await openPage({ theme: 'dark' });
  const dialog = await open(PAIR);
  await pathList(dialog).waitFor({ timeout: 15000 });
  await pathList(dialog)
    .getByRole('button', { name: /^Взять тикет и завести ветку/ })
    .click();
  await page.getByRole('dialog', { name: 'Взять тикет и завести ветку', exact: true }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/check-steps-modal-dark.png` });
  await page.keyboard.press('Escape');
  await pathList(dialog).getByRole('button', { name: 'Добавить шаг после «Ревью»' }).click();
  const composer = page.getByRole('dialog', { name: 'Новый шаг' });
  await composer.getByLabel('Что сделать на этом шаге').fill('прогнать e2e');
  await composer.getByRole('button', { name: 'Подготовить' }).click();
  await composer.getByText('На каком стенде гонять e2e?').waitFor({ timeout: 6000 });
  await page.screenshot({ path: `${SHOTS}/check-steps-composer-dark.png` });
  await close();
}

await finish('Окно шага и вставка работают');
