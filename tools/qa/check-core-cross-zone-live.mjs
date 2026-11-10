/**
 * Сквозной обход ядра через все зоны панели (этап 12, закрытие волны 1) — настоящая дорога:
 * одноразовая панель, своё ядро, настоящий `claude` из PATH против `packages/stub-model` (подменена
 * только модель: вход подписки — поддельный токен, адрес — заглушка, прокси мёртвый). Ответы панели и
 * ядра не перехватываются. Одна задача — сквозная нить: доска → окно карточки → чат → доска.
 *
 * Что видно, по порядку:
 *   - «В очередь» формы запуска: группа из трёх пунктов — одна запись, одиночная — вторая; на паузе
 *     обе в колонке «Очередь»; пауза снята — группа стартует задачей на пункт;
 *   - задачи группы встают на вопросе приёма: чип «Ждёт вас» доски и счёт кнопки доски в шапке чата
 *     совпадают;
 *   - одиночная идёт колонками стадий (разбор → работа); шаг работы упирается в окно входа CLI:
 *     задача ждёт окна (`waiting-window`), окно карточки показывает карточку лимита с вариантом
 *     «Другая модель: stub-alt», клик — одна команда `set-model`, задача идёт дальше другим маршрутом;
 *   - окно сброшено — «Взять вручную» в окне карточки открывает чат перехвата; «Открыть чат» приводит
 *     в `/chat` на этот разговор, он в боковом списке, сеансов шагов задачи в списке нет;
 *   - заметки к строке диффа в чате перехвата (правка человека в копии): «В очередь» во время хода —
 *     уходит после хода одним сообщением, «Сейчас» во время хода — одно слово «на ходу»;
 *   - «Вернуть ядру» — задача снова идёт, чат перехвата кончен; «На доработку» словами принята;
 *   - полоса группы (`?lane=group`) держит три карточки группы;
 *   - чат упирается в окно — карточка лимита в чате, «Перенести в codex» переносит разговор.
 *
 * Запуск: `node tools/qa/check-core-cross-zone-live.mjs` (стенд свой, `pnpm dev` не нужен; нужны
 * `claude` и `codex` в PATH). `SHOTS=<dir>` — кадры шагов. Код выхода: 0 — сходится, 1 — провал,
 * 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepDoneScript } from './check-core-timeline.mjs';
import { stepSessionsOf } from './check-takeover-chat.mjs';

const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
const RESEARCH = {
  map: {
    lines: ['README.md — единственный файл репозитория стенда'],
    files: [{ path: 'README.md', why: 'stand file' }],
    tests: [],
    owners: [],
  },
  classProposal: 'M',
};
/** Ход «занят» в чате перехвата — окно, в котором человек жмёт кнопку лотка заметок. */
const BUSY_MS = 25_000;

