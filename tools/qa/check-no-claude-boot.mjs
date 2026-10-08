/**
 * Машина без Claude Code: нет `~/.claude`, нет `claude` в PATH, есть Qwen Code.
 *
 * Одноразовая панель (`throwaway-stand.mjs`, `noClaude`) над временным домом,
 * настоящий CLI qwen из `QWEN_BIN_DIR` в конце PATH, конфиг Qwen — во временном
 * `~/.qwen`. Проверяется то, что раньше ломалось:
 * - панель стартует и НЕ заводит `~/.claude` (раньше `mkdir ~/.claude/agentdeck`
 *   на старте), состояние — в `~/.agentdeck/data`;
 * - мастер первого запуска проходится насквозь через UI: шаг каталога пускает
 *   дальше, на шаге CLI выбирается Qwen Code — он последний из трёх (шага доступа Claude
 *   у другого CLI нет), «Готово» закрывает мастер;
 * - обзор считает конфиг Qwen и подписан «Qwen Code»;
 * - строка CLI в «Провайдерах» — про qwen и его версию;
 * - `pnpm doctor` в том же окружении выходит 0; контроль: без qwen в PATH — 1.
 *
 * Запуск: `QWEN_BIN_DIR=<каталог с qwen(.cmd)> node tools/qa/check-no-claude-boot.mjs`.
 * Без `QWEN_BIN_DIR` — «не проверено» (код 2): CLI в систему проверка не ставит.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { chromium } from 'playwright';
import { NotChecked, REPO, runOnStand } from './throwaway-stand.mjs';

const QWEN_BIN_DIR = process.env.QWEN_BIN_DIR;
const IS_WIN = process.platform === 'win32';
if (!QWEN_BIN_DIR || !existsSync(join(QWEN_BIN_DIR, IS_WIN ? 'qwen.cmd' : 'qwen'))) {
  console.log('Не проверено: задайте QWEN_BIN_DIR — каталог, где лежит qwen.');
  process.exit(2);
}

/** PATH без `claude` — как у одноразовой панели. */
function pathWithoutClaude() {
  const names = IS_WIN ? ['claude.cmd', 'claude.exe', 'claude.ps1', 'claude'] : ['claude'];
  return (process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .filter((dir) => dir && !names.some((name) => existsSync(join(dir, name))))
    .join(delimiter);
}

/** `pnpm doctor` под временным домом; `withQwen` — с CLI qwen в PATH или без. */
function runDoctor(home, withQwen) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['PATH', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync(process.execPath, [join(REPO, 'tools', 'doctor.mjs')], {
    cwd: REPO,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      PATH: [pathWithoutClaude(), ...(withQwen ? [QWEN_BIN_DIR] : [])].join(delimiter),
      // Порты стенда человека заняты — doctor про них только предупредит; свои — свободны.
      PORT: '5',
      WEB_PORT: '6',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

await runOnStand(
  {
    label: 'no-claude',
    noClaude: true,
    extraPath: [QWEN_BIN_DIR],
    settings: { onboardingDone: false },
    seed: ({ home }) => {
      const qwen = join(home, '.qwen');
      mkdirSync(join(qwen, 'skills', 'review'), { recursive: true });
      writeFileSync(
        join(qwen, 'skills', 'review', 'SKILL.md'),
        '---\nname: review\ndescription: Review code\n---\nBody\n',
      );
      writeFileSync(
        join(qwen, 'settings.json'),
        `${JSON.stringify({
          mcpServers: { one: { command: 'node', args: ['a.js'] }, two: { httpUrl: 'http://x' } },
          permissions: { allow: ['Read'], deny: ['Bash(rm *)'] },
        })}\n`,
      );
    },
  },
  async (stand, check) => {
    const claudeDir = join(stand.home, '.claude');
    const location = (await stand.api('/location')).body;
    check(
      'панель поднялась без ~/.claude: каталог Claude «не найден»',
      location?.source === 'not-found',
    );
    check(
      'данные панели — в ~/.agentdeck/data',
      location?.paths?.appData === join(stand.home, '.agentdeck', 'data'),
      location?.paths?.appData,
    );
    const detect = (await stand.api('/providers/detect/detect')).body;
    check(
      'qwen найден в PATH панели',
      detect?.providers?.some((item) => item.id === 'qwen' && item.cliInstalled),
    );

    // --- мастер первого запуска через UI ---
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(stand.webUrl);
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Далее' }).click();
      await dialog.locator('[data-claude-optional]').waitFor({ timeout: 10_000 });
      check('шаг каталога: спокойное пояснение вместо ошибки', true);
      const next = dialog.getByRole('button', { name: 'Далее' });
      check('шаг каталога: «Далее» доступно без .claude', await next.isEnabled());
      await next.click();
      await dialog.getByRole('button', { name: 'Выбрать Qwen Code' }).click();
      await dialog
        .getByRole('button', { name: /Qwen Code/ })
        .and(page.locator('[disabled]'))
        .waitFor({ timeout: 10_000 });
      // Шаг доступа Claude у другого CLI выпадает: выбор провайдера — последний из трёх.
      check(
        'у Qwen шагов три: выбор CLI — «Шаг 3 из 3»',
        await dialog.getByText('Шаг 3 из 3').isVisible(),
      );
      const done = dialog.getByRole('button', { name: 'Готово' });
      check('последний шаг: «Готово» доступно', await done.isEnabled());
      await done.click();
      await dialog.waitFor({ state: 'detached', timeout: 15_000 });
      check('мастер закрылся', true);

      const settings = (await stand.api('/settings')).body;
      check(
        'выбран Qwen, онбординг пройден',
        settings?.provider === 'qwen' && settings?.onboardingDone === true,
      );

      // --- обзор ---
      await page.goto(stand.webUrl);
      await page.getByText('Что сейчас подключено к вашему Qwen Code').waitFor({ timeout: 20_000 });
      check('обзор подписан «Qwen Code»', true);
      const overview = (await stand.api('/overview')).body;
      console.log(`    /api/overview: ${JSON.stringify(overview)}`);
      check(
        'обзор посчитал конфиг Qwen: 1 скилл, 2 MCP, права 1/0/1',
        overview?.provider?.id === 'qwen' &&
          overview?.skills?.total === 1 &&
          overview?.mcp?.total === 2 &&
          overview?.permissions?.allow === 1 &&
          overview?.permissions?.deny === 1,
      );
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }

    // --- версия CLI ---
    const cli = (await stand.api('/chat/cli?refresh=1')).body;
    check(
      'строка CLI — про qwen с версией',
      cli?.providerId === 'qwen' && /^\d+\.\d+\.\d+$/.test(cli?.version ?? ''),
      JSON.stringify(cli),
    );

    check('~/.claude так и не появился', !existsSync(claudeDir));

    // --- doctor ---
    const doctor = runDoctor(stand.home, true);
    console.log(doctor.output.replace(/^/gm, '    | '));
    check('doctor без Claude, с qwen: код 0', doctor.status === 0, `код ${doctor.status}`);
    const control = runDoctor(stand.home, false);
    check(
      'контроль: doctor без Claude и без qwen — код 1',
      control.status === 1,
      `код ${control.status}`,
    );
    if (!existsSync(stand.home)) throw new NotChecked('временный дом исчез');
  },
);
