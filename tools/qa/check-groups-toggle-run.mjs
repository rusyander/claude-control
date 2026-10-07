/**
 * Группа как переключатель на одноразовой панели (Ф22): кейсы
 * access-integrations-005 и -006, ни разу не гонявшиеся.
 *
 * Всё настоящее, кроме модели: панель над временным домом с двумя скиллами,
 * правилом в CLAUDE.md и папкой проекта; фальшивый `claude`
 * (`fake-cli-chat-basics.mjs`) только отвечает «Готово.». Свидетельства — файлы
 * временного дома (SKILL.md, CLAUDE.md), ответы API и то, что видно в разделах
 * «Скиллы», «Правила» и «Группы».
 *
 * - access-integrations-005: группа из двух скиллов и правила («3 участника»);
 *   тумблер на карточке гасит всех троих в их разделах, включение возвращает
 *   их с тем же текстом; удаление группы участников не удаляет и не гасит.
 * - access-integrations-006: выключенная группа, привязанная к проекту, — чат
 *   вне проекта её не трогает; чат в папке проекта включает её до хода, и в
 *   ленте об этом сказано.
 *
 * Группы заводятся запросом к API одноразовой панели (тем же, что шлёт форма):
 * сама форма создания проверена в `check-group-builder.mjs`, здесь вопрос в
 * том, что делает группа с участниками. Тумблер и удаление — через экран.
 *
 * Запуск: node tools/qa/check-groups-toggle-run.mjs   (браузеры: pnpm qa:setup)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_BASICS_CLI } from './fake-cli-chat-basics.mjs';
import { dismissAccess, openProjectChat, sendAndWait } from './chat-walk.mjs';

const SKILLS = ['qa-alpha', 'qa-beta', 'qa-delta'];
const RULE_TITLE = 'QA-гамма';
const RULE_BODY = 'Текст правила гамма, который не должен меняться.';
const skillText = (id) =>
  `---\nname: ${id}\ndescription: Скилл ${id} для проверки группы.\n---\n\nТело ${id}.\n`;

let project = '';
let outside = '';

await runOnStand(
  {
    label: 'groups-toggle',
    fakeCli: { claude: FAKE_BASICS_CLI },
    seed: ({ root, cfg }) => {
      for (const id of SKILLS) {
        mkdirSync(join(cfg, 'skills', id), { recursive: true });
        writeFileSync(join(cfg, 'skills', id, 'SKILL.md'), skillText(id));
      }
      writeFileSync(
        join(cfg, 'CLAUDE.md'),
        `# Общие правила\n\n## ПРАВИЛО: ${RULE_TITLE}\n\n${RULE_BODY}\n`,
      );
      project = join(root, 'qa-project');
      outside = join(root, 'qa-outside');
      mkdirSync(project, { recursive: true });
      mkdirSync(outside, { recursive: true });
    },
  },
  async (stand, check) => {
    const browser = await chromium.launch();
    const skillsOn = async () =>
      Object.fromEntries(
        ((await stand.api('/skills')).body ?? []).map((skill) => [skill.id, skill.isEnabled]),
      );
    const rule = async () =>
      ((await stand.api('/rules')).body ?? []).find((one) => one.title?.includes(RULE_TITLE));
    const groupState = async (id) =>
      ((await stand.api('/groups')).body ?? []).find((one) => one.id === id);
    const switchOn = async (page, path, name) => {
      await page.goto(`${stand.webUrl}${path}`, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('switch', { name, exact: true }).first();
      await toggle.waitFor({ timeout: 30_000 });
      return (await toggle.getAttribute('aria-checked')) === 'true';
    };

    try {
      const ruleId = (await rule())?.id;
      check(
        'засеянные скиллы и правило видны панели',
        Boolean(ruleId) && (await skillsOn())['qa-alpha'] === true,
      );

      // ------------------------------------------------- access-integrations-005
      console.log('access-integrations-005: группа включает и выключает всех разом');
      const made = await stand.api('/groups', {
        method: 'POST',
        body: {
          name: 'QA тройка',
          members: [
            { kind: 'skill', id: 'qa-alpha' },
            { kind: 'skill', id: 'qa-beta' },
            { kind: 'rule', id: ruleId },
          ],
          isEnabled: true,
        },
      });
      const groupId = made.body?.id;
      check('группа заведена', made.status === 200 && Boolean(groupId), made.text.slice(0, 200));

      const page = await stand.newPage(browser, { height: 1000 });
      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      await dismissAccess(page);
      const tile = page
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: 'QA тройка', exact: true }) });
      await tile.waitFor({ timeout: 30_000 });
      check(
        'карточка говорит «3 участника»',
        /3 участника/.test(await tile.innerText()),
        (await tile.innerText()).replace(/\s+/g, ' ').slice(0, 200),
      );

      const tileToggle = page.getByRole('switch', { name: 'Включено: QA тройка' });
      await tileToggle.click();
      for (let i = 0; i < 40 && (await groupState(groupId))?.isEnabled !== false; i += 1)
        await wait(250);
      const offSkills = await skillsOn();
      check('после выключения группа выключена', (await groupState(groupId))?.isEnabled === false);
      check(
        'оба скилла выключены',
        offSkills['qa-alpha'] === false && offSkills['qa-beta'] === false,
        JSON.stringify(offSkills),
      );
      check('правило выключено', (await rule())?.isEnabled === false);
      check('скилл вне группы не тронут', offSkills['qa-delta'] === true);
      check(
        'выключенное правило убрано из CLAUDE.md',
        !(stand.read(join(stand.cfg, 'CLAUDE.md')) ?? '').includes(RULE_BODY),
      );
      check(
        'раздел «Скиллы» показывает qa-alpha выключенным',
        !(await switchOn(page, '/skills', 'qa-alpha')),
      );
      check(
        'раздел «Правила» показывает правило выключенным',
        !(await switchOn(page, '/rules', RULE_TITLE)),
      );

      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      await tileToggle.waitFor({ timeout: 30_000 });
      await tileToggle.click();
      for (let i = 0; i < 40 && (await groupState(groupId))?.isEnabled !== true; i += 1)
        await wait(250);
      const onSkills = await skillsOn();
      check(
        'после включения оба скилла снова включены',
        onSkills['qa-alpha'] === true && onSkills['qa-beta'] === true,
        JSON.stringify(onSkills),
      );
      check('правило снова включено', (await rule())?.isEnabled === true);
      check(
        'тексты не изменились: SKILL.md и правило в CLAUDE.md',
        stand.read(join(stand.cfg, 'skills', 'qa-alpha', 'SKILL.md')) === skillText('qa-alpha') &&
          (stand.read(join(stand.cfg, 'CLAUDE.md')) ?? '').includes(RULE_BODY),
      );
      check(
        'раздел «Скиллы» показывает qa-beta включённым',
        await switchOn(page, '/skills', 'qa-beta'),
      );

      // Удаление: выключенная группа держит отметки — удаление обязано их снять.
      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      await tileToggle.waitFor({ timeout: 30_000 });
      await tileToggle.click();
      for (let i = 0; i < 40 && (await groupState(groupId))?.isEnabled !== false; i += 1)
        await wait(250);
      await tile.getByRole('button', { name: 'QA тройка' }).first().click();
      await page.getByRole('button', { name: 'Удалить: QA тройка' }).click();
      // Подтверждение просит набрать имя — как у человека, без обхода.
      await page.getByRole('dialog').last().getByRole('textbox').last().fill('QA тройка');
      const confirm = page
        .getByRole('dialog')
        .getByRole('button', { name: 'Удалить', exact: true });
      await confirm.last().click();
      for (let i = 0; i < 40 && (await groupState(groupId)); i += 1) await wait(250);
      const leftSkills = await skillsOn();
      check('группа удалена', !(await groupState(groupId)));
      check(
        'участники на месте и включены после удаления выключенной группы',
        leftSkills['qa-alpha'] === true &&
          leftSkills['qa-beta'] === true &&
          (await rule())?.isEnabled === true,
        JSON.stringify({ leftSkills, rule: (await rule())?.isEnabled }),
      );
      check(
        'файлы участников не удалены',
        stand.read(join(stand.cfg, 'skills', 'qa-beta', 'SKILL.md')) === skillText('qa-beta'),
      );
      await page.close();

      // ------------------------------------------------- access-integrations-006
      console.log('access-integrations-006: группа проекта включается сама только в своём проекте');
      const bound = await stand.api('/groups', {
        method: 'POST',
        body: {
          name: 'QA проектная',
          members: [{ kind: 'skill', id: 'qa-delta' }],
          projectPaths: [project],
          isEnabled: true,
        },
      });
      const boundId = bound.body?.id;
      await stand.api(`/groups/${boundId}/enabled`, { method: 'POST', body: { isEnabled: false } });
      check(
        'привязанная группа выключена, её скилл погашен',
        (await groupState(boundId))?.isEnabled === false &&
          (await skillsOn())['qa-delta'] === false,
      );

      const away = await openProjectChat(stand, browser, outside, 'qa-outside');
      const awayTurn = await sendAndWait(away, stand, 'QA: ход вне проекта');
      check('ход вне проекта дошёл до CLI', Boolean(awayTurn));
      check(
        'чат вне проекта группу не включил',
        (await groupState(boundId))?.isEnabled === false &&
          (await skillsOn())['qa-delta'] === false,
      );
      check(
        'в чате вне проекта нет заметки о включении',
        !(await away.locator('main').innerText()).includes('включён сам'),
      );
      await away.close();

      const home = await openProjectChat(stand, browser, project, 'qa-project');
      const homeTurn = await sendAndWait(home, stand, 'QA: ход в проекте');
      check(
        'ход в проекте дошёл до CLI',
        Boolean(homeTurn) && homeTurn.cwd === project,
        homeTurn?.cwd,
      );
      check(
        'чат в проекте включил группу и её скилл',
        (await groupState(boundId))?.isEnabled === true && (await skillsOn())['qa-delta'] === true,
      );
      let said = false;
      for (let i = 0; i < 20 && !said; i += 1) {
        said = (await home.locator('main').innerText()).includes(
          'Набор «QA проектная» включён сам',
        );
        if (!said) await wait(250);
      }
      check('в ленте сказано, что набор включён сам', said);
      check('страница без ошибок', home.errors.length === 0, home.errors.join('\n'));
      await home.close();
    } finally {
      await browser.close();
    }
  },
);