/** Слова человека в последнем его сообщении запроса (строка или текстовые блоки). */
function lastWords(body) {
  const human = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m) => m?.role === 'user')
    .at(-1);
  if (!human) return '';
  if (typeof human.content === 'string') return human.content;
  return (Array.isArray(human.content) ? human.content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ── Сценарий модели маршрута-заглушки ядра: этот же файл ядро грузит как модуль ───────────────

/** Шаг работы держится (задача идёт с живой копией); остальное — сдача шага. */
export function crossZoneCoreScript(opts = {}) {
  const base = stepDoneScript(opts);
  return (ctx) => {
    const text = JSON.stringify(ctx.request.body ?? {});
    if (text.includes('(work, step ') || text.includes('(fix, step '))
      return { text: 'работаю', holdMs: 900_000 };
    return base(ctx);
  };
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
  const { dismissAccess, openProjectChat } = await import('./chat-walk.mjs');
  const { walkBoard, walkTakeover, walkChatLimit } = await import('./cross-zone-steps.mjs');

  const SHOTS = process.env.SHOTS ?? '';
  const cliAt = (name) => {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  };
  const claude = cliAt('claude');
  const codex = cliAt('codex');

  // Заглушка входа CLI (`cli-login:claude`): шаги разбора, чат перехвата, чат человека. Шаг работы
  // одиночной упирается в окно (429 + rejected) на WINDOW_MS; чат с меткой «ход-L» — на десять минут.
  const WINDOW_MS = 90_000;
  const world = { windowUntil: 0, limitUntil: 0, said: [] };
  const base = stepDoneScript({ checkArgv: CHECK_ARGV, research: RESEARCH });
  const reject = (until) => ({
    error: { status: 429, type: 'rate_limit_error', message: 'rate limited' },
    window: {
      utilization: 1,
      resetsAt: Math.ceil(until / 1000),
      status: 'rejected',
      claim: 'five_hour',
    },
  });
  const cliStub = await startStubModel({
    script: (ctx) => {
      const body = ctx.request.body ?? {};
      const text = JSON.stringify(body);
      const said = lastWords(body);
      world.said.push(said);
      const now = Date.now();
      if (world.windowUntil && now < world.windowUntil) return reject(world.windowUntil);
      if (said.includes('ход-L')) {
        world.limitUntil ||= now + 600_000;
        if (now < world.limitUntil) return reject(world.limitUntil);
        return { text: 'ответ на ход-L' };
      }
      if (said.includes('Заметки к правкам')) return { text: 'заметки приняты' };
      if (said.includes('ZANYAT')) return { text: 'ответ на занятый ход', holdMs: BUSY_MS };
      if (text.includes('вручную и работает'))
        return { text: 'TAKEOVER-CHAT-READY: жду указаний человека.' };
      if (text.includes('(work, step ') && !world.windowUntil) {
        world.windowUntil = now + WINDOW_MS;
        return reject(world.windowUntil);
      }
      return base(ctx);
    },
  });
  const stubEnv = {
    ANTHROPIC_BASE_URL: cliStub.baseUrl,
    ANTHROPIC_MODEL: 'stub-model',
    CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-VENDOR-OAUTH',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repo = '';

  try {
    await runOnStand(
      {
        label: 'core-cross-zone',
        extraPath: [...new Set([claude, codex].filter(Boolean).map((p) => dirname(p)))],
        env: stubEnv,
        core: {
          stub: [
            {
              name: 'stand',
              // stub-alt — модель, на которую человек уводит шаг из карточки окна: маршрут обязан
              // её обслуживать, иначе суд `compat` откажет сеансу (model_absent).
              models: ['stub-model', 'stub-alt'],
              script: {
                module: SELF,
                export: 'crossZoneCoreScript',
                args: [{ checkArgv: CHECK_ARGV, research: RESEARCH }],
              },
            },
          ],
        },
        seed: ({ root, cfg, home, coreHome }) => {
          writeFileSync(
            join(cfg, 'settings.json'),
            `${JSON.stringify({ env: stubEnv }, null, 2)}\n`,
          );
          // Доска на паузе с пределом 2: записи постоят в очереди, пока их видно.
          const configFile = join(coreHome, 'config.json');
          const config = JSON.parse(readFileSync(configFile, 'utf8'));
          config.board = {
            inWork: 2,
            perDay: null,
            paused: true,
            stopOnQuestion: false,
            defaultStop: 'mr',
          };
          writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
          // Вход codex = его конфигурация в доме стенда; опора переноса — PROGRESS.md проекта.
          mkdirSync(join(home, '.codex'), { recursive: true });
          writeFileSync(join(home, '.codex', 'config.toml'), 'model = "stub-model"\n');
          repo = join(root, 'repo');
          mkdirSync(join(repo, '.agentdeck'), { recursive: true });
          mkdirSync(join(repo, '.agent'), { recursive: true });
          git(repo, ['init', '-q', '-b', 'main']);
          git(repo, ['config', 'user.name', 'stand']);
          git(repo, ['config', 'user.email', 'stand@example.invalid']);
          writeFileSync(join(repo, 'README.md'), 'stand\nстрока два\nстрока три\n');
          writeFileSync(join(repo, '.agent', 'PROGRESS.md'), 'Состояние работы.\n');
          writeFileSync(
            join(repo, '.agentdeck', 'checks.json'),
            `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
          );
          git(repo, ['add', '.']);
          git(repo, ['commit', '-qm', 'init']);
        },
      },
      async (stand, check) => {
        if (!claude) throw new NotChecked('claude нет в PATH — сессиям задач нужен CLI');
        if (!codex) throw new NotChecked('codex нет в PATH — цель переноса не проверена');
        const core = coreDirect(stand);
        const ctx = {
          stand,
          check,
          core,
          uuidv7,
          wait,
          repo,
          world,
          SHOTS,
          dismissAccess,
          openProjectChat,
          stepSessionsOf,
          journal: () => journalLines(stand),
        };
        const browser = await chromium.launch();
        try {
          const page = await stand.newPage(browser, { width: 1440, height: 1800 });
          const board = await walkBoard(ctx, page);
          if (!board) return;
          await walkTakeover(ctx, page, board);
          await walkChatLimit(ctx, browser);
          check('страница обхода без ошибок', page.errors.length === 0, page.errors.join('\n'));
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await cliStub.close?.();
  }
}

/** Строки журналов всех задач ядра стенда. */
function journalLines(stand) {
  const tasks = join(stand.coreHome, 'tasks');
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks).flatMap((taskId) =>
    readdirSync(join(tasks, taskId))
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(tasks, taskId, f), 'utf8')
          .split('\n')
          .filter(Boolean),
      )
      .map((l) => JSON.parse(l)),
  );
}
