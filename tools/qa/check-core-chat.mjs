/**
 * Чат панели через ядро `/core/chat` (этап 10, F2, проход 2) — настоящая дорога: одноразовая панель,
 * своё ядро, настоящие CLI из PATH человека (`CLIS`, по умолчанию `claude,qwen,codex`) против
 * сценария `packages/stub-model` в трёх диалектах — anthropic-messages, openai-chat,
 * openai-responses (модель — единственное, что подменено). Браузер ходит через прокладку панели; ответы ядра не
 * перехватываются. Единственный засев мимо экрана — маршрут и модель задачи (`set-route`,
 * `set-model`): экран чата их не выбирает, это настройка; засев идёт прямо в ядро в тот миг, когда
 * экран шлёт `set-cli`, и запрос экрана уходит дальше без изменений.
 *
 * Что видно, для каждого CLI:
 *   - новый чат = задача ядра: адрес `?id=<taskId>`, в журнале `session.started` этого CLI с
 *     `cwd` = корень проекта (на месте, без копии);
 *   - процесс CLI — потомок хоста сеансов ядра, а не сервера панели;
 *   - ответ модели и строка инструмента (чтение файла проекта, результат вернулся в ответ) на экране;
 *   - второй ход человека (`message-to-step`) доходит и получает ответ;
 *   - жёсткий перезапуск панели: лента та же, ни один ход не потерян и не повторён, следующий ход
 *     после перезапуска получает ответ;
 *   - «Закрыть» (`end-chat`) — задача кончается, композера нет;
 *   - чужой CLI (не claude): «Новый» в чате этого провайдера ведёт на `/core/chat?cli=<cli>`, старый
 *     разговор панели (`/api/provider-chat/chats`) не заводится.
 *
 * Отказ (`REFUSED`, по умолчанию `aider,continue`): CLI без хука ядра — экран называет отказ ядра
 * с кодом `no_core_hook`, композера нет, старый исполнитель не вызван, под панелью нет процесса CLI.
 *
 * `BEFORE=1` — прежняя дорога для кадров «до»: чат `/chat` панели, CLI — ребёнок сервера панели.
 * Запуск: `node tools/qa/check-core-chat.mjs` (стенд свой, `pnpm dev` не нужен; CLI, которого нет
 * в PATH, — его часть «не проверено»). `SHOTS=<dir>` — кадры в обеих темах.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIM_UTF8, parseCimJson } from '../../apps/server/src/lib/cim-json.ts';
import { basicsReply, basicsSteps, modelReached, pickModel } from './core-chat-basics-steps.mjs';

// ── Сценарий модели: этот же файл ядро грузит как модуль заглушки ─────────────────────────────

export const FILE_MARK = 'метка-файла-7731';

/** Текст содержимого сообщения любой формы (строка, блоки, результат инструмента). */
function flat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? flat(b?.content))))
    .filter(Boolean)
    .join('\n');
}

/**
 * Результат инструмента в сообщении: openai-chat — роль `tool`; anthropic — блоки `tool_result`;
 * openai-responses (Codex) — элементы `function_call_output` / `custom_tool_call_output`.
 */
function toolResultOf(m) {
  if (m?.role === 'tool') return flat(m.content);
  if (m?.type === 'function_call_output' || m?.type === 'custom_tool_call_output') {
    return typeof m.output === 'string' ? m.output : flat(m.output?.content ?? m.output);
  }
  if (m?.role !== 'user' || !Array.isArray(m.content)) return '';
  return flat(m.content.filter((b) => b?.type === 'tool_result'));
}

/** Сообщения запроса в любом диалекте: `messages` (anthropic, openai-chat) или `input` (responses). */
function messagesOf(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  return Array.isArray(body?.input) ? body.input : [];
}

/**
 * Вызов чтения файла тем инструментом, что предложил CLI. Имя поля пути — из схемы: у Qwen оно
 * менялось между версиями (`absolute_path` → `file_path`), угаданное имя дало бы отказ инструмента.
 * У Codex чтения нет — команда оболочки (`shell_command` строкой, `shell` массивом, `exec_command`).
 */
function readCall(tools, file) {
  const reader = tools.find(
    (t) => t.name === 'Read' || t.name === 'read_file' || t.name === 'read',
  );
  const propsOf = (t) => Object.keys(t?.schema?.properties ?? {});
  if (reader) {
    const props = propsOf(reader);
    const key =
      ['file_path', 'absolute_path', 'filePath', 'path'].find((k) => props.includes(k)) ??
      'file_path';
    return { name: reader.name, args: { [key]: file } };
  }
  const win = process.platform === 'win32';
  // `type "<путь>"` понимают обе оболочки Windows: у Codex это PowerShell (`type` — его псевдоним
  // Get-Content), у Goose — cmd, где Get-Content нет и чтение кончалось кодом 1.
  const line = win ? `type "${file}"` : `cat '${file}'`;
  const shell = tools.find((t) => ['shell_command', 'exec_command', 'shell'].includes(t.name));
  if (!shell) return null;
  const props = propsOf(shell);
  if (props.includes('cmd')) return { name: shell.name, args: { cmd: line } };
  const asArray = shell.schema?.properties?.command?.type === 'array';
  const command = asArray
    ? win
      ? ['powershell.exe', '-NoProfile', '-Command', line]
      : ['cat', file]
    : line;
  return { name: shell.name, args: { command } };
}

/** Текст человека в сообщении без результатов инструментов. */
function wordsOf(m) {
  if (m?.role !== 'user') return '';
  return Array.isArray(m.content)
    ? flat(m.content.filter((b) => b?.type !== 'tool_result'))
    : flat(m.content);
}

/**
 * Чат-заглушка, одинаковая для диалектов Claude (anthropic-messages) и Qwen (openai-chat). Ход —
 * последнее сообщение человека с «ход-N» (CLI добавляют свои сообщения после него — напоминания,
 * контекст хуков, поэтому не «последнее сообщение»): после него уже есть результат инструмента →
 * ответ с его текстом; «покажи файл» → вызов чтения файла тем инструментом, что предложил CLI;
 * иначе «ответ на ход-N». Без хода (служебные запросы CLI) — короткий текст.
 */
