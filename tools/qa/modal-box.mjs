/**
 * Замер коробки модального окна: общий кусок для `check-modal-stability.mjs` и
 * ручных замеров. Коробка — прямоугольник самого окна (`[role="dialog"]`) после
 * того, как оно перестало двигаться: появление идёт анимацией масштаба, и замер
 * посреди неё назвал бы «прыжком» обычный въезд.
 */

/** Допуск в пикселях: субпиксельное округление не прыжок, а один пиксель и больше — уже да. */
export const TOLERANCE = 1;

/**
 * Раскладка окна до 27.09.2026 — высота по содержимому между нижней границей
 * размера и 85vh, без запаса под полосу прокрутки. Мутант для проверки
 * проверки: с ней `check-modal-stability.mjs` обязан покраснеть.
 */
export const OLD_SIZING_CSS = `
[data-modal-size] { height: fit-content !important; max-height: 85vh !important; width: calc(100vw - 32px) !important; margin: auto !important; }
[data-modal-size="sm"] { min-height: min(280px, 70vh); max-width: 420px; }
[data-modal-size="md"] { min-height: min(420px, 75vh); max-width: 620px; }
[data-modal-size="lg"] { min-height: min(520px, 80vh); max-width: 880px; }
[data-modal-size="xl"] { min-height: min(620px, 85vh); max-width: 1380px; }
[data-modal-size="full"] { height: 92vh !important; max-height: 92vh !important; max-width: 1800px; }
[data-modal-body] { scrollbar-gutter: auto !important; }
`;

/** Верхнее видимое модальное окно (вложенные окна открываются поверх, последним). */
export const topDialog = (page) =>
  page.locator('[role="dialog"]:not([aria-modal="false"])').filter({ visible: true }).last();

/**
 * Прямоугольник окна, когда он три замера подряд не меняется, — иначе то, что
 * было на последнем замере (и пометка `moving`, чтобы отчёт не выдал анимацию за
 * покой).
 */
export async function settledBox(dialog, { timeout = 3000 } = {}) {
  const read = () =>
    dialog.evaluate(
      (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      },
      null,
      { timeout: 5000 },
    );
  let last = await read();
  let calm = 0;
  for (let waited = 0; waited < timeout; waited += 60) {
    await dialog.page().waitForTimeout(60);
    const next = await read();
    calm = sameBox(last, next, 0.5) ? calm + 1 : 0;
    last = next;
    if (calm >= 3) return round(last);
  }
  return { ...round(last), moving: true };
}

const round = (b) => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  w: Math.round(b.w),
  h: Math.round(b.h),
});

export const sameBox = (a, b, tol = TOLERANCE) =>
  Math.abs(a.x - b.x) <= tol &&
  Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.w - b.w) <= tol &&
  Math.abs(a.h - b.h) <= tol;

export const boxText = (b) => `${b.w}×${b.h}@${b.x},${b.y}${b.moving ? '~' : ''}`;

