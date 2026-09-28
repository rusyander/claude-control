/**
 * Кейс settings-models-006: перенос среды («Настройки → Перенос») полный и не
 * раскрывает секреты — архив собран, в нём нет ни одного значения секрета в
 * открытом виде, на «второй машине» правила, скиллы, хуки и MCP-серверы на
 * месте, а негодный архив отклоняется с причиной и ничего не пишет.
 *
 * Две одноразовые панели = две машины: A собирает архив в свой дом, файл
 * копируется в дом B (так его и везут — файлом), B разворачивает. Секреты
 * засеяны в трёх видах: переменная settings.json, `env` MCP-сервера и файл
 * `.mcp-secrets.env`. Архив распаковывается (`tar`, он читает zip) и каждое
 * значение ищется во всех файлах: сжатый zip грепать бессмысленно.
 *
 * Пароля у переноса нет: секреты не шифруются, а вообще не кладутся в архив
 * (apps/server/src/domains/env-transfer/redact.ts). Владелец 28.09: прав продукт,
 * кейс переписан — окно экспорта обязано сказать это человеку до сохранения, а
 * поля пароля в нём быть не должно (появилось — значит, обещание поменялось, и
 * кейс надо пересмотреть). «Неверный пароль» заменён ближайшим исполнимым
 * отказом — битым архивом, после которого на B не записано ничего.
 *
 * Запуск: `node tools/qa/check-env-transfer.mjs` (обе панели поднимаются сами).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, startStand, wait } from './throwaway-stand.mjs';

const RULE = 'Перенос-проба';
const SKILL = 'transfer-skill';
const MCP = 'transfer-mcp';
const SECRETS = ['tok-SECRET-settings-777', 'mcp-SECRET-key-888', 'vault-SECRET-999'];

const seedA = ({ cfg }) => {
  writeFileSync(
    join(cfg, 'CLAUDE.md'),
    `# Мои инструкции\n\n## ПРАВИЛО: ${RULE}\n\nТекст правила переноса.\n`,
    'utf8',
  );
  mkdirSync(join(cfg, 'skills', SKILL), { recursive: true });
  writeFileSync(
    join(cfg, 'skills', SKILL, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Use when probing transfer\n---\n\nТело.\n`,
    'utf8',
  );
  writeFileSync(
    join(cfg, 'settings.json'),
    `${JSON.stringify(
      {
        env: { PROBE_API_TOKEN: SECRETS[0] },
        permissions: { allow: ['Read'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node -e "0"' }] }] },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(cfg, '.claude.json'),
    `${JSON.stringify({ mcpServers: { [MCP]: { type: 'stdio', command: 'node', args: ['probe.mjs'], env: { API_KEY: SECRETS[1] } } } }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(cfg, '.mcp-secrets.env'), `VAULT_TOKEN=${SECRETS[2]}\n`, 'utf8');
};

/** Все файлы каталога — путь и текст. */
const filesOf = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
const leaks = (dir) =>
  filesOf(dir).flatMap((path) => {
    const text = readFileSync(path, 'latin1');
    return SECRETS.filter((secret) => text.includes(secret)).map((secret) => `${secret} в ${path}`);
  });

/** Строка провайдера Claude Code в карточке переноса. */
const claudeRow = (page) =>
  page
    .locator('div')
    .filter({ hasText: 'Claude Code' })
    .filter({ has: page.getByRole('button', { name: 'Экспорт', exact: true }) })
    .last();

