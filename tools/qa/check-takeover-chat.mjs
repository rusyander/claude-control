/**
 * «Открыть чат» перехваченной задачи ядра (этап 12, P161 + B5) — настоящая дорога: одноразовая
 * панель, своё ядро, настоящий `claude` из PATH против сценария `packages/stub-model` (модель —
 * единственное, что подменено). Задача идёт до шага работы (шаг держится), человек берёт её
 * вручную, ядро открывает чат перехвата в копии единицы.
 *
 * Что видно:
 *   - `/core/chat?id=<задача чата>` приводит в `/chat?id=<сеанс перехвата>`, слово модели в ленте;
 *   - разговор стоит в боковом списке — во вкладке проекта, чья копия (на домашней вкладке, где
 *     только песочница, он был открыт, а в списке «Показано 0 из 0»); после перезагрузки — там же;
 *   - слово человека уходит в тот же чат перехвата (новой задачи ядра нет, модель ответила);
 *   - возврат: задача снова идёт, чат перехвата кончен, разговор остаётся в списке.
 *
 * Запуск: `node tools/qa/check-takeover-chat.mjs` (стенд свой, `pnpm dev` не нужен; нужен `claude`
 * в PATH). `SHOTS=<dir>` — кадр списка. Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepDoneScript } from './check-core-timeline.mjs';

// ── Сценарий модели: этот же файл ядро грузит как модуль заглушки ─────────────────────────────

/** Шаг работы держится (задача в работе с живой копией), чат перехвата отвечает текстом. */
export function takeoverChatScript(opts = {}) {
  const base = stepDoneScript(opts);
  return (ctx) => {
    const text = JSON.stringify(ctx.request.body ?? {});
    if (text.includes('VTOROE-SLOVO')) return { text: 'SECOND-TURN-SEEN' };
    if (text.includes('вручную и работает'))
      return { text: 'TAKEOVER-CHAT-READY: жду указаний человека.' };
    if (text.includes('(work, step ') || text.includes('(fix, step '))
      return { text: 'работаю', holdMs: 900_000 };
    return base(ctx);
  };
}

/**
 * Сеансы, которые ядро открыло под шаги задачи (не шаг `chat`): `{id, kind}`. Id сеанса ядра —
 * он же id транскрипта Claude (`--session-id`), под ним разговор встал бы в список чатов.
 */
export async function stepSessionsOf(view, taskId) {
  const v = await view(taskId);
  const kindOf = new Map((v?.steps ?? []).map((s) => [s.stepId, s.stepKind]));
  return (v?.sessions ?? [])
    .map((s) => ({ id: s.sessionId, kind: kindOf.get(s.stepId) ?? '?' }))
    .filter((s) => s.kind !== 'chat');
}

// ── Проверка ──────────────────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (isMain) await main();