/** Заголовок окна — по aria-labelledby, как его слышит скринридер. */
export const dialogTitle = (dialog) =>
  dialog.evaluate((node) => {
    const id = node.getAttribute('aria-labelledby');
    const title = id ? document.getElementById(id)?.textContent : node.getAttribute('aria-label');
    return (title ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  });

/**
 * Подброшенное содержимое: то, что делает окно «прыгающим», если его коробка
 * следует за содержимым, — очень длинное тело, пустое тело, строка ошибки.
 * Не зависит ни от каких данных стенда: проверяется сама оболочка окна.
 * Возвращает false, если тела не нашлось.
 */
export async function plant(dialog, kind) {
  return dialog.evaluate((node, kind) => {
    // Тело окна: у общего окна оно помечено `data-modal-body`. Без пометки
    // (старая вёрстка, чужое окно) — ребёнок окна с собственной прокруткой.
    const body =
      node.querySelector('[data-modal-body]') ??
      [...node.children].find((c) =>
        ['auto', 'scroll', 'hidden'].includes(getComputedStyle(c).overflowY),
      );
    if (!body) return false;
    node.querySelectorAll('[data-modal-plant]').forEach((el) => el.remove());
    body.querySelectorAll('[data-modal-hidden]').forEach((el) => {
      el.style.display = el.dataset.modalHidden;
      el.removeAttribute('data-modal-hidden');
    });
    if (kind === 'reset') return true;
    if (kind === 'empty') {
      for (const child of body.children) {
        child.dataset.modalHidden = child.style.display;
        child.style.display = 'none';
      }
      return true;
    }
    const block = document.createElement('div');
    block.dataset.modalPlant = kind;
    if (kind === 'tall') block.style.height = '3000px';
    if (kind === 'wide') {
      block.style.width = '4000px';
      block.style.height = '10px';
    }
    if (kind === 'error') {
      block.textContent = 'Поле заполнено неверно: проверьте значение и попробуйте снова.';
      block.style.padding = '8px 0';
    }
    body.appendChild(block);
    return true;
  }, kind);
}

/**
 * Страж запросов для прогона по живому стенду: всё, кроме GET, до сервера не
 * доходит, а GET можно придержать (`hold`) — окно, открытое при придержанных
 * ответах, показывает своё состояние загрузки, а `release` отдаёт ответы, и
 * окно доезжает до загруженного. Так «загрузка → данные» проверяется без
 * угадывания, успело ли что-то прийти.
 *
 * GET отдаётся следующему обработчику (`fallback`), чтобы подмены раздела и
 * обход онбординга продолжали работать. `stubbed` — адреса, чью запись
 * отвечает подмена раздела (`group-stubs.mjs` STUBBED): она уходит подмене,
 * а не обрывается, иначе шаг, ждущий ответа подмены, не наступил бы.
 */
export function requestGuard({ stubbed } = {}) {
  let holding = false;
  let floored = false;
  const held = [];
  // Нижний этаж: запись, которую не взяла ни одна подмена, обрывается здесь.
  const floor = async (route) => {
    try {
      if (route.request().method() !== 'GET') return await route.abort('blockedbyclient');
      return await route.fallback();
    } catch {
      /* вкладка уже закрыта */
    }
  };
  const handler = async (route) => {
    try {
      if (route.request().method() !== 'GET') {
        // Запись по адресу, который отвечает подмена раздела (`stubbed`), уходит
        // ей — подмена отвечает сама, до стенда запись не дойдёт; прочая
        // обрывается сразу. Подмена, которая зовёт `route.continue()`, отправила
        // бы запись прямо на стенд мимо нижнего этажа — поэтому обрыв здесь.
        if (stubbed?.test(route.request().url())) return await route.fallback();
        return await route.abort('blockedbyclient');
      }
      if (holding) {
        await new Promise((resolve) => held.push(resolve));
      }
      return await route.fallback();
    } catch {
      /* вкладка уже закрыта */
    }
  };
  return {
    handler,
    async install(page) {
      if (!floored) {
        await page.route('**/api/**', floor);
        floored = true;
      }
      await page.unroute('**/api/**', handler).catch(() => undefined);
      await page.route('**/api/**', handler);
    },
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      held.splice(0).forEach((resolve) => resolve());
    },
    get pending() {
      return held.length;
    },
  };
}

