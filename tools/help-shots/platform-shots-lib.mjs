/**
 * Общие приёмы съёмки раздела «Контур»: язык подписей кнопок, пометка области
 * кадра и ожидания, которые одинаковы у живого стенда и у сценарного контура.
 *
 * Область кадра помечается атрибутом `data-shot` прямо в разметке: набор
 * `kit.mjs` принимает селектор, а у карточек раздела нет ни идентификаторов,
 * ни ролей — искать их приходится по заголовку. Атрибут на вид не влияет.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shotLanguage } from './kit.mjs';

export const LANG = shotLanguage();

/** Подпись на языке съёмки: интерфейс в кадре переведён, и кнопки вместе с ним. */
export const L = (ru, en) => (LANG === 'en' ? en : ru);

/** Точное имя кнопки на обоих языках — для `getByRole`. */
export const exact = (ru, en) => new RegExp(`^\\s*(${ru}|${en})\\s*$`);

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ключ стенда: читается из личного хранилища и нигде не печатается. */
export function standKey() {
  const file = join(homedir(), '.agentdeck', 'enterprise-platform-credentials.env');
  const key = readFileSync(file, 'utf8')
    .match(/^ENTERPRISE_PLATFORM_LOCAL_INST_KEY=(.+)$/m)?.[1]
    ?.trim();
  if (!key) throw new Error(`в ${file} нет ENTERPRISE_PLATFORM_LOCAL_INST_KEY`);
  return key;
}

/**
 * Пометить область кадра по тексту листового узла.
 *
 * @param mode `card` — ближайшая карточка вокруг текста; число — столько
 *             родителей вверх от узла с текстом.
 */
export async function mark(page, text, name, mode = 'card') {
  const found = await page.evaluate(
    ([wanted, attr, how]) => {
      const leaves = [...document.querySelectorAll('main *, [role="dialog"] *')].filter(
        (node) =>
          node.childElementCount === 0 &&
          (typeof wanted === 'string' ? (node.textContent ?? '').trim().startsWith(wanted) : false),
      );
      const leaf = leaves[0];
      if (!leaf) return false;
      let target = leaf;
      // Корень `shared/ui/card` — единственный носитель класса отступа
      // `padding-*`; «card» в имени класса CSS-модуль не оставляет.
      if (how === 'card') target = leaf.closest('[class*="_padding-"]') ?? leaf.parentElement;
      else
        for (let step = 0; step < how && target.parentElement; step += 1)
          target = target.parentElement;
      for (const old of document.querySelectorAll(`[data-shot="${attr}"]`))
        old.removeAttribute('data-shot');
      target.setAttribute('data-shot', attr);
      return true;
    },
    [text, name, mode],
  );
  if (!found) throw new Error(`область «${name}»: текст «${text}» на странице не найден`);
  return `[data-shot="${name}"]`;
}

/**
 * Подготовить помеченную область: окно по её высоте, сама область в виду.
 * Страница прокручивает внутренний контейнер, а не окно, и область выше окна
 * набор срезал бы по краю — поэтому окно растёт раньше прокрутки.
 *
 * @param margin отступ сверху при прокрутке: у настроек липкая полоса вкладок,
 *               и без него область уезжает под неё.
 */
export async function frameArea(page, selector, { min = 820, max = 2400, margin = 0 } = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`область ${selector} не видна`);
  const height = Math.min(max, Math.max(min, Math.ceil(box.height) + 80));
  await page.setViewportSize({ width: 1280, height });
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await page.evaluate(
    ([sel, top]) => {
      const node = document.querySelector(sel);
      if (!(node instanceof HTMLElement)) return;
      node.style.scrollMarginTop = `${top}px`;
      node.scrollIntoView({ block: 'start' });
    },
    [selector, margin],
  );
  await pause(400);
  return selector;
}

/** Закрыть приветствие свежей панели по-настоящему, а не подменой настроек. */
export async function skipOnboarding(page) {
  const skip = page.getByRole('button', { name: exact('Пропустить', 'Skip') });
  if (await skip.count()) {
    await skip.first().click();
    await pause(1200);
  }
}

/** Дождаться, пока текст появится на странице; не появился — упасть с его именем. */
export async function waitText(page, pattern, seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const body = await page.locator('body').innerText();
    if (pattern.test(body)) return;
    await pause(500);
  }
  throw new Error(`не дождался на странице: ${pattern}`);
}

/** Один запрос API панели. */
export async function api(panel, path, init = {}) {
  const res = await fetch(`${panel}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