async function main() {
  const { chromium } = await import('playwright');
  const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
  const { coreDirect, uuidv7 } = await import('./core-scenario-stand.mjs');
  const { NotChecked, runOnStand, wait } = await import('./throwaway-stand.mjs');

  const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
  const SHOTS = process.env.SHOTS ?? '';
  const cliStub = await startStubModel({ script: takeoverChatScript({ checkArgv: CHECK_ARGV }) });
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repo = '';

  try {
    await runOnStand(
      {
        label: 'takeover-chat',
        extraPath: claudeAt ? [dirname(claudeAt)] : [],
        core: {
          stub: [
            {
              name: 'stand',
              script: {
                module: SELF,
                export: 'takeoverChatScript',
                args: [{ checkArgv: CHECK_ARGV }],
              },
            },
          ],
        },
        seed: ({ root, cfg }) => {
          writeFileSync(
            join(cfg, 'settings.json'),
            `${JSON.stringify(
              {
                env: {
                  ANTHROPIC_BASE_URL: cliStub.baseUrl,
                  ANTHROPIC_API_KEY: 'sk-ant-stand-stub',
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                },
              },
              null,
              2,
            )}\n`,
          );
          repo = join(root, 'repo');
          mkdirSync(join(repo, '.agentdeck'), { recursive: true });
          git(repo, ['init', '-q', '-b', 'main']);
          git(repo, ['config', 'user.name', 'stand']);
          git(repo, ['config', 'user.email', 'stand@example.invalid']);
          writeFileSync(join(repo, 'README.md'), 'stand\n');
          writeFileSync(
            join(repo, '.agentdeck', 'checks.json'),
            `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
          );
          git(repo, ['add', '.']);
          git(repo, ['commit', '-qm', 'init']);
        },
      },
      async (stand, check) => {
        if (!claudeAt) throw new NotChecked('claude not in PATH');
        const core = coreDirect(stand);
        const est = await core.direct('POST', '/v1/estimate', {
          cmdId: uuidv7(),
          fields: {
            title: 'Перехват: проверка',
            request: 'Write hello.txt',
            repos: [{ path: repo, baseRef: null }],
            scenario: { preset: 'bug-fix' },
            launchPolicy: 'confirm',
            ciWait: false,
          },
          proof: await core.proof(),
        });
        const taskId = est.body?.taskId;
        if (!taskId) throw new Error(`estimate: ${est.status} ${est.text}`);
        const command = async (id, kind, fields) =>
          core.direct('POST', '/v1/commands', {
            cmdId: uuidv7(),
            kind,
            target: { taskId: id },
            fields,
            proof: await core.proof(),
          });
        const view = async (id) => (await core.direct('GET', `/v1/tasks/${id}`)).body?.view;
        const until = async (what, probe, seconds) => {
          for (let i = 0; i < seconds; i++) {
            const got = await probe();
            if (got) return got;
            await wait(1000);
          }
          throw new Error(`timeout: ${what}`);
        };
        await until(
          'awaiting-launch',
          async () => (await view(taskId))?.state === 'awaiting-launch',
          180,
        );
        for (const [kind, fields] of [
          [
            'set-route',
            {
              scope: 'task',
              scopeId: taskId,
              allowedRoutes: [
                { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
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
          ['launch', {}],
        ]) {
          const r = await command(taskId, kind, fields);
          if (r.body?.status !== 'applied') throw new Error(`${kind}: ${r.text}`);
        }
        await until(
          'live work step',
          async () =>
            ((await view(taskId))?.steps ?? []).some(
              (s) => s.state === 'running' && ['work', 'fix'].includes(s.stepKind),
            ),
          240,
        );
        const take = await command(taskId, 'take-over', {});
        check(
          `take-over принят (${take.body?.status} ${take.body?.code ?? ''})`,
          take.body?.status === 'applied',
          take.text,
        );
        const chatTaskId = take.body?.outcome?.chatTaskId;
        if (!chatTaskId) throw new Error(`no chatTaskId: ${take.text}`);
        const chat = await until(
          'takeover chat session',
          async () => {
            const v = await view(chatTaskId);
            return (v?.sessions ?? []).length > 0 ? v : null;
          },
          180,
        );
        const sessionId = chat.sessions[0].sessionId;
        // Первый ход должен лечь в транскрипт до перехода.
        await wait(8000);

        const browser = await chromium.launch();
        try {
          const page = await stand.newPage(browser, { width: 1440, height: 1000 });
          const listed = async () => {
            await page.waitForTimeout(4000);
            const count = await page
              .getByText(/Показано \d+ из \d+/)
              .first()
              .innerText()
              .catch(() => '(нет счётчика)');
            const rows = await page.locator(`[data-chat-pin="${sessionId}"]`).count();
            return { count, rows };
          };
          await page.goto(`${stand.webUrl}/core/chat?id=${chatTaskId}`);
          await page.waitForURL(/\/chat(\?|$)/, { timeout: 60_000 });
          await page.waitForTimeout(6000);
          const landed = new URL(page.url()).searchParams.get('id');
          check(
            `/core/chat?id=<задача чата> → /chat?id=<сеанс перехвата> (${landed})`,
            landed === sessionId,
          );
          const body = await page
            .locator('main')
            .innerText()
            .catch(() => '');
          check('лента — разговор перехвата (слово модели)', body.includes('TAKEOVER-CHAT-READY'));
          const first = await listed();
          check(
            `разговор в боковом списке после «Открыть чат» (${first.count}, строк ${first.rows})`,
            first.rows === 1,
          );
          // Сеансы, что ядро открыло под шаги задачи (разбор, план, работа), — не разговоры
          // человека: они живут в дереве агентов задачи, в списке чатов их нет. Чат перехвата
          // (шаг `chat`) — разговор человека и остаётся.
          const steps = await stepSessionsOf(view, taskId);
          const listedIds = new Set(((await stand.api('/chats')).body ?? []).map((c) => c.id));
          const projectIds = new Set(
            ((await stand.api('/chats/projects')).body ?? []).flatMap((p) =>
              (p.chats ?? []).map((c) => (typeof c === 'string' ? c : c.id)),
            ),
          );
          let stepRows = 0;
          for (const s of steps)
            stepRows += await page.locator(`[data-chat-pin="${s.id}"]`).count();
          const leaked = steps.filter((s) => listedIds.has(s.id) || projectIds.has(s.id));
          check(
            `сеансы шагов задачи (${steps.map((s) => s.kind).join(', ') || 'нет'}) не в списке чатов: в ответах ${leaked.map((s) => s.kind).join(', ') || 'нет'}, строк ${stepRows}; чат перехвата в ответе ${listedIds.has(sessionId)}`,
            steps.length > 0 && leaked.length === 0 && stepRows === 0 && listedIds.has(sessionId),
          );
          if (SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: join(SHOTS, 'takeover-chat-list_AFTER.png') });
          }
          await page.reload();
          const second = await listed();
          check(
            `после перезагрузки — там же (${second.count}, строк ${second.rows}, ${new URL(page.url()).search})`,
            second.rows === 1 && new URL(page.url()).searchParams.get('id') === sessionId,
          );
          const tasks = async () =>
            ((await core.direct('GET', '/v1/tasks')).body?.tasks ?? []).length;
          const before = await tasks();
          const box = page.getByPlaceholder(/Спросите что угодно/);
          await box.fill('VTOROE-SLOVO от человека');
          await box.press('Enter');
          const seen = await until(
            'second turn answered',
            async () =>
              (await page.locator('main').innerText()).includes('SECOND-TURN-SEEN') ? true : null,
            120,
          ).catch(() => false);
          const after = await tasks();
          const chatView = await view(chatTaskId);
          check(
            `слово человека — в тот же чат перехвата (ответ ${seen === true}, задач ядра ${before} → ${after}, чат ${chatView?.ended ?? 'идёт'})`,
            seen === true && after === before && chatView?.ended === null,
          );
          const back = await command(taskId, 'hand-back', { note: 'готово' });
          check(
            `возврат принят (${back.body?.status})`,
            back.body?.status === 'applied',
            back.text,
          );
          const resumed = await until(
            'task resumed',
            async () => {
              const v = await view(taskId);
              return v?.state === 'running' && !v.takeover ? v : null;
            },
            60,
          ).catch(() => null);
          check(`задача снова идёт (${resumed?.state ?? 'нет'})`, resumed?.state === 'running');
          const ended = await until(
            'chat ended',
            async () => (await view(chatTaskId))?.ended ?? null,
            60,
          ).catch(() => null);
          check(`чат перехвата кончен (${ended})`, Boolean(ended));
          await page.reload();
          const third = await listed();
          check(
            `после возврата разговор в списке (${third.count}, строк ${third.rows})`,
            third.rows === 1,
          );
          check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await cliStub.close?.();
  }
}
