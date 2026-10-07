/**
 * «Разрешить правки» в шапке чата чужого CLI говорит правду (X5).
 *
 * Переключатель показывается у каждого CLI, до которого он доходит (флагом
 * одиночного запуска или ответом панели живому/сессионному серверу), а подпись
 * выключенного положения — то, что CLI сделает с просьбой о записи: у сервера
 * «Спрашивать перед правками» (карточка), у одиночного запуска «Правки закрыты»
 * (спросить некого). Раньше переключатель был только у CLI с живым сервером —
 * у Gemini и Aider его не было, хотя флаг до них доходил.
 *
 * Свой одноразовый стенд (`throwaway-stand.mjs`), CLI не нужен: разговор
 * создаётся без запуска, переключатель пишет только шапку разговора на диске
 * стенда. Реальные каталоги CLI не читаются и не пишутся.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const CASES = [
  { id: 'gemini', whenOff: 'deny', offLabel: 'Правки закрыты' },
  { id: 'aider', whenOff: 'deny', offLabel: 'Правки закрыты' },
  { id: 'qwen', whenOff: 'ask', offLabel: 'Спрашивать перед правками' },
  { id: 'opencode', whenOff: 'ask', offLabel: 'Спрашивать перед правками' },
];
const shots = join(REPO, '.agent', 'screenshots', 'before-after', 'x5-edits-toggle');
mkdirSync(shots, { recursive: true });

await runOnStand(
  { label: 'edits-toggle', settings: { provider: 'gemini' } },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await bypassOnboarding(page, { provider: 'gemini' });
      for (const item of CASES) {
        console.log(`\n${item.id}`);
        const switched = await stand.api('/settings', {
          method: 'PATCH',
          body: { provider: item.id },
        });
        check('активный CLI переключён', switched.status === 200, switched.text);

        const providers = (await stand.api('/providers')).body;
        const info = providers?.providers?.find((provider) => provider.id === item.id);
        check(
          `список провайдеров: выключенный = ${item.whenOff}`,
          info?.editsWhenOff === item.whenOff,
          JSON.stringify(info?.editsWhenOff),
        );
        const runner = (await stand.api('/provider-runner')).body;
        const runnerOk = check(
          'раннер: переключатель действует',
          runner?.editsToggle === true && runner?.editsWhenOff === item.whenOff,
          JSON.stringify({ editsToggle: runner?.editsToggle, editsWhenOff: runner?.editsWhenOff }),
        );
        // Раннер не обещает переключатель — шапка его и не покажет: ждать её
        // минутами незачем, провал уже назван строкой выше.
        if (!runnerOk) continue;

        const workdir = join(stand.root, `project-${item.id}`);
        mkdirSync(workdir, { recursive: true });
        const created = await stand.api('/provider-chat/chats', {
          method: 'POST',
          body: { workdir },
        });
        check('разговор создан', created.status === 200, created.text);
        const chatId = created.body?.id;

        await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
        // CLI на стенде нет — окно «нужен доступ» закрывает страницу; к шапке оно не относится.
        const gate = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
        await gate
          .first()
          .waitFor({ timeout: 15_000 })
          .catch(() => undefined);
        if ((await gate.count()) > 0)
          await gate.first().getByRole('button', { name: 'Закрыть' }).first().click();
        await page.getByText('Новый разговор').first().click({ timeout: 60_000 });
        const toggle = page.getByLabel('Разрешить правки без вопроса');
        const visible = await toggle
          .waitFor({ timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        check('переключатель в шапке есть', visible);
        const offShown = await page
          .getByText(item.offLabel, { exact: true })
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        check(`выключено: «${item.offLabel}»`, offShown);
        const other = item.whenOff === 'deny' ? 'Спрашивать перед правками' : 'Правки закрыты';
        check(
          `чужой подписи «${other}» нет`,
          (await page.getByText(other, { exact: true }).count()) === 0,
        );
        await page.screenshot({ path: join(shots, `${item.id}-off.png`) });

        if (visible) await toggle.click();
        let persisted = false;
        for (let i = 0; i < 20 && !persisted; i += 1) {
          persisted = (await stand.api(`/provider-chat/chats/${chatId}`)).body?.allowEdits === true;
          if (!persisted) await new Promise((done) => setTimeout(done, 250));
        }
        check('включение записано в разговор', persisted);
        const onShown = await page
          .getByText('Правки без вопроса', { exact: true })
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        check('включено: «Правки без вопроса»', onShown);
        await page.screenshot({ path: join(shots, `${item.id}-on.png`) });
      }
      check('ошибок страницы нет', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