await runOnStand({ label: 'transfer-a', seed: seedA }, async (a, check) => {
  const b = await startStand({ label: 'transfer-b' });
  const unpack = mkdtempSync(join(tmpdir(), 'cc-transfer-unpack-'));
  const browser = await chromium.launch();
  try {
    // --- A: экспорт.
    const pageA = await a.newPage(browser, { height: 1200 });
    await pageA.goto(`${a.webUrl}/settings?tab=transfer`, { waitUntil: 'domcontentloaded' });
    await claudeRow(pageA).getByRole('button', { name: 'Экспорт', exact: true }).click();
    const preview = pageA.getByRole('dialog').filter({ hasText: 'Что уедет' });
    await preview.waitFor({ timeout: 30_000 });
    const previewText = await preview.innerText();
    console.log(`  превью: ${previewText.replace(/\s+/g, ' ').slice(0, 300)}`);
    check(
      'окно экспорта говорит, что токены и ключи в архив не кладутся',
      previewText.includes('Токены и ключи в архив не кладутся'),
      previewText.replace(/\s+/g, ' ').slice(0, 300),
    );
    check(
      'пароля в окне экспорта нет — секреты не шифруются, а не уезжают вовсе',
      (await preview.getByLabel(/парол/i).count()) === 0,
    );
    await preview.getByRole('button', { name: 'Выбрать папку и сохранить' }).click();
    const picker = pageA.getByRole('dialog').filter({ hasText: 'Куда сохранить архив' });
    await picker.waitFor();
    await picker.getByRole('button', { name: '~', exact: true }).first().click();
    await wait(500);
    await picker.getByRole('button', { name: 'Открыть эту папку' }).click();
    const done = pageA.getByRole('dialog').filter({ hasText: 'Архив собран' });
    await done.waitFor({ timeout: 60_000 });
    const archive = readdirSync(a.home)
      .filter((name) => name.endsWith('.zip'))
      .map((name) => join(a.home, name))[0];
    check(
      'архив собран в выбранной папке',
      Boolean(archive) && (await done.innerText()).includes(basename(archive ?? '?')),
      await done.innerText(),
    );
    check(
      'окно «Архив собран» перечисляет, что ввести руками',
      /Что придётся ввести руками/.test(await done.innerText()),
    );

    // --- Архив: ни одного секрета в открытом виде.
    // На Windows первым в PATH бывает GNU tar из Git: он читает «C:» как имя
    // хоста и zip не понимает. Системный bsdtar читает zip — берём его.
    const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const tarBin = process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar';
    const tar = spawnSync(tarBin, ['-xf', archive, '-C', unpack], { encoding: 'utf8' });
    check('архив распаковался', tar.status === 0 && filesOf(unpack).length > 0, tar.stderr);
    const found = leaks(unpack);
    check('в архиве нет значений секретов', found.length === 0, found.join('\n'));
    check(
      'в архиве есть правило и скилл',
      filesOf(unpack).some((path) => readFileSync(path, 'utf8').includes(`## ПРАВИЛО: ${RULE}`)) &&
        filesOf(unpack).some((path) =>
          path.replace(/\\/g, '/').endsWith(`skills/${SKILL}/SKILL.md`),
        ),
      filesOf(unpack)
        .map((path) => path.slice(unpack.length))
        .join(', '),
    );

    // --- B: битый архив — отказ с причиной, ничего не записано.
    const before = Object.fromEntries(
      filesOf(b.cfg).map((path) => [path, readFileSync(path, 'utf8')]),
    );
    writeFileSync(join(b.home, 'broken.zip'), 'это не zip\n', 'utf8');
    copyFileSync(archive, join(b.home, basename(archive)));
    const pageB = await b.newPage(browser, { height: 1200 });
    await pageB.goto(`${b.webUrl}/settings?tab=transfer`, { waitUntil: 'domcontentloaded' });
    const importFrom = async (file) => {
      await claudeRow(pageB).getByRole('button', { name: 'Импорт', exact: true }).click();
      const pick = pageB.getByRole('dialog').filter({ hasText: 'Выбор архива окружения' });
      await pick.waitFor({ timeout: 30_000 });
      await pick.getByRole('button', { name: '~', exact: true }).first().click();
      await wait(500);
      await pick.getByRole('button', { name: file, exact: true }).click();
      await wait(1500);
    };
    await importFrom('broken.zip');
    const refusal = await pageB
      .locator('[data-sonner-toast], [role="status"], [role="alert"]')
      .allInnerTexts();
    console.log(`  битый архив: ${refusal.join(' | ').replace(/\s+/g, ' ').slice(0, 300)}`);
    check(
      'битый архив: отказ с причиной на экране',
      refusal.some((text) => text.trim().length > 10),
      refusal.join(' | '),
    );
    check(
      'битый архив: плана развёртывания нет',
      (await pageB.getByRole('dialog').filter({ hasText: 'Развернуть окружение' }).count()) === 0,
    );
    const after = Object.fromEntries(
      filesOf(b.cfg).map((path) => [path, readFileSync(path, 'utf8')]),
    );
    check(
      'битый архив: в каталоге B ничего не изменилось',
      JSON.stringify(after) === JSON.stringify(before),
    );

    // --- B: настоящий архив — всё на месте.
    await pageB.keyboard.press('Escape');
    await importFrom(basename(archive));
    const plan = pageB.getByRole('dialog').filter({ hasText: 'Развернуть окружение' });
    await plan.waitFor({ timeout: 30_000 });
    await plan
      .getByRole('button', { name: 'Отметить всё' })
      .click()
      .catch(() => undefined);
    await plan.getByRole('button', { name: /^Записать отмеченное/ }).click();
    await plan.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    await wait(1000);
    const read = (path) =>
      existsSync(join(b.cfg, path)) ? readFileSync(join(b.cfg, path), 'utf8') : '';
    check(
      'B: правило на месте',
      read('CLAUDE.md').includes(`## ПРАВИЛО: ${RULE}`),
      read('CLAUDE.md'),
    );
    check('B: скилл на месте', existsSync(join(b.cfg, 'skills', SKILL, 'SKILL.md')));
    const settingsB = JSON.parse(read('settings.json') || '{}');
    check(
      'B: хук Stop на месте',
      JSON.stringify(settingsB.hooks ?? {}).includes('node -e'),
      read('settings.json'),
    );
    const mcpB = JSON.parse(read('.claude.json') || '{}');
    check('B: MCP-сервер на месте', Boolean(mcpB.mcpServers?.[MCP]), read('.claude.json'));
    const leaksB = leaks(b.cfg);
    check('B: значения секретов не приехали', leaksB.length === 0, leaksB.join('\n'));
    check(
      'страницы без необработанных ошибок',
      pageA.errors.length + pageB.errors.length === 0,
      [...pageA.errors, ...pageB.errors].join(' | '),
    );
  } finally {
    await browser.close();
    await b.stop();
    rmSync(unpack, { recursive: true, force: true });
  }
});
