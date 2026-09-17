/**
 * Кадры панели на ЖИВОМ стенде платформы компании: подключение, активация с пробным
 * запросом, маршрут и модель, правила и слои, настоящий прогон агента и меню
 * режимов. Контур настоящий, модель настоящая (локальная qwen2.5:0.5b за
 * контуром), CLI настоящий — подменено здесь только то, что уже приходит
 * от стенда.
 *
 * Порядок кадров повторяет путь человека, а не порядок разделов справки:
 * пробный запрос уходит на «Готово» мастера, и расход появляется только после
 * настоящего ответа.
 */
import {
  L,
  exact,
  mark,
  frameArea,
  openPlatformTab,
  pause,
  skipOnboarding,
  standKey,
  waitText,
} from './platform-shots-lib.mjs';

export const STAND_TITLE = L('Платформа компании · стенд', 'Company · stand');
export const STAND_ID = 'company-stand';
const MODEL = process.env.PLATFORM_MODEL ?? 'qwen2.5:0.5b';

const button = (page, ru, en) => page.getByRole('button', { name: exact(ru, en) }).first();

/** Подключение: мастер от пустого раздела до карточки. Кадры 09–16. */
export async function shootConnect({ page, web, shots, contourUrl }) {
  const connect = shots.connect;
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
  await pause(3000);
  await skipOnboarding(page);
  await connect.shot(page, '09-panel-empty');

  await button(page, 'Подключить контур', 'Connect a contour').click();
  await pause(700);
  // Поля ищутся внутри окна: у страницы под ним свои «Название» и «Адрес».
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByLabel(exact('Название', 'Name')).fill(STAND_TITLE);
  // Идентификатор из русского названия выходит пустым — вписывается руками.
  await dialog.getByLabel(exact('Идентификатор', 'Identifier')).fill(STAND_ID);
  await dialog.getByLabel(exact('Адрес API', 'API address')).fill(contourUrl);
  await pause(400);
  await connect.shot(page, '10-wizard-address', { clip: '[role="dialog"]' });

  // В мастере английская подпись длиннее, чем у кнопки карточки
  // (`platform.checkConnection`): без неё английский кадр 11 молча не снимался.
  const probe = page.getByRole('button', {
    name: exact('Проверить связь', 'Check the connection|Check connection'),
  });
  if (await probe.count()) {
    await probe.first().click();
    await pause(2500);
    await connect.shot(page, '11-wizard-probe', { clip: '[role="dialog"]' });
  }

  await button(page, 'Далее', 'Next').click();
  await pause(600);
  await dialog.getByLabel(exact('Ключ контура', 'Contour key')).fill(standKey());
  await pause(300);
  await connect.shot(page, '12-wizard-key', { clip: '[role="dialog"]' });

  await button(page, 'Далее', 'Next').click();
  await pause(4000);
  await connect.shot(page, '13-wizard-capabilities', { clip: '[role="dialog"]' });

  // Последний шаг выше окна: под списком потребителей стоят режим, бюджет и
  // день сброса — в 820px они уходят под срез.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await button(page, 'Далее', 'Next').click();
  await pause(1200);
  const chat = page
    .locator('[role="dialog"] label')
    .filter({ hasText: new RegExp(`^${L('Чат', 'Chat')}`) })
    .locator('input');
  if (await chat.count()) await chat.first().check();
  await pause(300);
  await connect.shot(page, '14-wizard-targets', { clip: '[role="dialog"]' });

  await button(page, 'Поднять шлюз', 'Start the gateway').click();
  await pause(3000);
  await connect.shot(page, '15-wizard-gateway', { clip: '[role="dialog"]' });

  await page.setViewportSize({ width: 1280, height: 820 });
  await button(page, 'Готово', 'Done').click();
  await pause(3000);
  await connect.shot(page, '16-panel-card');
}