export function chatScript({ file }) {
  return (ctx) => {
    const messages = messagesOf(ctx.request.body);
    let at = -1;
    messages.forEach((m, i) => {
      if (/ход-\d+/.test(wordsOf(m))) at = i;
    });
    const toolResult = messages
      .slice(at + 1)
      .map(toolResultOf)
      .filter(Boolean)
      .at(-1);
    const said = at >= 0 ? wordsOf(messages[at]) : '';
    // Основы чата `/chat` (два шага, вложения, переполненный контекст) — свои ответы.
    const basics =
      at >= 0
        ? basicsReply({
            said,
            after: messages.slice(at + 1),
            tools: ctx.info.tools,
            file,
            readCall,
          })
        : undefined;
    if (basics) return basics;
    if (at >= 0 && toolResult) return { text: `файл прочитан: ${toolResult.slice(0, 200)}` };
    // «долгий» — ответ придержан: ход, который человек останавливает посреди генерации.
    if (/долгий/.test(said)) return { text: 'ответ на долгий ход', holdMs: 120_000 };
    // «медленный» — ответ через 8 с: ход занят, человек успевает написать «на ходу».
    if (/медленный/.test(said)) {
      return { text: `ответ на ход-${/ход-(\d+)/.exec(said)?.[1]}`, holdMs: 8_000 };
    }
    // «запиши вне» — правка вне корня проекта: вне гранта чата ядро отказывает само (outside-copy).
    const writer = ctx.info.tools.find((t) => t.name === 'Write');
    if (/запиши вне/.test(said) && writer) {
      return {
        tool: {
          name: 'Write',
          args: {
            file_path: join(dirname(dirname(file)), 'outside.txt'),
            content: 'вне проекта\n',
          },
        },
      };
    }
    if (/покажи файл/.test(said)) {
      const call = readCall(ctx.info.tools, file);
      if (!call) return { text: `нет инструмента чтения: ${ctx.info.tools.map((t) => t.name)}` };
      return { tool: call };
    }
    const turn = /ход-(\d+)/.exec(said)?.[1];
    return { text: turn ? `ответ на ход-${turn}` : 'stub side reply' };
  };
}

// ── Проверка ──────────────────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (isMain) await main();

/** Таблица процессов — только чтение: номер → родитель, команда. */
function processTable() {
  const table = new Map();
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        CIM_UTF8 +
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    // Тот же разбор, что у сервера: вывод PowerShell кодовой страницей консоли превращал «•» в
    // чужой командной строке в сырой BEL, и JSON.parse ронял всю таблицу — прогон падал.
    for (const row of parseCimJson(out)) {
      table.set(row.ProcessId, { parent: row.ParentProcessId, command: row.CommandLine ?? '' });
    }
    return table;
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { parent: Number(m[2]), command: m[3] });
  }
  return table;
}

/** Цепочка предков процесса (сам, родитель, …) — до корня или петли. */
function ancestry(pid, table) {
  const chain = [];
  for (let at = pid; at && table.has(at) && !chain.includes(at); at = table.get(at).parent) {
    chain.push(at);
  }
  return chain;
}

