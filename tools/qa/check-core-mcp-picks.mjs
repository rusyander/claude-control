/**
 * Выбор серверов MCP человека для задач ядра (этап 10, s10 p9) — карточка «Серверы MCP для задач
 * ядра» на `/core/launch`, настоящая дорога: одноразовая панель + своё ядро (`startStand({ core })`),
 * браузер ходит через прокладку панели, ответы ядра не перехватываются. Дом стенда несёт конфиг
 * Claude Code с двумя серверами MCP (`probe`, `stray`), настройка ядра — выбор `ghost`, которого не
 * предлагает ни один CLI.
 *
 * Что видно:
 *   - строки карточки — серверы из конфига CLI (`GET /v1/mcp-offers`): `probe`/`stray` с CLI,
 *     областью и видом запуска; `ghost` помечен «ни один CLI не предлагает» (отрицательный 1);
 *   - отметки → «Сохранить выбор» → `config.json` ядра на диске несёт ровно выбранное
 *     (`chat: [probe]`, `work: [probe]`, `ghost` снят), прочие разделы целы;
 *   - чужая запись между чтением и сохранением (прямо в ядро, со своим доказательством) — запись
 *     экрана отказана 409, карточка называет отказ (отрицательный 2), на диске — чужая запись;
 *   - следующая задача (новый чат claude через ядро, модель — заглушка) пишет в журнал сигнал
 *     `mcp-human`: `offered: probe(user), stray(user)` и `picked: probe` — выбор экрана, не
 *     «по умолчанию».
 *
 * Запуск: `node tools/qa/check-core-mcp-picks.mjs` (стенд свой, `pnpm dev` не нужен; без `claude`
 * в PATH часть журнала — «не проверено»). `SHOTS=<dir>` — кадры карточки в обеих темах.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), '..', '..');
const PROBE = join(
  REPO_ROOT,
  'apps/core/src/adapters/conformance/__fixtures__/mcp-probe-server.mjs',
);

/** Модель заглушки: любой ход — короткий ответ (предмет проверки — журнал до модели). */
export function picksScript() {
  return () => ({ text: 'ответ ядра на выбор MCP' });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

async function main() {
  const { chromium } = await import('playwright');
  const { runOnStand, reapCoreSessions, wait } = await import('./throwaway-stand.mjs');
  const { uuidv7 } = await import('./core-scenario-stand.mjs');
  const SHOTS = process.env.SHOTS || '';
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';
  let repo = '';

  await runOnStand(
    {
      label: 'core-mcp-picks',
      extraPath: claudeAt ? [dirname(claudeAt)] : [],
      core: {
        stub: [{ name: 'stand', script: { module: SELF, export: 'picksScript', args: [] } }],
      },
      seed: ({ root, cfg, coreHome }) => {
        repo = join(root, 'repo');
        mkdirSync(repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.name', 'stand']);
        git(repo, ['config', 'user.email', 'stand@example.invalid']);
        writeFileSync(join(repo, 'notes.txt'), 'stand\n');
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'init']);
        // Серверы человека — в конфиге самого Claude Code (`<CLAUDE_CONFIG_DIR>/.claude.json`).
        const probeLog = join(root, 'probe.jsonl');
        writeFileSync(
          join(cfg, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              probe: { command: process.execPath, args: [PROBE], env: { PROBE_LOG: probeLog } },
              stray: { command: process.execPath, args: [PROBE], env: { PROBE_TOOL: 'stray' } },
            },
          }),
        );
        const cfgPath = join(coreHome, 'config.json');
        const doc = JSON.parse(readFileSync(cfgPath, 'utf8'));
        doc.mcpPicks = { work: ['ghost'] };
        writeFileSync(cfgPath, `${JSON.stringify(doc, null, 2)}\n`);
      },
    },
    async (stand, check) => {
      const cfgPath = join(stand.coreHome, 'config.json');
      const onDisk = () => JSON.parse(readFileSync(cfgPath, 'utf8'));
      const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
      const coreRow = () =>
        JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1);
      const direct = async (method, path, body) => {
        const res = await fetch(`${coreRow().url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, text: await res.text() };
      };
      const proof = async () => {
        const page = uuidv7();
        const minted = JSON.parse((await direct('GET', `/v1/nonce?page=${page}`)).text);
        return { nonce: minted.nonce, page };
      };

      const browser = await chromium.launch();
      try {
        const page = await stand.newPage(browser, { width: 1440, height: 1100 });
        const card = page.locator('[data-launch-section="mcp-picks"]');
        await page.goto(`${stand.webUrl}/core/launch`);
        await card.locator('[data-mcp-row="probe"]').waitFor({ timeout: 120_000 });

        // ── строки: предложения CLI и неизвестный выбор ─────────────────────────────────────
        const probeText = await card.locator('[data-mcp-row="probe"]').innerText();
        check(
          `probe — строка из конфига claude: область и вид запуска (${probeText.replace(/\s+/g, ' ')})`,
          /claude: пользователь, процесс/.test(probeText),
        );
        check('stray — тоже предложен', await card.locator('[data-mcp-row="stray"]').isVisible());
        const ghost = card.locator('[data-mcp-row="ghost"]');
        const ghostText = (await ghost.innerText().catch(() => '')).replace(/\s+/g, ' ');
        check(
          `отрицательный 1: ghost из настройки назван «ни один CLI не предлагает» (${ghostText.slice(0, 80)})`,
          ghostText.includes('ни один CLI не предлагает'),
        );
        check(
          'чат без записи — «все предложенные» отмечено, probe и stray в чате отмечены',
          (await card.locator('[data-mcp-all-default="chat"]').isChecked()) &&
            (await card.locator('[data-mcp-pick="chat:probe"]').isChecked()) &&
            (await card.locator('[data-mcp-pick="chat:stray"]').isChecked()),
        );
        const noReader = await card
          .locator('[data-mcp-no-reader]')
          .innerText()
          .catch(() => '');
        check(`CLI без чтения конфига названы (${noReader.slice(0, 90)})`, /gemini/.test(noReader));
        if (SHOTS) await shoot(page, card, SHOTS, 'mcp-picks-offers');

        // ── выбор и запись через прокладку ───────────────────────────────────────────────────
        await card.locator('[data-mcp-pick="chat:stray"]').click();
        await card.locator('[data-mcp-pick="work:probe"]').click();
        await card.locator('[data-mcp-pick="work:ghost"]').click();
        await card.locator('[data-mcp-picks-save]').click();
        const saved = await card
          .locator('[data-mcp-picks-saved]')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        const refusedText = saved
          ? ''
          : await card
              .locator('[data-mcp-picks-refused]')
              .innerText()
              .catch(() => '');
        check(`«Сохранить выбор» — запись принята ${refusedText}`, saved);
        const doc = onDisk();
        check(
          `на диске ровно выбранное: ${JSON.stringify(doc.mcpPicks)}, маршруты целы`,
          Object.keys(doc.mcpPicks ?? {}).length === 2 &&
            JSON.stringify(doc.mcpPicks?.chat) === '["probe"]' &&
            JSON.stringify(doc.mcpPicks?.work) === '["probe"]' &&
            Array.isArray(doc.routes?.stub),
        );
        await page.reload();
        await card.locator('[data-mcp-row="probe"]').waitFor({ timeout: 60_000 });
        check(
          'после перезагрузки: ghost ушёл, chat:stray снят, work:probe отмечен',
          (await card.locator('[data-mcp-row="ghost"]').count()) === 0 &&
            !(await card.locator('[data-mcp-pick="chat:stray"]').isChecked()) &&
            (await card.locator('[data-mcp-pick="work:probe"]').isChecked()),
        );
        if (SHOTS) await shoot(page, card, SHOTS, 'mcp-picks-saved');

        // ── отрицательный 2: чужая запись между чтением и сохранением ───────────────────────
        const view = JSON.parse((await direct('GET', '/v1/config')).text);
        const behind = await direct('POST', '/v1/config', {
          cmdId: uuidv7(),
          doc: { ...view.doc, mcpPicks: { ...view.doc.mcpPicks, fix: ['probe'] } },
          baseDigest: view.digest,
          proof: await proof(),
        });
        check(`чужая запись прямо в ядро принята (${behind.status})`, behind.status === 200);
        await card.locator('[data-mcp-pick="custom:probe"]').click();
        await card.locator('[data-mcp-picks-save]').click();
        const refused = await card
          .locator('[data-mcp-picks-refused]')
          .waitFor({ timeout: 20_000 })
          .then(() => card.locator('[data-mcp-picks-refused]').innerText())
          .catch(() => '');
        check(
          `отрицательный 2: устаревший отпечаток — отказ назван (${refused.replace(/\s+/g, ' ').slice(0, 90)})`,
          /Состояние изменилось/.test(refused),
        );
        const after = onDisk().mcpPicks;
        check(
          `на диске — чужая запись, правка экрана не легла (${JSON.stringify(after)})`,
          JSON.stringify(after?.fix) === '["probe"]' && after?.custom === undefined,
        );
        if (SHOTS) await shoot(page, card, SHOTS, 'mcp-picks-refused');

        // ── следующая задача: журнал называет предложенные и выбранный ──────────────────────
        if (!claudeAt) {
          console.log('  ~ claude не найден в PATH — журнал задачи не проверен');
          return;
        }
        const seeded = [];
        await page.route(/\/api\/core\/commands$/, async (route) => {
          const body = route.request().postDataJSON();
          if (body?.kind === 'set-cli') {
            const taskId = body.target.taskId;
            for (const [kind, fields] of [
              [
                'set-route',
                {
                  scope: 'task',
                  scopeId: taskId,
                  allowedRoutes: [
                    {
                      adapter: 'claude',
                      route: { kind: 'stub', id: 'stub:stand' },
                      modelPattern: '*',
                    },
                  ],
                },
              ],
              [
                'set-model',
                {
                  scope: 'task',
                  scopeId: taskId,
                  model: 'stub-model',
                  effort: null,
                  timing: 'now',
                },
              ],
            ]) {
              const r = await direct('POST', '/v1/commands', {
                cmdId: uuidv7(),
                kind,
                target: { taskId },
                fields,
                proof: await proof(),
              });
              seeded.push(r.status);
            }
          }
          await route.continue();
        });
        await page.goto(`${stand.webUrl}/core/chat?project=${encodeURIComponent(repo)}`);
        await page.locator('[data-core-chat-start]').waitFor({ timeout: 90_000 });
        await page.locator('[data-core-chat-cli] select').selectOption('claude');
        await page.locator('[data-core-chat-first] textarea').fill('ход-1: какие серверы у тебя?');
        await page.locator('[data-core-chat-submit]').click();
        await page.waitForURL(/[?&]id=/, { timeout: 60_000 });
        const taskId = new URL(page.url()).searchParams.get('id');
        const journal = () => {
          const dir = join(stand.coreHome, 'tasks', taskId);
          const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
          return readFileSync(join(dir, name), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        };
        let signal;
        for (let i = 0; i < 90 && !signal; i++) {
          signal = journal().find((l) => l.kind === 'signal' && l.data?.signal === 'mcp-human');
          if (!signal) await wait(1000);
        }
        const detail = signal?.data?.detail ?? '';
        check(
          `задача ${taskId} (засев ${seeded.join(',')}): журнал — offered probe и stray, picked probe (${detail})`,
          /offered: .*probe\(user\)/.test(detail) &&
            /stray\(user\)/.test(detail) &&
            /(^|; )picked: probe($|;)/.test(detail),
        );
        check('выбор экрана, не «по умолчанию»', detail !== '' && !detail.includes('by default'));
        // Чат закрывает человек: иначе отвязанный хост сеансов и CLI держат каталог стенда.
        await page
          .locator('[data-core-chat-assistant]')
          .first()
          .waitFor({ timeout: 120_000 })
          .catch(() => undefined);
        await page.locator('[data-core-chat-end]').click();
        await page
          .locator('[data-core-chat-status="closed"]')
          .waitFor({ timeout: 120_000 })
          .catch(() => undefined);
        reapCoreSessions(stand.coreHome);
      } finally {
        await browser.close();
      }
    },
  );
}

async function shoot(page, card, dir, name) {
  mkdirSync(dir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(200);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) await main();
