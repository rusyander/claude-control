/**
 * Кейс access-integrations-012: скрипт гейта на промпте говорит на языке интерфейса панели.
 *
 * Сообщения гейта человек читает в CLI, а не в панели, поэтому язык вписывается
 * в сам скрипт при сборке. Проверяется на одноразовом стенде (`throwaway-stand.mjs`,
 * временный каталог конфигурации — хук человека не трогается):
 *  1. интерфейс en, гейт включён — на диске английский скрипт, и он действительно
 *     отвечает по-английски (скрипт запускается с пустым вводом хука);
 *  2. скрипт, собранный на другом языке (русская сборка тем же сборщиком панели),
 *     карточка «Prompt gate» называет устаревшим и предлагает пересобрать;
 *  3. смена языка в «Настройках» (PATCH language) пересобирает свой скрипт:
 *     en → ru — карточка актуальна, en ← ru — скрипт снова английский;
 *  4. «Rebuild the script» на карточке чинит несовпадение языка;
 *  5. правленный руками скрипт смена языка не трогает — байт в байт, карточка
 *     говорит «правлен руками».
 *
 * Запуск: `node tools/qa/check-prompt-gate-language.mjs` (стенд поднимается сам).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';

const { buildGateScript } = await import(
  pathToFileURL(join(REPO, 'apps/server/src/domains/prompt-gate/script.ts')).href
);

const EN_SAYS = 'the gate could not parse the hook input';
const RU_SAYS = 'гейт не разобрал ввод хука';
// `SHOTS=<каталог>` — снимок карточки с устаревшим скриптом.
const OUTDATED_EN = 'built by an earlier panel version or under another interface language';

/** Блок настроек скрипта — тот же разбор, что у панели. */
const configOf = (source) => JSON.parse(/^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(source)[1]);

/** Запустить скрипт гейта как хук с пустым вводом — что он скажет человеку. */
function speak(scriptPath, env) {
  const run = spawnSync(process.execPath, [scriptPath], { input: '', env, encoding: 'utf8' });
  try {
    return JSON.parse(run.stdout).systemMessage ?? '';
  } catch {
    return `${run.stdout}${run.stderr}`;
  }
}

await runOnStand(
  { label: 'prompt-gate-language', settings: { language: 'en' } },
  async (stand, check) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: stand.cfg,
      HOME: stand.home,
      USERPROFILE: stand.home,
    };
    const enabled = await stand.api('/prompt-gate', {
      method: 'PUT',
      body: { enabled: true, action: 'block' },
    });
    const scriptPath = enabled.body?.scriptPath;
    check('гейт включён на стенде', enabled.status === 200 && Boolean(scriptPath), enabled.text);
    const script = () => readFileSync(scriptPath, 'utf8');
    const gateInfo = async () => (await stand.api('/prompt-gate')).body;

    // 1. Английский интерфейс — английский скрипт, и говорит он по-английски.
    check('en: в скрипте language=en', configOf(script()).language === 'en');
    const saidEn = speak(scriptPath, env);
    check('en: скрипт отвечает по-английски', saidEn.includes(EN_SAYS), saidEn);

    // 2. Скрипт той же версии, но русской сборки — устарел по языку.
    const { language: _drop, ...ruConfig } = configOf(script());
    writeFileSync(scriptPath, buildGateScript(ruConfig), 'utf8');
    const saidRu = speak(scriptPath, env);
    check('подложен русский скрипт (он и говорит по-русски)', saidRu.includes(RU_SAYS), saidRu);
    const mismatch = await gateInfo();
    check(
      'en + русский скрипт: API — устарел, не «правлен руками»',
      mismatch.outdated === true && mismatch.customized === false,
      JSON.stringify({ outdated: mismatch.outdated, customized: mismatch.customized }),
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      const card = () => page.getByRole('main');
      const openGate = async () => {
        await page.goto(`${stand.webUrl}/dlp?tab=gate`, { waitUntil: 'domcontentloaded' });
        await page
          .getByText('Hook script')
          .or(page.getByText('Скрипт хука'))
          .first()
          .waitFor({ timeout: 30_000 });
        await wait(500);
        return (await card().innerText()).replace(/\s+/g, ' ');
      };
      const switchLanguage = async (label) => {
        await page.goto(`${stand.webUrl}/settings`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: label, exact: true }).click({ timeout: 30_000 });
        await wait(1500);
      };

      let text = await openGate();
      check(
        'карточка (en): сказано, что скрипт устарел по языку',
        text.includes(OUTDATED_EN),
        text.slice(0, 400),
      );
      check(
        'карточка (en): есть «Rebuild the script»',
        (await page.getByRole('button', { name: 'Rebuild the script' }).count()) === 1,
      );
      if (process.env.SHOTS)
        await page.screenshot({ path: join(process.env.SHOTS, 'gate-outdated-en.png') });

      // 3. Смена языка пересобирает свой скрипт.
      await switchLanguage('Русский');
      check('ru: русский скрипт остался русским', configOf(script()).language === undefined);
      text = await openGate();
      check(
        'карточка (ru): устаревшим не назван',
        !text.includes('устарел') && (await gateInfo()).outdated === false,
        text.slice(0, 400),
      );
      await switchLanguage('English');
      check('ru → en: скрипт пересобран на английский', configOf(script()).language === 'en');
      const saidAgain = speak(scriptPath, env);
      check(
        'ru → en: пересобранный скрипт отвечает по-английски',
        saidAgain.includes(EN_SAYS),
        saidAgain,
      );
      text = await openGate();
      check(
        'карточка (en): после пересборки не устарел',
        !text.includes(OUTDATED_EN),
        text.slice(0, 400),
      );

      // 4. «Rebuild the script» чинит несовпадение языка.
      writeFileSync(scriptPath, buildGateScript(ruConfig), 'utf8');
      text = await openGate();
      check(
        'снова русский скрипт: карточка — устарел',
        text.includes(OUTDATED_EN),
        text.slice(0, 400),
      );
      await page.getByRole('button', { name: 'Rebuild the script' }).click();
      await wait(1500);
      check('«Rebuild the script»: скрипт английский', configOf(script()).language === 'en');
      text = (await card().innerText()).replace(/\s+/g, ' ');
      check(
        '«Rebuild the script»: предупреждение ушло',
        !text.includes(OUTDATED_EN),
        text.slice(0, 400),
      );

      // 5. Правленный руками скрипт смена языка не трогает.
      const edited = `${script()}\n// правка человека\n`;
      writeFileSync(scriptPath, edited, 'utf8');
      await switchLanguage('Русский');
      check('правленный руками: смена языка его не переписала', script() === edited);
      const custom = await gateInfo();
      check(
        'правленный руками: API — customized',
        custom.customized === true,
        JSON.stringify(custom),
      );
      text = await openGate();
      check(
        'карточка (ru): сказано, что скрипт правлен руками',
        text.includes('правили руками') || text.includes('правлен'),
        text.slice(0, 500),
      );
      check(
        'страница без необработанных ошибок',
        page.errors.length === 0,
        page.errors.join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
