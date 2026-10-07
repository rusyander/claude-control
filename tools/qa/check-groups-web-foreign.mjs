/**
 * Веб-часть групп при чужом CLI (W) — на одноразовом стенде, через настоящий UI.
 *
 * 1. Карточка группы при Qwen Code показывает и двигает положение ДЛЯ Qwen
 *    (`enabledFor.qwen`), а не тумблер Claude: включённая в Claude группа на
 *    карточке выключена, щелчок пишет `enabledFor`, а `isEnabled` Claude стоит.
 * 2. Окно группы при Qwen: блок «Как группа доедет» — включена, что доедет
 *    (скилл с файлом) и что нет (скилл без файла, с причиной); кнопки песочницы
 *    нет (песочница — только Claude Code).
 * 3. При Goose (слоя нет) тумблера на карточке нет.
 * 4. Чат Qwen: поле «Группа» в шапке, выбор пишется под ключом `qwen:<id>`.
 *    Чат Gemini (слоя нет): поля нет.
 *
 * CLI не нужен: ни один шаг не запускает модель. Каталоги CLI — временные стенда.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { openGroup } from './group-stubs.mjs';

const NAME = 'Слой W';
const shots = join(REPO, '.agent', 'screenshots', 'before-after', 'w-groups-foreign');
mkdirSync(shots, { recursive: true });

const until = async (probe, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
};

await runOnStand(
  { label: 'groups-web-foreign', settings: { provider: 'qwen' } },
  async (stand, check) => {
    // Скилл с файлом доедет; второй участник без файла — отказ с причиной.
    const skillDir = join(stand.cfg, 'skills', 'layer-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: layer-skill\ndescription: layer skill\n---\n\nDo the layer thing.\n',
      'utf8',
    );
    const created = await stand.api('/groups', {
      method: 'POST',
      body: {
        name: NAME,
        description: '',
        color: 'accent',
        icon: 'folder',
        members: [
          { kind: 'skill', id: 'layer-skill' },
          { kind: 'skill', id: 'ghost-skill' },
        ],
        env: {},
        projectPaths: [],
      },
    });
    check('группа заведена', created.status < 300, created.text);
    const id = created.body?.id;
    const claudeOn = await stand.api(`/groups/${id}/enabled`, {
      method: 'POST',
      body: { isEnabled: true, provider: 'claude' },
    });
    check('в Claude группа включена', claudeOn.status < 300, claudeOn.text);
    const groupOf = async () =>
      ((await stand.api('/groups')).body ?? []).find((group) => group.id === id);

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await bypassOnboarding(page, { provider: 'qwen' });

      console.log('\n1. Карточка при Qwen');
      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      const tileSwitch = page.getByRole('switch', { name: `Включено: ${NAME}` });
      await tileSwitch.waitFor({ timeout: 60_000 });
      check(
        'включённая в Claude группа на карточке выключена для Qwen',
        (await tileSwitch.getAttribute('aria-checked')) === 'false',
      );
      await page.screenshot({ path: join(shots, '1-tile-qwen-off.png') });
      await tileSwitch.click();
      const switched = await until(async () => (await groupOf())?.enabledFor?.qwen === true);
      check('щелчок записал enabledFor.qwen', Boolean(switched), JSON.stringify(await groupOf()));
      check('тумблер Claude не сдвинулся', (await groupOf())?.isEnabled === true);
      const shownOn = await until(
        async () => (await tileSwitch.getAttribute('aria-checked')) === 'true',
      );
      check('карточка показывает «включена для Qwen»', Boolean(shownOn));
      // Активный CLI сменили в другой вкладке, эта страница ещё показывает Qwen:
      // щелчок двигает то, что на карточке (Qwen), а не то, что сервер счёл бы
      // активным сам (у Goose слоя нет — был бы отказ 409).
      const elsewhere = await stand.api('/settings', {
        method: 'PATCH',
        body: { provider: 'goose' },
      });
      check('в другой вкладке активный CLI — goose', elsewhere.status === 200, elsewhere.text);
      await tileSwitch.click();
      const switchedOff = await until(async () => (await groupOf())?.enabledFor?.qwen !== true);
      check(
        'щелчок по карточке Qwen выключил её для Qwen, хотя активен уже goose',
        Boolean(switchedOff),
        JSON.stringify(await groupOf()),
      );
      await stand.api('/settings', { method: 'PATCH', body: { provider: 'qwen' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await tileSwitch.waitFor({ timeout: 60_000 });
      await tileSwitch.click();
      const backOn = await until(async () => (await groupOf())?.enabledFor?.qwen === true);
      check('снова включена для Qwen', Boolean(backOn));

      console.log('\n2. Окно группы при Qwen');
      const dialog = await openGroup(page, NAME);
      const delivery = dialog.getByTestId('group-delivery');
      const deliveryShown = await delivery
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check('блок «Как группа доедет» есть', deliveryShown);
      const state = dialog.getByTestId('group-delivery-state');
      const enabledText = await until(async () =>
        ((await state.textContent({ timeout: 1000 }).catch(() => '')) ?? '').includes(
          'Включена для',
        ),
      );
      check(
        'сказано: включена для Qwen',
        Boolean(enabledText),
        await state.textContent({ timeout: 1000 }).catch(() => ''),
      );
      const text = (await delivery.textContent({ timeout: 5000 }).catch(() => '')) ?? '';
      check('скилл с файлом — в «доедет»', /Доедет \(1\):[^\n]*layer-skill/.test(text), text);
      const refused =
        (await dialog
          .getByTestId('group-delivery-refused')
          .textContent({ timeout: 5000 })
          .catch(() => '')) ?? '';
      check(
        'скилл без файла — в «не доедет» с причиной',
        /ghost-skill — \S/.test(refused),
        refused,
      );
      check(
        'кнопки песочницы нет',
        (await dialog.getByRole('button', { name: `Песочница: ${NAME}` }).count()) === 0,
      );
      await page.screenshot({ path: join(shots, '2-dialog-qwen.png') });
      await page.keyboard.press('Escape');

      console.log('\n3. Карточка при Goose');
      const toGoose = await stand.api('/settings', {
        method: 'PATCH',
        body: { provider: 'goose' },
      });
      check('активный CLI — goose', toGoose.status === 200, toGoose.text);
      await page.goto(`${stand.webUrl}/groups`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('groups-provider-note').waitFor({ timeout: 60_000 });
      await wait(1000);
      check(
        'у CLI без слоя тумблера на карточке нет',
        (await page.getByRole('switch', { name: `Включено: ${NAME}` }).count()) === 0,
      );
      await page.screenshot({ path: join(shots, '3-tile-goose.png') });

      console.log('\n4. Поле «Группа» в чате');
      const toQwen = await stand.api('/settings', { method: 'PATCH', body: { provider: 'qwen' } });
      check('активный CLI — qwen', toQwen.status === 200, toQwen.text);
      const workdir = join(stand.root, 'project-qwen');
      mkdirSync(workdir, { recursive: true });
      const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: { workdir } });
      check('разговор qwen создан', chat.status === 200, chat.text);
      const chatId = chat.body?.id;
      const openChat = async () => {
        await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
        const gate = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
        await gate
          .first()
          .waitFor({ timeout: 15_000 })
          .catch(() => undefined);
        if ((await gate.count()) > 0)
          await gate.first().getByRole('button', { name: 'Закрыть' }).first().click();
        await page.getByText('Новый разговор').first().click({ timeout: 60_000 });
      };
      await openChat();
      const picker = page.getByTestId('provider-chat-group');
      const pickerShown = await picker
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      check('поле «Группа» в чате Qwen есть', pickerShown);
      if (pickerShown) {
        const select = picker.locator('select');
        await select.selectOption({ label: NAME });
        // select управляемый: значение встаёт, когда запись вернулась с сервера.
        const chosen =
          (await until(async () => {
            const value = await select.inputValue();
            return value !== 'auto' ? value : undefined;
          })) ?? 'auto';
        const saved = await until(async () => {
          const view = (
            await stand.api(`/chat/${encodeURIComponent(`qwen:${chatId}`)}/group-settings`)
          ).body;
          return view?.groupChoice === chosen ? view : undefined;
        });
        check(
          `выбор записан под ключом qwen:<id> (${chosen})`,
          Boolean(saved) && chosen !== 'auto',
          chosen,
        );
        await page.screenshot({ path: join(shots, '4-chat-qwen-picker.png') });
      }

      const toGemini = await stand.api('/settings', {
        method: 'PATCH',
        body: { provider: 'gemini' },
      });
      check('активный CLI — gemini', toGemini.status === 200, toGemini.text);
      const geminiChat = await stand.api('/provider-chat/chats', {
        method: 'POST',
        body: { workdir: join(stand.root) },
      });
      check('разговор gemini создан', geminiChat.status === 200, geminiChat.text);
      await openChat();
      await page.getByLabel('Разрешить правки без вопроса').waitFor({ timeout: 30_000 });
      check(
        'у CLI без слоя поля «Группа» в чате нет',
        (await page.getByTestId('provider-chat-group').count()) === 0,
      );
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