async function main() {
  const { chromium } = await import('playwright');
  const { runOnStand, NotChecked, wait } = await import('./throwaway-stand.mjs');
  const { uuidv7 } = await import('./core-scenario-stand.mjs');

  const SHOTS = process.env.SHOTS || '';
  const BEFORE = process.env.BEFORE === '1';
  const cliAt = (name) => {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  };
  // CLI, чей чат идёт через ядро до конца, и CLI, которым ядро отказывает по имени (`no_core_hook`:
  // поставить хук ядра некуда). Порядок — порядок прогона; бинарь CLI ищется по имени образа.
  const list = (v, dflt) =>
    (v ?? dflt)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  // Аргументы `--clis=<…> --refused=<…> --panel-chat=0` сильнее окружения: кейс блока «Тесты»
  // связывается с файлом и своими аргументами (`automation.testName`), а не с окружением.
  const arg = (name) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const CLIS = list(arg('clis') ?? process.env.CLIS, 'claude,qwen,codex');
  const PANEL_CHAT = (arg('panel-chat') ?? process.env.PANEL_CHAT) !== '0';
  const REFUSED = list(arg('refused') ?? process.env.REFUSED, 'aider,continue');
  const IMAGE = { continue: 'cn' };
  const found = Object.fromEntries(
    // Каталог claude — в PATH стенда всегда (сам claude заслоняет заглушка стенда): чат `/chat`
    // идёт через него, а предпроверка оценки ядра ищет CLI разрешённых маршрутов задачи (вход
    // CLI: claude, qwen). Без него строка aider/goose (их каталог `~/.local/bin` без claude)
    // вставала на оценке «claude/qwen not found» и до проверяемого отказа не доходила; continue
    // проходил только потому, что `cn` лежит рядом с claude.cmd (живой прогон 02.11).
    [...new Set([...CLIS, ...REFUSED, 'claude'])].map((cli) => [cli, cliAt(IMAGE[cli] ?? cli)]),
  );
  const extraPath = [
    ...new Set(
      Object.values(found)
        .filter(Boolean)
        .map((p) => dirname(p)),
    ),
  ];
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repo = '';
  let file = '';
  let trace = '';
  /** Последние запросы к заглушке: диалект, инструменты, хвост сообщений — причина провала. */
  const traceTail = (n = 4) => {
    try {
      return readFileSync(trace, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-n)
        .map((l) => {
          const r = JSON.parse(l);
          const msgs = r.body?.messages ?? [];
          return `${r.kind ?? ''} ${r.dialect ?? ''} → ${r.reply ?? ''} ${r.scriptError ?? ''} ${JSON.stringify(msgs.slice(-2)).slice(0, 600)}`;
        })
        .join('\n    ');
    } catch (error) {
      return `следа нет: ${error.message}`;
    }
  };

  async function shoot(page, name) {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const tag = BEFORE ? 'BEFORE' : 'AFTER';
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${tag}.png`) });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
  }

  // «До»: прежний чат панели зовёт CLI сам — его модель та же заглушка, по адресу из окружения
  // панели; ответ придержан, чтобы процесс CLI успели застать в таблице процессов.
  //
  // «После» та же заглушка — модель входа CLI (`cli-login`) в окружении стенда: чат `/chat` панели
  // идёт задачей ядра, а маршрут задачи без засева — вход CLI, т.е. claude с адресом и ключом из
  // окружения ядра (у входа CLI звена нет, окружение доезжает как есть). Путь файла заглушка узнаёт
  // после засева стенда (`panelFile`).
  const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
  let panelFile = 'notes.txt';
  const panelTrace = [];
  // Тела запросов к модели чата `/chat` целиком: что дошло до модели (модель, усилие, байты
  // вложений, вызовы чтения) — свидетельство основ чата (`core-chat-basics-steps.mjs`).
  const panelBodies = [];
  const beforeStub = await startStubModel({
    script: (ctx) => {
      const words = messagesOf(ctx.request.body).map(wordsOf).filter(Boolean);
      panelTrace.push(words.at(-1) ?? '');
      panelBodies.push({
        said: words.filter((w) => /ход-\d+/.test(w)).at(-1) ?? '',
        body: ctx.request.body,
      });
      const reply = chatScript({ file: panelFile })(ctx);
      return BEFORE ? { ...reply, holdMs: 20_000 } : reply;
    },
  });
  const stubEnv = { ANTHROPIC_BASE_URL: beforeStub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

  await runOnStand(
    {
      label: 'core-chat',
      extraPath,
      env: stubEnv,
      core: {
        stub: [
          {
            name: 'stand',
            script: { module: SELF, export: 'chatScript', args: [{ file: '__FILE__' }] },
          },
        ],
      },
      seed: ({ root, coreHome }) => {
        repo = join(root, 'repo');
        file = join(repo, 'notes.txt');
        mkdirSync(repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.name', 'stand']);
        git(repo, ['config', 'user.email', 'stand@example.invalid']);
        writeFileSync(file, `${FILE_MARK}\n`);
        panelFile = file;
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'init']);
        // Путь файла и след заглушки известны только после создания дома стенда.
        const cfgPath = join(coreHome, 'config.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        cfg.routes.stub[0].script.args[0].file = file;
        trace = join(root, 'stub-trace.jsonl');
        cfg.routes.stub[0].trace = trace;
        writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
      },
    },
    async (stand, check) => {
      const browser = await chromium.launch();
      try {
        if (BEFORE) await before(stand, check, browser);
        else {
          // Прежний чат `/chat`: старый разговор продолжает задача ядра (этап 10, F2, проход 3).
          if (PANEL_CHAT) {
            if (found.claude) await panelChat(stand, check, browser);
            else console.log('  ~ claude не найден в PATH — чат /chat через ядро не проверен');
          }
          for (const cli of CLIS) {
            if (!found[cli]) {
              console.log(`  ~ ${cli} не найден в PATH — его часть не проверена`);
              continue;
            }
            // Провал одного CLI не снимает строки остальных: каждый — свой вердикт.
            await after(stand, check, browser, cli).catch((error) =>
              check(`${cli}: сценарий дошёл до конца`, false, error?.stack ?? String(error)),
            );
          }
          // Отказ по имени не зависит от бинаря: ядро отказывает раньше процесса.
          for (const cli of REFUSED) await refused(stand, check, browser, cli);
          // Пустой `CLIS=` с чатом /chat или со строками отказа — прогон только их, проверено то,
          // что он прогнал.
          const othersOnly =
            CLIS.length === 0 && ((PANEL_CHAT && found.claude) || REFUSED.length > 0);
          if (!othersOnly && !CLIS.some((cli) => found[cli])) {
            throw new NotChecked(`ни одного из ${CLIS.join(', ')} нет в PATH`);
          }
        }
      } finally {
        await browser.close();
        await beforeStub?.close();
      }
    },
  );

  /** Активный CLI раздела чата — настройка человека: правится из браузера, как кнопкой. */
  async function setProvider(page, provider) {
    const patch = () =>
      page.evaluate(async (p) => {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: p }),
        });
        return res.status;
      }, provider);
    // Холодный Vite на первом заходе перезагружает страницу после оптимизации зависимостей —
    // fetch посреди перезагрузки обрывается «Failed to fetch». Повтор после загрузки, не больше трёх.
    const attempt = async (n) => {
      await page.waitForLoadState('load');
      try {
        return await patch();
      } catch (error) {
        if (n >= 3 || !/Failed to fetch|Execution context was destroyed/.test(String(error)))
          throw error;
        await wait(2000);
        return attempt(n + 1);
      }
    };
    const status = await attempt(1);
    if (status !== 200) throw new Error(`настройка provider=${provider}: ${status}`);
  }

  /**
   * Сколько разговоров у прежнего исполнителя чужого CLI — тихий откат на него виден здесь.
   * Объявление функцией, не `const`: сценарий выше зовёт её до этой строки (иначе TDZ).
   */
  async function oldForeignChats(stand) {
    const r = await stand.api('/provider-chat/chats');
    return Array.isArray(r.body) ? r.body.length : (r.body?.chats?.length ?? -1);
  }

  /**
   * Вход человека в чат чужого CLI: раздел «Чат» с этим CLI активным, кнопка «Новый» — она ведёт в
   * чат ядра с этим CLI, а не заводит разговор прежнего исполнителя (`ProviderChatRun`).
   */
  async function foreignEntry(stand, check, page, cli) {
    await page.goto(`${stand.webUrl}/settings`);
    await setProvider(page, cli);
    const chatsBefore = await oldForeignChats(stand);
    await page.goto(`${stand.webUrl}/chat`);
    const fresh = page.getByRole('button', { name: 'Новый', exact: true }).first();
    await fresh.waitFor({ timeout: 90_000 });
    await fresh.click();
    const moved = await page
      .waitForURL(/\/core\/chat/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const url = new URL(page.url());
    const picked = moved
      ? await page
          .locator('[data-core-chat-cli] select')
          .inputValue({ timeout: 30_000 })
          .catch(() => '')
      : '';
    check(
      `${cli}: «Новый» в чате ${cli} открывает чат ядра с этим CLI (${url.pathname}${url.search}, выбран ${picked || '—'})`,
      moved && url.searchParams.get('cli') === cli && picked === cli,
    );
    const chatsAfter = await oldForeignChats(stand);
    check(
      `${cli}: прежний исполнитель разговор не завёл (${chatsBefore} → ${chatsAfter})`,
      // -1 — список не прочитан: без числа «не изменилось» ничего не доказывает.
      chatsBefore >= 0 && chatsAfter === chatsBefore,
    );
    if (moved) await shoot(page, `core-chat-${cli}-entry`);
    await setProvider(page, 'claude');
  }

  /**
   * CLI без хука ядра: чат начинается задачей ядра, и ядро отказывает по имени — экран называет
   * отказ, композера нет; прежний исполнитель не зовётся, процесса CLI под панелью нет.
   */
  async function refused(stand, check, browser, cli) {
    const page = await stand.newPage(browser, { width: 1440, height: 1100 });
    await seedOnSetCli(stand, page, cli);
    // Прежний исполнитель заводился только POST /api/provider-chat/chats. Список его разговоров при
    // активном Claude не читается (-1 → -1 прошло бы всегда), поэтому считаются сами запросы страницы.
    const legacyPosts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/provider-chat/chats'))
        legacyPosts.push(request.url());
    });
    await page.goto(
      `${stand.webUrl}/core/chat?cli=${encodeURIComponent(cli)}&project=${encodeURIComponent(repo)}`,
    );
    await page.locator('[data-core-chat-start]').waitFor({ timeout: 90_000 });
    const picked = await page.locator('[data-core-chat-cli] select').inputValue();
    check(`${cli}: форма начинает с ${cli} из адреса (${picked})`, picked === cli);
    await page.locator('[data-core-chat-first] textarea').fill('ход-1: привет');
    await page.locator('[data-core-chat-submit]').click();
    await page.waitForURL(/[?&]id=/, { timeout: 60_000 }).catch(() => null);
    const taskId = new URL(page.url()).searchParams.get('id');
    const named = page.locator('[data-core-chat-launch-refused]');
    const seen = await named
      .waitFor({ timeout: 120_000 })
      .then(() => true)
      .catch(() => false);
    const text = seen ? await named.innerText() : '';
    check(
      `${cli}: ядро отказало по имени, экран называет отказ (задача ${taskId ?? '—'}: «${text.replace(/\s+/g, ' ').slice(0, 160)}»)`,
      !!taskId && seen && text.includes('no_core_hook'),
      // Пустой экран без отказа (форма висит на «Запустить») ничего не называл: хвосты журналов
      // панели и ядра — где встала оценка.
      [
        await page
          .locator('[data-core-chat-screen], [data-core-chat-start-failed]')
          .first()
          .innerText({ timeout: 2_000 })
          .catch(() => ''),
        seen
          ? ''
          : `панель: ${stand.log().slice(-1200)}\n    ядро: ${stand.coreLog().slice(-1200)}`,
      ]
        .filter(Boolean)
        .join('\n    '),
    );
    check(
      `${cli}: композера нет — писать в отказанный чат нечего`,
      (await page.locator('[data-core-chat-composer]').count()) === 0,
    );
    check(
      `${cli}: прежний исполнитель не позван (POST /api/provider-chat/chats: ${legacyPosts.length})`,
      legacyPosts.length === 0,
      legacyPosts.join('\n    '),
    );
    const image = IMAGE[cli] ?? cli;
    const table = processTable();
    const underPanel = [...table].filter(
      ([pid, row]) =>
        new RegExp(`\\b${image}(\\.exe|\\.cmd)?\\b`, 'i').test(row.command) &&
        !/powershell/i.test(row.command) &&
        ancestry(pid, table).includes(stand.serverPid()),
    );
    check(
      `${cli}: процесса ${image} под сервером панели нет`,
      underPanel.length === 0,
      underPanel.map(([pid, row]) => `${pid}: ${row.command.slice(0, 120)}`).join('\n    '),
    );
    await shoot(page, `core-chat-${cli}-refused`);
    await page.close();
  }

  /**
   * Прежний чат `/chat` на ядре (этап 10, F2, проход 3). Старый разговор — транскрипт, который
   * настоящий claude записал сам (`claude -p --session-id`, как писал прежний исполнитель панели).
   * Что видно:
   *   - ход из `/chat` в этом разговоре = задача ядра на месте; CLI — потомок хоста сеанса ядра;
   *   - тот же файл транскрипта получает новый ход (разговор продолжен, а не начат заново);
   *   - второй ход — тем же шагом (`message-to-step`), новой задачи нет;
   *   - «Остановить» снимает задачу ядра (`task` кончилась отменой), CLI сеанса не жив;
   *   - ход после остановки — новая задача с продолжением того же транскрипта;
   *   - правка вне корня проекта — карточка права в `/chat`, «Разрешить» доходит до ядра ответом.
   */
  async function panelChat(stand, check, browser) {
    const { randomUUID } = await import('node:crypto');
    const { openProjectChat } = await import('./chat-walk.mjs');
    const tasks = () => {
      try {
        return readdirSync(join(stand.coreHome, 'tasks'));
      } catch {
        return [];
      }
    };
    const journalOf = (taskId) => {
      const dir = join(stand.coreHome, 'tasks', taskId);
      const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
      return readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    };
    const conv = randomUUID();
    const transcript = () => {
      const projects = join(stand.cfg, 'projects');
      for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
        const path = join(projects, dir, `${conv}.jsonl`);
        if (existsSync(path)) return readFileSync(path, 'utf8');
      }
      return '';
    };
    // Вход claude стенда — адрес и ключ в `env` личного settings.json, как у человека со своим
    // адресом модели: пин задачи ядра несёт только дом и CLAUDE_CONFIG_DIR, окружение стенда
    // (`stubEnv`) до CLI ядра не доходит, а личный слой ядро передаёт как есть.
    const settingsPath = join(stand.cfg, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
    );
    // Старый разговор: настоящий claude, окружение стенда, модель — заглушка.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(AGENTDECK|CLAUDE_CODE)/i.test(k)),
      ),
      HOME: stand.home,
      USERPROFILE: stand.home,
      CLAUDE_CONFIG_DIR: stand.cfg,
      ...stubEnv,
    };
    // Не `spawnSync`: заглушка модели живёт в этом же процессе, и замёрзший цикл событий
    // не ответил бы CLI, пока его не убьёт срок.
    const seeded = await new Promise((done) => {
      const child = spawn(
        'claude',
        ['-p', '"ход-4: старый разговор"', '--session-id', conv, '--output-format', 'json'],
        { cwd: repo, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, stdout, stderr });
      });
    });
    const oldTurn = transcript();
    check(
      `/chat: старый разговор ${conv} записан самим claude (транскрипт ${oldTurn.length} байт)`,
      oldTurn.includes('ответ на ход-4'),
      `${seeded.status} ${seeded.stderr?.slice(0, 400)} ${seeded.stdout?.slice(0, 400)}`,
    );
    if (!oldTurn) return;

    const page = await openProjectChat(stand, browser, repo, 'repo');
    await page.goto(`${stand.webUrl}/chat?id=${conv}`);
    const input = page.locator('textarea[data-chat-input]');
    await input.waitFor({ timeout: 90_000 });
    const shown = (text, seconds = 180) =>
      page
        .getByText(text)
        .first()
        .waitFor({ timeout: seconds * 1000 })
        .then(() => true)
        .catch(() => false);
    check(
      '/chat: старый разговор открыт, прежний ответ на экране',
      await shown('ответ на ход-4', 60),
    );
    const say = async (text) => {
      await input.fill(text);
      await input.press('Enter');
    };
    const newTask = async (before) => {
      for (let i = 0; i < 90; i++) {
        const fresh = tasks().filter((t) => !before.includes(t));
        if (fresh.length > 0) return fresh;
        await wait(1000);
      }
      return [];
    };

    // Ход 5: задача ядра с продолжением разговора.
    const before5 = tasks();
    await say('ход-5: продолжаем через ядро');
    const fresh5 = await newTask(before5);
    check(`/chat: ход стал задачей ядра (${fresh5.join(',') || 'нет'})`, fresh5.length === 1);
    const answered5 = await shown('ответ на ход-5');
    // Почему нет ответа: хвост журнала задачи и последние слова, дошедшие до модели.
    const why = (id) =>
      `журнал: ${journalOf(id)
        .slice(-12)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`)
        .join('\n      ')}\n    модель: ${panelTrace
        .slice(-4)
        .map((t) => t.slice(-120).replace(/\s+/g, ' '))
        .join(' | ')}`;
    check(
      '/chat: ответ модели на ход через ядро на экране',
      answered5,
      fresh5[0] ? why(fresh5[0]) : '',
    );
    // `DUMP=<каталог>` — разбор провала: дом ядра и транскрипты стенда уезжают туда до уборки.
    if (!answered5 && process.env.DUMP) {
      const { cpSync } = await import('node:fs');
      cpSync(stand.coreHome, join(process.env.DUMP, 'core-home'), { recursive: true });
      cpSync(join(stand.cfg, 'projects'), join(process.env.DUMP, 'projects'), { recursive: true });
    }
    const taskId = fresh5[0];
    if (!taskId) return;
    const started = journalOf(taskId).find((l) => l.kind === 'session.started')?.data;
    check(
      `/chat: сеанс claude в корне проекта, на месте (cwd ${started?.cwd})`,
      started?.adapter === 'claude' &&
        resolve(started.cwd).toLowerCase() === resolve(repo).toLowerCase(),
      JSON.stringify(started),
    );
    if (started?.cliPid) {
      const chain = ancestry(started.cliPid, processTable());
      check(
        `/chat: CLI — потомок хоста сеанса ядра, не панели (${chain.join(' ← ')})`,
        chain.includes(started.hostPid) && !chain.includes(stand.serverPid()),
        `host ${started.hostPid}, panel ${stand.serverPid()}`,
      );
    } else check('/chat: номер процесса CLI в журнале ядра', false, JSON.stringify(started));
    const after5 = transcript();
    check(
      '/chat: тот же транскрипт продолжен (ход-4 и ход-5 в одном файле)',
      after5.includes('ответ на ход-4') && after5.includes('ответ на ход-5'),
    );

    // Ход 6: тот же шаг, новой задачи нет.
    const before6 = tasks();
    await say('ход-6: второй ход');
    const answered6 = await shown('ответ на ход-6');
    check('/chat: второй ход получил ответ', answered6, panelTrace.slice(-3).join(' | '));
    check(
      `/chat: второй ход — тем же шагом ядра, новой задачи нет (${tasks().length - before6.length})`,
      tasks().length === before6.length,
    );
    // Ход, доставленный ядром, лежит в транскрипте с шапкой доставки — в пузыре её нет.
    const feed = await page.locator('body').innerText();
    check(
      '/chat: в пузырях человека нет шапки доставки ядра',
      feed.includes('ход-6: второй ход') &&
        !/agentdeck:platform|agentdeck-from|human-origin/.test(feed),
    );
    await shoot(page, 'panel-chat-core-turns');

    // Слово «на ходу» (04.11): ход-9 занят заглушкой, ход-10 уходит посреди него (`steer`). Ядро
    // доставляет слово только на границе хода — новым ходом после хода-9. Прогон панели обязан
    // вести и этот ход: «Остановить» видна, пока он идёт, ответ течёт в ленту без F5. Прежде
    // прогон кончался на первом конце хода, и ход-10 шёл без ленты и без кнопки.
    const sends = [];
    const onSend = (req) => {
      if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
      const body = req.postDataJSON?.() ?? {};
      sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? '') });
    };
    page.on('request', onSend);
    const stopButton = page.getByRole('button', { name: 'Остановить' });
    const delivered = () => journalOf(taskId).filter((l) => l.kind === 'message.delivered').length;
    const before9 = tasks().length;
    const delivered9 = delivered();
    await say('ход-9: медленный ход');
    for (let i = 0; i < 60 && !panelTrace.some((t) => t.includes('ход-9')); i++) await wait(500);
    const busy9 = await stopButton
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    await say('ход-10: дописка на ходу, медленный ход');
    await wait(500);
    const steered = sends.find((s) => s.prompt.includes('ход-10'));
    check(
      '/chat: слово посреди хода ушло «на ходу» (steer), пока ход-9 шёл',
      busy9 && steered?.steer === true,
      JSON.stringify(sends),
    );
    const answered9 = await shown('ответ на ход-9', 60);
    let reached10 = false;
    for (let i = 0; i < 120 && !reached10; i++) {
      reached10 = panelTrace.some((t) => t.includes('ход-10'));
      if (!reached10) await wait(250);
    }
    // Ответ на ход-10 придержан на 8 с: через 2 с после запроса к модели ход ещё идёт.
    await wait(2000);
    const pending10 = (await page.getByText('ответ на ход-10').count()) === 0;
    const stopDuring10 = (await stopButton.count()) > 0;
    await shoot(page, 'panel-chat-core-steer');
    check(
      `/chat: ход по слову «на ходу» — тем же прогоном, «Остановить» видна (ход-9 ответил: ${answered9}, ход-10 у модели: ${reached10}, ответа ещё нет: ${pending10})`,
      answered9 && reached10 && pending10 && stopDuring10,
    );
    check(
      '/chat: ответ на слово «на ходу» течёт в ленту без перезагрузки',
      await shown('ответ на ход-10', 60),
    );
    let idle = false;
    for (let i = 0; i < 60 && !idle; i++) {
      idle = (await stopButton.count()) === 0;
      if (!idle) await wait(500);
    }
    check(
      `/chat: после ответа прогон кончился, задача та же, доставок ядра две (${delivered() - delivered9})`,
      idle && tasks().length === before9 && delivered() - delivered9 === 2,
    );
    page.off('request', onSend);

    // «Остановить»: задача ядра отменена, CLI сеанса снят.
    await say('ход-7: долгий ответ');
    const stop = page.getByRole('button', { name: 'Остановить' }).first();
    const stopShownAt = Date.now();
    const stoppable = await stop
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    // Запрос дошёл до модели — ход идёт по-настоящему, а не стоит в очереди.
    for (let i = 0; i < 60 && !panelTrace.some((t) => t.includes('ход-7')); i++) await wait(500);
    let clicked = false;
    let blockedBy = '';
    let clickError = '';
    if (stoppable) {
      clicked = await stop
        .click({ timeout: 15_000 })
        .then(() => true)
        .catch((error) => {
          // Хвост журнала Playwright называет причину: перекрыта, не стабильна, выключена, пропала.
          clickError = error.message
            .split('\n')
            .filter((l) => l.trim())
            .slice(-2)
            .join(' | ');
          return false;
        });
    }
    if (!clicked) {
      // Кнопки нет или нажатие не прошло (04.11, только под `tests-cli`): признаки уходят в подробность
      // проверки — строкой «~» до истории блока «Тесты» они не доезжали, а дом стенда убирается.
      await shoot(page, 'panel-chat-core-stop-blocked');
      const diag = join(tmpdir(), 'cc-core-chat-diag');
      mkdirSync(diag, { recursive: true });
      await page.screenshot({ path: join(diag, `stop-blocked-${Date.now()}.png`) }).catch(() => {});
      const facts = [
        `ход-7 у модели: ${panelTrace.some((t) => t.includes('ход-7'))}`,
        `ответ на экране: ${await page.getByText('ответ на долгий ход').count()}`,
        `кнопок «Остановить»: ${await page.getByRole('button', { name: 'Остановить' }).count()}`,
        `с отправки ${Math.round((Date.now() - stopShownAt) / 1000)} с`,
        `хвост ядра: ${journalOf(taskId)
          .slice(-5)
          .map((l) => l.kind)
          .join(',')}`,
        `модели последним: ${(panelTrace.at(-1) ?? '').slice(-160)}`,
      ].join('; ');
      blockedBy = ` · ${facts}${clickError ? ` · ${clickError}` : ''}`.replace(/\s+/g, ' ');
    }
    let cancelled = false;
    for (let i = 0; i < 60 && !cancelled; i++) {
      cancelled = journalOf(taskId).some(
        (l) =>
          (l.kind === 'task.transition' && l.data?.to === 'cancelled') ||
          (l.kind === 'task.ended' && l.data?.outcome === 'cancelled'),
      );
      if (!cancelled) await wait(500);
    }
    check(
      `/chat: «Остановить» снял задачу ядра (${journalOf(taskId)
        .slice(-3)
        .map((l) => l.kind)
        .join(', ')})`,
      stoppable && clicked && cancelled,
      `кнопка ${stoppable ? 'видна' : 'не видна'}, нажата: ${clicked}${blockedBy}`,
    );
    if (started?.cliPid) {
      let alive = true;
      for (let i = 0; i < 30 && alive; i++) {
        alive = processTable().has(started.cliPid);
        if (alive) await wait(1000);
      }
      check(`/chat: CLI сеанса ${started.cliPid} после остановки не жив`, !alive);
    }

    // Ход после остановки: новая задача, тот же транскрипт. Модель и глубина шапки (chat-005)
    // уезжают в ядро только стартом задачи (`set-model`) — их выбор стоит перед этим ходом.
    await pickModel({ page, check, wait });
    const before8 = tasks();
    await say('ход-8: после остановки');
    const fresh8 = await newTask(before8);
    const answered8 = await shown('ответ на ход-8');
    check(
      `/chat: ход после остановки — новая задача ядра (${fresh8.join(',') || 'нет'}) с ответом`,
      fresh8.length === 1 && answered8,
      panelTrace.slice(-3).join(' | '),
    );
    modelReached({ check, bodies: panelBodies, mark: 'ход-8' });
    check(
      '/chat: после остановки разговор продолжен в том же транскрипте',
      transcript().includes('ответ на ход-8') && transcript().includes('ответ на ход-4'),
    );

    // Правка вне корня проекта: у чата на месте грант — корень проекта, вне его ядро отказывает
    // само (`outside-copy`, пункта человека нет) — прежнего «спросить перед правкой» здесь нет.
    // Модель получает отказ результатом инструмента, ход кончается ответом, файла нет.
    const outside = join(dirname(repo), 'outside.txt');
    await say('ход-9: запиши вне проекта');
    const refusedShown = await shown('файл прочитан');
    const permitDecision = fresh8[0]
      ? journalOf(fresh8[0]).find(
          (l) =>
            l.kind === 'decision' &&
            l.data?.class === 'permit' &&
            JSON.stringify(l.data).includes('outside-copy'),
        )
      : undefined;
    check(
      '/chat: правка вне проекта — отказ ядра (outside-copy) дошёл до модели, ход кончился ответом',
      refusedShown && Boolean(permitDecision),
      fresh8[0] ? why(fresh8[0]) : '',
    );
    check(`/chat: файла вне проекта нет (${outside})`, !existsSync(outside));
    check(
      '/chat: карточки права на отказ без пункта человека нет',
      (await page.getByText('Агент просит разрешение').count()) === 0,
    );
    await shoot(page, 'panel-chat-core-outside-refused');
    // Основы чата (chat-001, chat-003, chat-009) — тем же живым шагом ядра.
    const { dismissAccess } = await import('./chat-walk.mjs');
    await basicsSteps({
      stand,
      page,
      input,
      check,
      wait,
      bodies: panelBodies,
      conv,
      taskId: fresh8[0],
      shoot,
      dismissAccess,
    });
    await page.close();
  }

  /** Прежняя дорога: `/chat` панели, CLI — ребёнок сервера панели. Только кадры и родословная. */
  async function before(stand, check, browser) {
    const page = await stand.newPage(browser);
    await page.goto(`${stand.webUrl}/chat`);
    const input = page.locator('textarea[data-chat-input]');
    await input.waitFor({ timeout: 90_000 });
    await shoot(page, 'chat-new');
    await input.fill('ход-1: привет');
    await input.press('Enter');
    // CLI прежнего чата — процесс с адресом заглушки в окружении не виден по команде; ищем
    // процессы claude, чья цепочка предков доходит до сервера панели стенда.
    let chain = [];
    let seen = [];
    for (let i = 0; i < 30 && chain.length === 0; i++) {
      const table = processTable();
      seen = [];
      for (const [pid, row] of table) {
        if (!/claude/i.test(row.command) || /powershell/i.test(row.command)) continue;
        const up = ancestry(pid, table);
        if (up.includes(stand.serverPid())) chain = up;
        seen.push(`${up.join('←')}: ${row.command.slice(0, 120)}`);
      }
      if (chain.length === 0) await wait(500);
    }
    if (chain.length === 0)
      console.log(`  ~ сервер ${stand.serverPid()}; claude-процессы:\n    ${seen.join('\n    ')}`);
    check(
      `до: CLI чата — потомок сервера панели (${chain.join(' ← ') || 'не найден'})`,
      chain.length > 0,
    );
    await wait(3000);
    await shoot(page, 'chat-sent');
  }

  /**
   * Засев маршрута и модели в миг `set-cli` экрана: задача уже есть, запуск ещё не отправлен; запрос
   * экрана уходит дальше без изменений. Маршрут заглушки разрешён ровно этому CLI.
   */
  async function seedOnSetCli(stand, page, cli) {
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
      const text = await res.text();
      return { status: res.status, text };
    };
    const proof = async () => {
      const id = uuidv7();
      const minted = JSON.parse((await direct('GET', `/v1/nonce?page=${id}`)).text);
      return { nonce: minted.nonce, page: id };
    };
    const seedCommand = async (taskId, kind, fields) =>
      direct('POST', '/v1/commands', {
        cmdId: uuidv7(),
        kind,
        target: { taskId },
        fields,
        proof: await proof(),
      });
    const seeded = [];
    await page.route(/\/api\/core\/commands$/, async (route) => {
      const body = route.request().postDataJSON();
      if (body?.kind === 'set-cli') {
        const taskId = body.target.taskId;
        const r = await seedCommand(taskId, 'set-route', {
          scope: 'task',
          scopeId: taskId,
          allowedRoutes: [
            { adapter: cli, route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
          ],
        });
        const m = await seedCommand(taskId, 'set-model', {
          scope: 'task',
          scopeId: taskId,
          model: 'stub-model',
          effort: null,
          timing: 'now',
        });
        seeded.push(`${r.status}/${m.status}`);
        if (r.status !== 200 || m.status !== 200) console.log(`  ~ засев: ${r.text} ${m.text}`);
      }
      await route.continue();
    });
    return seeded;
  }

  async function after(stand, check, browser, cli) {
    const journal = (taskId) => {
      const dir = join(stand.coreHome, 'tasks', taskId);
      const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
      return readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    };
    const until = async (what, probe, seconds) => {
      for (let i = 0; i < seconds; i++) {
        const got = await probe();
        if (got) return got;
        await wait(1000);
      }
      throw new Error(`не дождались: ${what}`);
    };

    const page = await stand.newPage(browser, { width: 1440, height: 1100 });
    const seeded = await seedOnSetCli(stand, page, cli);
    // Оценка и команды ядра с экрана — для разбора, если чат не начался.
    const coreCalls = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/core\/(estimate|commands)$/.test(r.url())) {
        coreCalls.push(r);
      }
    });

    if (cli === 'claude') {
      // Вход человека — «Новый чат» прежнего чата: он ведёт в чат ядра, а не в черновик панели.
      const { dismissAccess } = await import('./chat-walk.mjs');
      await page.goto(`${stand.webUrl}/chat`);
      await page.getByRole('button', { name: 'Новый чат' }).first().waitFor({ timeout: 90_000 });
      await dismissAccess(page);
      await page.getByRole('button', { name: 'Новый чат' }).first().click();
      const moved = await page
        .waitForURL(/\/core\/chat/, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check(`«Новый чат» в /chat открывает чат ядра (${new URL(page.url()).pathname})`, moved);
      // Отрицательный: без папки проекта форма называет поле и в ядро не уходит ничего.
      const estimates = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/api\/core\/estimate$/.test(r.url())) estimates.push(r);
      });
      await page.locator('[data-core-chat-start]').waitFor({ timeout: 90_000 });
      await page.locator('[data-core-chat-project] input').fill('');
      await page.locator('[data-core-chat-first] textarea').fill('ход-0: без папки');
      await page.locator('[data-core-chat-submit]').click();
      await page.waitForTimeout(1500);
      const named = await page.locator('[data-core-chat-project]').innerText();
      check(
        `без папки проекта: поле названо, оценка не отправлена (${estimates.length})`,
        estimates.length === 0 && named.includes('Укажите'),
        named,
      );
    }
    if (cli !== 'claude') await foreignEntry(stand, check, page, cli);
    await page.goto(`${stand.webUrl}/core/chat?project=${encodeURIComponent(repo)}`);
    await page.locator('[data-core-chat-start]').waitFor({ timeout: 90_000 });
    await page.locator('[data-core-chat-cli] select').selectOption(cli);
    await page.locator('[data-core-chat-first] textarea').fill('ход-1: привет, ядро');
    if (cli === 'claude') await shoot(page, 'core-chat-start');
    await page.locator('[data-core-chat-submit]').click();
    await page.waitForURL(/[?&]id=/, { timeout: 60_000 }).catch(async (error) => {
      const why = await page
        .locator('[data-core-chat-start-failed]')
        .innerText()
        .catch(() => '');
      // Ответ ядра на оценку и команды — причина, которую экран мог не показать.
      const answers = [];
      for (const r of coreCalls.slice(-6)) {
        const res = await r.response().catch(() => null);
        answers.push(
          `${r.url().split('/api/')[1]} → ${res?.status()} ${(await res?.text().catch(() => '')) ?? ''}`.slice(
            0,
            400,
          ),
        );
      }
      await shoot(page, `core-chat-start-failed-${cli}`);
      throw new Error(
        `${error.message}\n    отказ экрана: ${why}\n    ответы: ${answers.join('\n      ')}`,
      );
    });
    const taskId = new URL(page.url()).searchParams.get('id');
    check(
      `${cli}: новый чат — задача ядра ${taskId}, маршрут засеян (${seeded.join(',')})`,
      !!taskId,
    );

    const assistant = (text) =>
      page.locator('[data-core-chat-assistant]').filter({ hasText: text });
    const answered = async (text, seconds = 180) =>
      assistant(text)
        .first()
        .waitFor({ timeout: seconds * 1000 })
        .then(() => true)
        .catch(() => false);

    const first = await answered('ответ на ход-1');
    check(`${cli}: ответ на первый ход на экране`, first, traceTail());

    const started = journal(taskId).find((l) => l.kind === 'session.started')?.data;
    check(
      `${cli}: сеанс ядра этого CLI в корне проекта, без копии (cwd ${started?.cwd})`,
      started?.adapter === cli &&
        resolve(started.cwd).toLowerCase() === resolve(repo).toLowerCase(),
      JSON.stringify(started),
    );
    if (started?.cliPid) {
      const table = processTable();
      const chain = ancestry(started.cliPid, table);
      check(
        `${cli}: процесс CLI — потомок хоста сеансов ядра, не панели (${chain.join(' ← ')})`,
        chain.includes(started.hostPid) && !chain.includes(stand.serverPid()),
        `host ${started.hostPid}, panel ${stand.serverPid()}`,
      );
    } else check(`${cli}: номер процесса CLI в журнале`, false, JSON.stringify(started));

    const composer = page.locator('[data-core-chat-composer] textarea');
    const send = async (text) => {
      await composer.fill(text);
      await page.locator('[data-core-chat-send]').click();
    };
    await send('ход-2: покажи файл');
    const tool = page.locator('[data-core-chat-tool]').first();
    const toolSeen = await tool
      .waitFor({ timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    check(`${cli}: строка инструмента на экране`, toolSeen);
    const readBack = await answered(FILE_MARK);
    check(`${cli}: результат чтения файла вернулся в ответ модели`, readBack, traceTail());
    const toolState = toolSeen ? await tool.getAttribute('data-tool-state') : null;
    check(`${cli}: строка инструмента — «готово» (${toolState})`, toolState === 'done');
    // Человек видит свои слова: шапка платформы и метка человека в пузырь не попадают.
    const framed = (await page.locator('[data-core-chat-human]').allInnerTexts()).filter((t) =>
      /agentdeck:platform|agentdeck-from|human-origin/.test(t),
    );
    check(
      `${cli}: в пузырях человека нет служебной шапки`,
      framed.length === 0,
      framed.join(' | '),
    );
    await shoot(page, `core-chat-${cli}-tool`);

    // Жёсткий перезапуск панели: ни один ход не потерян и не повторён.
    const shownBefore = await page
      .locator('[data-core-chat-human], [data-core-chat-assistant]')
      .allInnerTexts();
    const { killedPid, pid } = await stand.restartHard();
    await page.reload();
    await page.locator('[data-core-chat-screen]').waitFor({ timeout: 90_000 });
    await until(
      'лента после перезапуска',
      async () =>
        (await page.locator('[data-core-chat-human], [data-core-chat-assistant]').count()) >=
        shownBefore.length,
      60,
    ).catch(() => null);
    const shownAfter = await page
      .locator('[data-core-chat-human], [data-core-chat-assistant]')
      .allInnerTexts();
    check(
      `${cli}: после перезапуска панели (${killedPid} → ${pid}) лента та же (${shownAfter.length} из ${shownBefore.length})`,
      JSON.stringify(shownAfter) === JSON.stringify(shownBefore),
      `до ${JSON.stringify(shownBefore)}\n    после ${JSON.stringify(shownAfter)}`,
    );
    await send('ход-3: после перезапуска');
    const third = await answered('ответ на ход-3');
    const humans = await page.locator('[data-core-chat-human]').allInnerTexts();
    const once = ['ход-1', 'ход-2', 'ход-3'].every(
      (h) => humans.filter((t) => t.includes(h)).length === 1,
    );
    check(`${cli}: ход после перезапуска получил ответ`, third);
    check(`${cli}: каждый ход человека в ленте ровно один раз`, once, JSON.stringify(humans));
    await shoot(page, `core-chat-${cli}-resumed`);

    await page.locator('[data-core-chat-end]').click();
    const closed = await page
      .locator('[data-core-chat-status="closed"]')
      .waitFor({ timeout: 120_000 })
      .then(() => true)
      .catch(() => false);
    const ended = journal(taskId).some((l) => l.kind === 'task.done' || l.kind === 'task.ended');
    check(
      `${cli}: «Закрыть» — чат закрыт, композера нет`,
      closed && (await page.locator('[data-core-chat-composer]').count()) === 0,
    );
    check(
      `${cli}: задача ядра кончилась (${journal(taskId).at(-1).kind})`,
      ended || closed,
      journal(taskId)
        .slice(-5)
        .map((l) => l.kind)
        .join(', '),
    );
    await shoot(page, `core-chat-${cli}-closed`);
    await page.close();
  }
}
