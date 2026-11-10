import { SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActOutcome, ActRefusal, BrowserDriver } from './browser.types.ts';
import { chromiumAvailable, NO_CHROMIUM_REASON } from './__fixtures__/chromium.ts';
import { sha256, startStandSite, type StandSite } from './__fixtures__/stand-site.ts';
import { createBrowserDriver, errorLine } from './driver.ts';
import { installCommandFor } from './no-browser.ts';

/**
 * Настоящий Chromium над своим стендом на 127.0.0.1 (никакого внешнего сайта): цель — только
 * смысловая, проверки ядра после каждого действия, выбор файла — флаг, а не окно.
 */

const hasChromium = await chromiumAvailable();
if (!hasChromium) console.warn(`driver.integration: skipped — ${NO_CHROMIUM_REASON}`);

function outcome(got: ActOutcome | ActRefusal): ActOutcome {
  if ('refused' in got) throw new Error(`refused: ${got.refused} ${got.message}`);
  return got;
}

describe.skipIf(!hasChromium)('core browser driver over a loopback stand (P177)', () => {
  let site: StandSite;
  let driver: BrowserDriver;
  beforeAll(async () => {
    site = await startStandSite();
    driver = createBrowserDriver({ actionTimeoutMs: 2_000 });
  });
  afterAll(async () => {
    await driver.close();
    await site.close();
  });

  it('login: open, fill by label, click by role — the stand receives the value; checks stay clean', async () => {
    const s = 'login';
    const opened = outcome(await driver.act(s, { action: 'open', url: `${site.url}/login` }));
    expect(opened).toMatchObject({
      ok: true,
      url: `${site.url}/login`,
      checks: { console: 0, failed: 0, blank: false, stale: false },
    });
    const filled = outcome(
      await driver.act(s, { action: 'fill', target: { label: 'Password' }, value: 'pw-0123456' }),
    );
    expect(filled.ok).toBe(true);
    // Снимок дерева показывает значение поля пароля открытым текстом — потому маска у вызывающего.
    const tree = outcome(await driver.act(s, { action: 'snapshot' }));
    expect(tree.snapshot).toContain('pw-0123456');
    const clicked = outcome(
      await driver.act(s, { action: 'click', target: { role: 'button', name: 'Sign in' } }),
    );
    expect(clicked).toMatchObject({ ok: true, url: `${site.url}/welcome` });
    expect(clicked.checks.stale).toBe(false);
    const hash = outcome(
      await driver.act(s, {
        action: 'expect',
        expect: 'text',
        target: { testId: 'hash' },
        value: sha256('pw-0123456'),
      }),
    );
    expect(hash.ok).toBe(true);
    expect(
      outcome(await driver.act(s, { action: 'expect', expect: 'url', value: '/welcome' })).ok,
    ).toBe(true);
    expect(driver.urlOf(s)).toBe(`${site.url}/welcome`);
  });

  it('a failing expectation is ok:false with the reason, not a thrown call', async () => {
    const s = 'expect-fail';
    outcome(await driver.act(s, { action: 'open', url: `${site.url}/login` }));
    const wrong = outcome(
      await driver.act(s, {
        action: 'expect',
        expect: 'text',
        target: { role: 'heading', name: 'Sign in' },
        value: 'Welcome back',
      }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.problems[0]).toMatch(/^expect failed \(role heading "Sign in"\)/);
  });

  describe('a fill value never leaves the driver', () => {
    /**
     * Отказ ввода у Playwright несёт набранное значение (журнал вызова `fill("…")`), а набранное —
     * может быть секретом стенда. Причина уходит из драйвера без значения: и без маски вызывающего,
     * и как бы ни резалась ошибка дальше.
     */
    it('a refused fill names the reason, never the typed value — though the raw Playwright error carries it', async () => {
      const value = 'Zq9-fill-echo-7741';
      const browser = await chromium.launch({ headless: true });
      let raw = '';
      try {
        const page = await browser.newPage();
        await page.goto(`${site.url}/amount`);
        await page
          .getByLabel('Amount')
          .fill(value, { timeout: 2_000 })
          .catch((e: unknown) => {
            raw = e instanceof Error ? e.message : String(e);
          });
      } finally {
        await browser.close();
      }
      // Проверка способна покраснеть: этот Playwright правда повторяет значение в своей ошибке.
      expect(raw).toContain(value);
      const s = 'fill-echo';
      outcome(await driver.act(s, { action: 'open', url: `${site.url}/amount` }));
      const filled = outcome(
        await driver.act(s, { action: 'fill', target: { label: 'Amount' }, value }),
      );
      expect(filled.ok).toBe(false);
      expect(filled.problems[0]).toMatch(
        /^fill failed \(label "Amount"\): .*Cannot type text into input\[type=number\]/,
      );
      expect(JSON.stringify(filled)).not.toContain(value);
    });

    it('the error line hides a given value before the cut, whatever line Playwright puts it on', () => {
      const value = 'Zq9-first-line-7741';
      const line = errorLine(
        new Error(`locator.fill: ${value} was refused\nCall log:\n  - fill("${value}")`),
        value,
      );
      expect(line).toBe(`locator.fill: ${SECRET_MASK} was refused`);
      // Короткое значение не маскируется: оно съело бы обычные слова причины.
      expect(errorLine(new Error('Timeout 2000ms exceeded.'), 'ms')).toBe(
        'Timeout 2000ms exceeded.',
      );
    });
  });

  it('broken button: console error and the same-origin 404 are counted and named', async () => {
    const s = 'broken';
    outcome(await driver.act(s, { action: 'open', url: `${site.url}/broken` }));
    const clicked = outcome(
      await driver.act(s, { action: 'click', target: { role: 'button', name: 'Break' } }),
    );
    expect(clicked.ok).toBe(true);
    expect(clicked.checks.console).toBe(1);
    expect(clicked.checks.failed).toBe(1);
    expect(clicked.checks.stale).toBe(false);
    expect(clicked.problems.join('\n')).toContain('boom from the stand');
    expect(clicked.problems.join('\n')).toMatch(/GET .*\/api\/missing → 404/);
  });

  it('a do-nothing button is stale; a blank page is blank', async () => {
    const s = 'inert';
    outcome(await driver.act(s, { action: 'open', url: `${site.url}/inert` }));
    const clicked = outcome(
      await driver.act(s, { action: 'click', target: { role: 'button', name: 'Nothing' } }),
    );
    expect(clicked).toMatchObject({ ok: true, checks: { stale: true } });
    expect(clicked.problems.join('\n')).toMatch(/no UI response to the click/);
    const blank = outcome(await driver.act(s, { action: 'open', url: `${site.url}/blank` }));
    expect(blank.checks.blank).toBe(true);
  });

  it('a CSS-looking target is text, never a selector: {text:"#b"} finds nothing', async () => {
    const s = 'css';
    outcome(await driver.act(s, { action: 'open', url: `${site.url}/broken` }));
    const clicked = outcome(await driver.act(s, { action: 'click', target: { text: '#b' } }));
    expect(clicked.ok).toBe(false);
    expect(clicked.checks.console).toBe(0);
    expect(clicked.problems[0]).toMatch(/^click failed \(text "#b"\)/);
  });

  it('a click that opens a file chooser is flagged file-pick, not stale, no dialog', async () => {
    const s = 'upload';
    outcome(await driver.act(s, { action: 'open', url: `${site.url}/upload` }));
    const clicked = outcome(
      await driver.act(s, { action: 'click', target: { role: 'button', name: 'Attach' } }),
    );
    expect(clicked.filePick).toBe(true);
    expect(clicked.checks.stale).toBe(false);
  });

  it('two first calls of one session at once share one page: the second acts where the first opened', async () => {
    const s = 'twin';
    const [opened, checked] = await Promise.all([
      driver.act(s, { action: 'open', url: `${site.url}/login` }),
      driver.act(s, { action: 'expect', expect: 'url', value: '/login' }),
    ]);
    expect(outcome(opened).ok).toBe(true);
    expect(outcome(checked)).toMatchObject({ ok: true, url: `${site.url}/login` });
    expect(driver.urlOf(s)).toBe(`${site.url}/login`);
  });

  it('sessions have their own pages; release forgets one, close refuses later calls', async () => {
    const other = createBrowserDriver({ actionTimeoutMs: 2_000 });
    outcome(await other.act('a', { action: 'open', url: `${site.url}/login` }));
    outcome(await other.act('b', { action: 'open', url: `${site.url}/inert` }));
    expect(other.urlOf('a')).toBe(`${site.url}/login`);
    expect(other.urlOf('b')).toBe(`${site.url}/inert`);
    await other.release('a');
    expect(other.urlOf('a')).toBeNull();
    await other.close();
    expect(await other.act('b', { action: 'open', url: `${site.url}/login` })).toMatchObject({
      refused: 'closed',
    });
  });
});

describe('no Chromium: the refusal names the install command of this OS (P177)', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('%s', async (platform) => {
    const driver = createBrowserDriver({
      executablePath: 'C:/nowhere/agentdeck-no-chromium/chrome.exe',
      platform,
    });
    try {
      const got = await driver.act('s', { action: 'open', url: 'http://127.0.0.1:9/' });
      expect(got).toMatchObject({ refused: 'no-browser' });
      expect((got as ActRefusal).message).toContain(installCommandFor(platform));
    } finally {
      await driver.close();
    }
  });

  it('the Linux command does not hide sudo inside --with-deps', () => {
    expect(installCommandFor('linux')).toMatch(/^pnpm exec playwright install chromium/);
    expect(installCommandFor('linux')).toContain('sudo pnpm exec playwright install-deps chromium');
    expect(installCommandFor('win32')).toContain('pnpm qa:setup');
  });
});
