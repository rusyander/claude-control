/**
 * Кадры раздела «Глобальный слой» в документе «Настройки»:
 * `settings/global-layer`, русские и английские за один прогон; тёмная тема —
 * тем же скриптом с `GUIDE_THEME=dark`.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`): каталог конфигурации —
 * временный, глобальная сторона пары — КОПИИ файлов из `~/.claude` машины
 * съёмки (только чтение). Слабая копия, предложение и его запись — в каталоге
 * стенда; настоящий слой не правится.
 *
 * НИ ОДИН ОТВЕТ ПАНЕЛИ НЕ ПОДМЕНЁН: вердикты в кадре посчитал сервер на
 * настоящем корпусе, отметку правки вызвал настоящий наблюдатель файлов.
 *
 * Запуск: node tools/help-shots/settings-global-layer.mjs
 *         GUIDE_THEME=dark node tools/help-shots/settings-global-layer.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { SHOT_LANGS, applyShotLanguage, openScenario, shotTheme } from './kit.mjs';
import { openSettingsTab, shotCard } from './access-providers-fixture.mjs';

const PAIR_FILES = [
  'hooks/lib/push-sieves.mjs',
  'hooks/lib/push-sieves-scan.mjs',
  'skills/prepare-mr/SKILL.md',
];
const MODULE = 'hooks/lib/push-sieves-scan.mjs';
const REAL = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const CARD = '[data-global-pair="sieves"]';

/** Ослабленная копия для кадра отметки: ловит только закоммиченный `.env`. */
const WEAK = `export function scanBranch(git, { cwd, base, ref }) {
  const names = git(cwd, ['diff', '--name-only', base, ref]).stdout.split('\\n').filter(Boolean);
  const env = names.filter((name) => name.endsWith('.env'));
  return { blocks: env.length ? [{ id: 'committed-artifacts', items: env }] : [], advisories: [] };
}
`;

const missing = PAIR_FILES.filter((file) => !existsSync(join(REAL, file)));
if (missing.length > 0) {
  console.error(`в ${REAL} нет файлов пары: ${missing.join(', ')}`);
  process.exit(2);
}
const strong = readFileSync(join(REAL, MODULE), 'utf8');

const stand = await startStand({
  label: 'global-layer-shots',
  settings: { theme: shotTheme() },
  seed: ({ cfg }) => {
    for (const file of PAIR_FILES) {
      mkdirSync(dirname(join(cfg, file)), { recursive: true });
      cpSync(join(REAL, file), join(cfg, file));
    }
  },
});

const settled = async () => {
  for (let i = 0; i < 360; i += 1) {
    const pair = (await stand.api('/global-layer')).body.pairs[0];
    if (pair && !pair.comparing && pair.comparedAt) return pair;
    await wait(500);
  }
  throw new Error('сверка не закончилась');
};

/** Сверка «человеком»: снимает отметку правки, как кнопка «Сверить». */
async function compareByHand() {
  await settled();
  await stand.api('/global-layer/sieves/compare', { method: 'POST', body: {} });
  await wait(500);
  return settled();
}

async function shoot(browser, scenario) {
  const page = await stand.newPage(browser, { width: 1400, height: 1600 });
  const proposalDir = join(stand.cfg, 'agentdeck', 'global-layer', 'sieves', 'proposal');
  try {
    // Слой — настоящая копия, предложения нет, отметки нет: исходная картина.
    writeFileSync(join(stand.cfg, MODULE), strong, 'utf8');
    rmSync(proposalDir, { recursive: true, force: true });
    await compareByHand();

    // ── 01. Итог сверки настоящих копий ──────────────────────────────────────
    await openSettingsTab(page, stand.webUrl, 'globalLayer', 2500);
    await page.waitForSelector('[data-global-summary]');
    await shotCard(scenario, page, '01-verdict', CARD);

    // ── 02. Случаи с расхождением под строкой сита ──────────────────────────
    const row = page.locator('[data-global-sieve][data-verdict="global"]').first();
    const target = (await row.count()) > 0 ? row : page.locator('[data-global-sieve]').first();
    await target.locator('summary').click();
    await wait(300);
    await shotCard(scenario, page, '02-cases', '[data-global-summary]');

    // ── 03. Правка файла слоя — отметка на открытой странице ────────────────
    writeFileSync(join(stand.cfg, MODULE), WEAK, 'utf8');
    await page.waitForSelector('[data-global-changed]', { timeout: 20_000 });
    await wait(1000);
    await settled();
    await wait(2500); // карточка перечитала итог после авто-сверки
    await shotCard(scenario, page, '03-changed', CARD);

    // ── 04. Предложение агента: дифф и кнопка записи ────────────────────────
    mkdirSync(dirname(join(proposalDir, MODULE)), { recursive: true });
    writeFileSync(join(proposalDir, MODULE), strong, 'utf8');
    await openSettingsTab(page, stand.webUrl, 'globalLayer', 2500);
    const proposal = page.locator('[data-global-proposal]');
    await proposal.waitFor();
    await proposal.locator('button').first().click();
    await page.waitForSelector('[data-proposal-file]');
    await wait(400);
    await shotCard(scenario, page, '04-proposal', '[data-global-proposal]');
  } finally {
    await page.close();
  }
}

let exitCode = 0;
try {
  const browser = await chromium.launch();
  try {
    for (const lang of SHOT_LANGS) {
      await applyShotLanguage(stand.apiUrl, lang);
      const scenario = openScenario('settings', 'global-layer', lang);
      console.log(`\nсценарий settings/global-layer [${lang}]`);
      await shoot(browser, scenario);
      scenario.finish();
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stand.stop();
}
process.exit(exitCode);