/**
 * Пробный запрос, первый настоящий расход, возврат из настроек. Новый контур
 * мастер делает активным сам (`usePlatformWizard.finish`), и пробный запрос
 * уходит уже там — кнопка «Сделать активным» появляется только у второго.
 */
export async function shootActivate({ page, web, panel, shots }) {
  const { activate, connect } = shots;
  await waitText(page, new RegExp(L('Пробный запрос прошёл', 'Test request went through')), 90);
  await pause(800);
  let area = await frameArea(page, await mark(page, STAND_TITLE, 'stand-card'));
  await activate.shot(page, '01-smoke-ok', { clip: area });

  // Живой запрос через шлюз панели: два символа, чтобы доказать путь, а не
  // потратить бюджет. Адрес берётся у шлюза — занятый порт он отдаёт соседу.
  const gateway = await fetch(`${panel}/api/platforms/gateway`).then((r) => r.json());
  const address = gateway?.status?.address || '';
  if (!address) throw new Error(`шлюз панели не поднят: ${JSON.stringify(gateway).slice(0, 300)}`);
  const answer = await fetch(`${address}/${STAND_ID}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '2+2=' }],
      stream: false,
      max_tokens: 24,
    }),
  });
  console.log(`  живой запрос через шлюз: ${answer.status}`);
  if (!answer.ok) throw new Error('контур не ответил через шлюз панели');

  // Расход шлюз копит и сбрасывает на диск раз в несколько секунд
  // (`SPEND_FLUSH_MS`): снятый сразу кадр совпадал с кадром до запроса. Цены у
  // локальной модели нет, поэтому след запроса — строка «цены нет у».
  // Не появился — кадра нет, а причина напечатана: карточка без расхода под
  // подписью «расход после запроса» была бы неправдой (13.09.2026 так и было:
  // кадр `usage` стенда приходит с непустым `choices`, и шлюз его не узнаёт).
  const spent = new RegExp(L('цены нет у', 'no price for'));
  let seen = false;
  for (let i = 0; i < 5 && !seen; i += 1) {
    await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
    await pause(3500);
    seen = spent.test(await page.locator('body').innerText());
  }
  if (seen) {
    area = await frameArea(page, await mark(page, STAND_TITLE, 'stand-card'));
    await connect.shot(page, '17-panel-spend', { clip: area });
  } else {
    console.log('  кадр 17-panel-spend пропущен: расход живого запроса на карточке не появился');
  }

  // Второе место возврата — там, где живёт профиль, заведённый контуром.
  await page.setViewportSize({ width: 1280, height: 1100 });
  // Профиль контура живёт на вкладке «Модели» (`EndpointCard` → `ManagedProfileRow`).
  await page.goto(`${web}/settings?tab=models`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  const back = L('Вернуть провайдер по умолчанию', 'Back to the default provider');
  if (!(await page.getByRole('button', { name: exact(back, back) }).count())) {
    console.log('  кадр 02-return-settings пропущен: профиля контура на вкладке «Модели» нет');
    return;
  }
  // Только строка профиля (значок, чей он, кнопка): вся карточка эндпоинта —
  // две тысячи пикселей полей, к возврату не относящихся.
  // Лист — подпись внутри кнопки: кнопка — первый шаг вверх, строка — второй.
  area = await frameArea(page, await mark(page, back, 'return', 2), { min: 600, margin: 140 });
  // Поле в 4px: стандартные 16 захватывали край строки над областью.
  await activate.shot(page, '02-return-settings', { clip: area, padding: 4 });
}

/** Маршрут: модель на потребителя и то, что шапка чата говорит до отправки. */
export async function shootRoute({ page, web, shots }) {
  const { route } = shots;
  // Модель живёт на своей вкладке раздела.
  await openPlatformTab(page, web, 'model', STAND_TITLE);
  const area = await frameArea(
    page,
    await mark(
      page,
      L(`Модель контура · ${STAND_TITLE}`, `Contour model · ${STAND_TITLE}`),
      'model-card',
    ),
    // Липкая полоса вкладок сверху: без отступа верх карточки уходил под неё.
    { margin: 70 },
  );
  await route.shot(page, '01-model-card', { clip: area });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  await route.shot(page, '02-chat-header');
}

/** Правила контура, наша сторона и слои, матрица конфликтов. */
export async function shootRules({ page, web, shots }) {
  const { rules } = shots;
  // Правила — вкладка «Правила»: слева правила платформы, справа наши слои.
  await openPlatformTab(page, web, 'rules', STAND_TITLE);
  const card = await mark(
    page,
    L(`Правила контура · ${STAND_TITLE}`, `Contour rules · ${STAND_TITLE}`),
    'rules-card',
  );
  await frameArea(page, card, { max: 3200, margin: 70 });
  // «Наша сторона» — прослойка и слои одним блоком: слои лежат внутри него, и
  // отдельный кадр слоёв повторял бы половину этого.
  const parts = [
    ['01-rules-panel', L('Чем распоряжается панель', 'Managed by the panel')],
    ['02-rules-ours', L('Наша сторона', 'Our side')],
    ['03-rules-conflicts', L('Матрица конфликтов', 'Conflict matrix')],
  ];
  for (const [id, heading] of parts) {
    const area = await frameArea(page, await mark(page, heading, id, 1), { max: 1600, margin: 70 });
    // Блоки идут вплотную: стандартное поле затягивало в кадр заголовок соседа.
    await rules.shot(page, id, { clip: area, padding: 4 });
  }
}

/** Настоящий прогон агента через контур и карточка прослойки после него. */
export async function shootAgent({ page, web, shots }) {
  const { agent } = shots;
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  const box = page.locator('textarea').first();
  await box.fill(
    L('Создай файл hello.txt с одним словом: привет', 'Create hello.txt with one word: hello'),
  );
  await box.press('Enter');
  for (let i = 0; i < 60; i += 1) {
    await pause(3000);
    const running = await page.getByRole('button', { name: /Остановить|Stop/ }).count();
    if (i > 2 && !running) break;
  }
  await pause(1500);
  await agent.shot(page, '01-chat-run');

  // Карточка прослойки — вкладка «Инструменты и проверки».
  await openPlatformTab(page, web, 'tools');
  const area = await frameArea(
    page,
    await mark(page, L('Инструменты через контур', 'Tools through the contour'), 'shim-card'),
    { margin: 70 },
  );
  await agent.shot(page, '02-shim-card', { clip: area });
}

/** Меню режимов на живом стенде: у ключа нет рисующей модели. */
export async function shootMedia({ page, web, shots }) {
  const { media } = shots;
  await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  let area = await frameArea(
    page,
    await mark(page, L('Рисование картинок', 'Image generation'), 'draw-row', 1),
    {
      min: 300,
    },
  );
  await media.shot(page, '01-capability-row', { clip: area, padding: 6 });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  await page
    .getByRole('button', { name: /^(Сообщение|Message)/ })
    .first()
    .click();
  await pause(2500);
  area = '[role="menu"], [role="listbox"], [role="dialog"]';
  await media.shot(page, '02-mode-menu', { clip: area, padding: 24 });
  await page.keyboard.press('Escape');
}

/** Удаление — последний кадр подключения и последний шаг всей съёмки. */
export async function shootDelete({ page, web, shots, title = STAND_TITLE }) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(`${web}/platform`, { waitUntil: 'domcontentloaded' });
  await pause(3500);
  await mark(page, title, 'delete-card');
  await page
    .locator('[data-shot="delete-card"]')
    .getByRole('button', { name: exact('Удалить', 'Delete') })
    .click();
  await pause(1000);
  await shots.connect.shot(page, '18-panel-delete', { clip: '[role="dialog"]' });
  await page.keyboard.press('Escape');
}
