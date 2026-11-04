/**
 * Закрытие марки платформы в кадрах справки (`tools/help-shots/brand-mask.mjs`) — на настоящей
 * странице Chromium, тем же проходом, что зовёт `shot()` набора съёмки перед каждым кадром.
 *
 * Сторож обязан краснеть: та же страница БЕЗ закрытия (`mask: false`) — это кадр, снятый мимо
 * закрытия, и проход обязан назвать текст, поле и логотип. С закрытием — ни одной находки, слово
 * заменено, логотип скрыт, а логотип самой панели (без слова марки) на стороне панели остаётся.
 *
 * Марка здесь вымышленная; если рядом лежит настоящий список (`.agent/private/brand-mask.txt`),
 * то же проверяется и его словами — сами слова не печатаются.
 *
 * Запуск: node tools/qa/check-brand-mask.mjs
 */
import { chromium } from 'playwright';
import { brandPass, readBrandMask } from '../help-shots/brand-mask.mjs';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const page_ = (word) => `<!doctype html><html><body>
  <header><img class="app-logo" alt="${word} logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
    width="40" height="20"><span>${word.toUpperCase()} Admin</span></header>
  <nav><svg id="panel-mark" width="20" height="20"><rect width="20" height="20"/></svg></nav>
  <aside><div id="mark-tile" style="width:48px;height:48px;background:#7c3aed"><svg id="named-mark"
    width="29" height="29" role="img" aria-label="${word}"><rect width="29" height="29"/></svg></div></aside>
  <main><p>Ключи инстанса ${word} · api.${word}.example</p>
    <input id="host" value="https://inst.${word}.example">
    <input id="hint" placeholder="Войти в ${word}"></main>
</body></html>`;

async function round(browser, brand, label) {
  const word = brand.words[0];
  const page = await browser.newPage();
  try {
    await page.setContent(page_(word));
    const raw = await brandPass(page, brand, { mask: false, anyLogo: true });
    check(
      raw.leaks.some((leak) => leak.startsWith('текст')) &&
        raw.leaks.some((leak) => leak.startsWith('поле')) &&
        raw.leaks.some((leak) => leak.startsWith('логотип')),
      `${label}: кадр без закрытия краснеет — ${raw.leaks.join(', ') || 'находок нет'}`,
    );

    const done = await brandPass(page, brand, { mask: true, anyLogo: true });
    check(done.leaks.length === 0, `${label}: после закрытия находок нет (закрыто ${done.masked})`);
    const body = await page.locator('body').innerText();
    const fields = await page.$$eval('input', (nodes) =>
      nodes.map((node) => `${node.value} ${node.placeholder}`).join(' '),
    );
    const left = brand.words.some((w) =>
      `${body} ${fields}`.toLowerCase().includes(w.toLowerCase()),
    );
    check(!left, `${label}: слова марки не осталось ни в тексте, ни в полях`);
    check(body.includes(brand.replace), `${label}: на месте слова — замена «${brand.replace}»`);
    const logoHidden = await page.$eval('img.app-logo', (n) => getComputedStyle(n).visibility);
    check(logoHidden === 'hidden', `${label}: логотип скрыт (${logoHidden})`);
    // Знак, названный маркой только в `aria-label` (без «logo» в классе и подписи): подпись
    // заменяется тем же проходом, и знак обязан быть найден ДО замены. Плашка-обёртка знака
    // скрывается вместе с ним — пустой цветной квадрат на месте марки тоже её примета.
    const tile = await page.$eval('#mark-tile', (n) => getComputedStyle(n).visibility);
    check(
      tile === 'hidden',
      `${label}: знак с маркой в aria-label скрыт вместе с плашкой (${tile})`,
    );

    // Сторона панели: свой логотип без слова марки не трогается.
    await page.setContent(page_(word).replace('class="app-logo"', 'class="panel-logo-x"'));
    await page.$eval('img', (n) => n.setAttribute('alt', 'agentdeck'));
    const panel = await brandPass(page, brand, { mask: true, anyLogo: false });
    const own = await page.$eval('img', (n) => getComputedStyle(n).visibility);
    check(
      panel.leaks.length === 0 && own === 'visible',
      `${label}: у панели свой логотип остаётся (${own}), марка в тексте закрыта`,
    );
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await round(
    browser,
    { words: ['acmeplat', 'акмеплат'], logos: [], replace: 'Platform' },
    'вымышленная марка',
  );
  const real = readBrandMask();
  if (real) await round(browser, real, 'список марки владельца');
  else console.log('—     списка марки владельца нет: проверено вымышленной');
} finally {
  await browser.close();
}
console.log(bad ? `Провалов: ${bad}` : 'Всё зелёное');
process.exit(bad ? 1 : 0);