/** Ждёт стенд: он перезапускается от правок других агентов, и одна неудача — не повод падать. */
export async function waitForStand(base, { timeout = 120000 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const res = await fetch(base);
      if (res.ok) return true;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Полный замер одного открытого окна: открыто → загрузилось → каждая вкладка →
 * ввод и очистка поля → подброшенные длинное, пустое, широкое тело и строка
 * ошибки. `guard.release()` вызывается здесь, между «открыто» и «загрузилось».
 * Возвращает шаги с коробками; сравнение с первым шагом — дело вызывающего.
 */
export async function measureDialog(page, found, guard, { switchers = [] } = {}) {
  // Окно метится на первом замере и дальше меряется ТО ЖЕ: «верхнее видимое»
  // пересчитывалось бы на каждом шаге, и всплывшее поверх второе окно (ошибка
  // связи при придержанных ответах) выдало бы себя за прыжок первого.
  const mark = (locator) =>
    locator.evaluate((node) => node.setAttribute('data-modal-measured', ''), null, {
      timeout: 5000,
    });
  await mark(found);
  const dialog = page.locator('[data-modal-measured]');
  const title = await dialogTitle(dialog);
  const steps = [];
  const push = async (step) => {
    // Окно пересоздано (горячая перезагрузка стенда, смена ключа) — пометка
    // пропала вместе со старым узлом: метим новое верхнее окно и пишем об этом.
    // Верх занял ДРУГОЕ окно (стенд перезапустился и показал «Панель не
    // загрузилась») — это не прыжок, а сорванный замер: бросаем, вызывающий повторит.
    let remounted = false;
    if ((await dialog.count()) === 0) {
      const next = topDialog(page);
      const nextTitle = await dialogTitle(next);
      if (nextTitle !== title) throw new Error(`окно сменилось: «${title}» → «${nextTitle}»`);
      await mark(next);
      remounted = true;
    }
    const box = await settledBox(dialog);
    // Сколько содержимого не влезло в тело (прокручивается) — для выбора размера,
    // а не для вердикта: прокрутка внутри стоящего окна — не прыжок.
    const over = await dialog.evaluate((node) => {
      const body = node.querySelector('[data-modal-body]');
      return body ? Math.max(0, body.scrollHeight - body.clientHeight) : null;
    });
    steps.push({ step, ...box, over, ...(remounted ? { remounted } : {}) });
  };
  await push('open');
  guard?.release();
  await page.waitForTimeout(1500);
  await push('loaded');

  // Переключатели внутри окна: вкладки, кнопки с aria-pressed, радио — и те,
  // что вызывающий назвал сам (переключатель из простых кнопок ролью не выдаёт).
  const toggles = dialog.locator('[role="tab"], button[aria-pressed], [role="radio"]');
  const targets = [];
  for (let i = 0; i < Math.min(await toggles.count(), 8); i += 1) targets.push(toggles.nth(i));
  for (const name of switchers) targets.push(dialog.getByRole('button', { name, exact: true }));
  for (const tab of targets) {
    if ((await tab.count()) === 0) continue;
    if (!(await tab.first().isVisible()) || !(await tab.first().isEnabled())) continue;
    const name = ((await tab.first().textContent()) ?? '').trim().slice(0, 24);
    await tab
      .first()
      .click({ timeout: 2000 })
      .catch(() => undefined);
    await page.waitForTimeout(400);
    await push(`tab:${name}`);
  }

  const field = dialog.locator('input[type="text"], input:not([type]), textarea').first();
  if ((await field.count()) > 0 && (await field.isVisible()) && (await field.isEditable())) {
    await field.fill('!!! неверное значение @@@', { timeout: 2000 }).catch(() => undefined);
    await field.blur().catch(() => undefined);
    await page.waitForTimeout(400);
    await push('typed');
    await field.fill('', { timeout: 2000 }).catch(() => undefined);
    await field.blur().catch(() => undefined);
    await page.waitForTimeout(400);
    await push('cleared');
  }

  for (const kind of ['tall', 'empty', 'wide', 'error']) {
    if (!(await plant(dialog, kind))) break;
    await push(`plant:${kind}`);
  }
  await plant(dialog, 'reset');
  return steps;
}

/** Шаги, чья коробка отличается от первого замера. */
export const jumps = (steps) => steps.filter((s) => !sameBox(steps[0], s));

/**
 * Договор окна `size="fit"` другой: высота по содержимому до потолка, так что
 * рост от подброшенного тела — не прыжок. Нарушение — сдвиг по ширине или
 * горизонтали, шаг выше потолка (его задаёт длинное тело) и окно, которое не
 * следует за содержимым: пустое тело той же высоты, что длинное, — это окно,
 * растянутое до потолка (`height: auto` при `inset: 0`), а не fit.
 */
export function fitViolations(steps) {
  const first = steps[0];
  const tall = steps.find((s) => s.step === 'plant:tall');
  const empty = steps.find((s) => s.step === 'plant:empty');
  const bad = steps.filter(
    (s) =>
      Math.abs(s.w - first.w) > TOLERANCE ||
      Math.abs(s.x - first.x) > TOLERANCE ||
      (tall && s.h > tall.h + TOLERANCE),
  );
  if (tall && empty && empty.h >= tall.h - TOLERANCE) {
    bad.push({ ...empty, step: 'plant:empty (не следует за содержимым)' });
  }
  return bad;
}

/** Нарушения договора окна по его размеру: fit — свой договор, шкала — коробка. */
export const violations = (row) => (row.size === 'fit' ? fitViolations : jumps)(row.steps);
