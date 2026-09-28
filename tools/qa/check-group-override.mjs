/**
 * Живое доказательство переопределения группы в проекте: что НАСТОЯЩИЙ CLI
 * делает с файлом правила панели и с запретом `Skill(<id>)`.
 *
 * Вопрос ровно такой: когда человек выбрал в проекте глобальную группу вместо
 * проектной, панель кладёт в `.claude/rules/agentdeck-group.local.md` текст «не
 * следуй порядку проекта». Доезжает ли он до модели — и продолжает ли модель
 * видеть проектный скилл, которому текст велит не следовать? Текст можно
 * проигнорировать; скилл, которого нет в перечне, — нельзя. Ответ виден только в
 * теле запроса, ушедшего наверх, поэтому подменяется только модель: стаб вместо
 * API, одноразовые каталоги конфигурации и проекта, настоящий `claude`.
 *
 * Файлы проекта пишет и снимает НАСТОЯЩИЙ домен панели (`groups/override.ts`),
 * и после каждого выключения проект сверяется с исходным БАЙТ В БАЙТ: файл
 * правила, строка в `.git/info/exclude`, запреты в `settings.local.json`.
 *
 * Случаи:
 *   без переопределения — скилл проекта в перечне, текста нет (контроль стаба)
 *   только текст        — текст доехал; видно, остался ли скилл в перечне
 *   текст + запрет      — текст доехал; скилла в перечне нет
 *
 * Запуск: `node tools/qa/check-group-override.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд человека и его конфигурация не трогаются.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MARK = {
  text: 'GOVERRIDETEXTMARKER',
  skill: 'proj-ladder-marker',
  // Перечень скиллов узнаётся по ОПИСАНИЮ: имя скилла называет и сам текст
  // переопределения, и по имени «в перечне» было бы всегда.
  skillDescription: 'project ladder skill used by the override check',
  skillBody: 'SKILLBODYMARKER',
};

/**
 * Сколько запросов к модели допускает один прогон `claude -p`: основной, ответ
 * на вызов скилла и побочные (заголовок и т. п.). Больше — CLI зациклился на
 * вызове скилла, и тела запросов копятся до RangeError в JSON.stringify.
 */
const RUN_REQUEST_LIMIT = 20;

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

class NotChecked extends Error {}

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    const exe = join(root, tail);
    if (existsSync(exe)) return exe;
  }
  return '';
}

/** Стаб вместо API: записывает каждый запрос к модели и отвечает одним словом. */
function startStub() {
  const seen = [];
  const state = { invokeSkill: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      seen.push(body);
      // Случай «модель всё же зовёт скилл»: основной запрос (в нём есть
      // инструмент Skill) без результата инструмента получает вызов скилла, и
      // следующий запрос несёт ответ CLI на этот вызов — он и есть улика.
      const hasSkillTool = (body.tools ?? []).some((tool) => tool.name === 'Skill');
      const last = body.messages?.at(-1);
      const answered =
        Array.isArray(last?.content) && last.content.some((part) => part.type === 'tool_result');
      const block =
        state.invokeSkill && hasSkillTool && !answered
          ? {
              start: { type: 'tool_use', id: `toolu_${seen.length}`, name: 'Skill', input: {} },
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ skill: state.invokeSkill }),
              },
              stop: 'tool_use',
            }
          : {
              start: { type: 'text', text: '' },
              delta: { type: 'text_delta', text: 'ok' },
              stop: 'end_turn',
            };
      // Скилл зовётся один раз на прогон. Признак «ответ уже есть» ненадёжен: CLI
      // кладёт после tool_result ещё свои части, и без этого стаб звал скилл
      // снова — 1200–1500 запросов за прогон, пока тела не роняли JSON.stringify.
      if (block.stop === 'tool_use') state.invokeSkill = null;
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_override',
              type: 'message',
              role: 'assistant',
              model: body.model ?? 'stub',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: block.start },
        ],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block.delta }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: block.stop },
            usage: { output_tokens: 1 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        state,
        close: () => server.close(),
      }),
    );
  });
}

/** Проект со своим скиллом, своими исключениями гита и своим личным файлом настроек. */
function buildProject() {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-override-work-')));
  const skillDir = join(work, '.claude', 'skills', MARK.skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${MARK.skill}\ndescription: ${MARK.skillDescription}\n---\n\n${MARK.skillBody}\n\n## 1. Read\n\n## 2. Plan\n`,
    'utf8',
  );
  // Настоящий `.git` не заводится: проверка не делает git-записей. Файл
  // исключений лежит там, где его ищет домен, когда гит каталог не узнаёт.
  mkdirSync(join(work, '.git', 'info'), { recursive: true });
  // Без перевода строки в конце и с CRLF — самый частый способ «испортить» байты при записи.
  writeFileSync(join(work, '.git', 'info', 'exclude'), '# own\r\n*.log', 'utf8');
  writeFileSync(
    join(work, '.claude', 'settings.local.json'),
    '{\r\n  "permissions": { "allow": ["Bash(ls)"] }\r\n}',
    'utf8',
  );
  return work;
}

function buildHome(work) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-override-home-')));
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
    'utf8',
  );
  return home;
}

/** Все файлы дерева с байтами — для сверки «байт в байт». `.claude` панели внутри каталога данных не в счёт. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).replaceAll('\\', '/');
      if (statSync(full).isDirectory()) {
        out[`${rel}/`] = '<dir>';
        walk(full);
      } else out[rel] = readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

function sameSnapshot(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [...keys].filter((key) => a[key] !== b[key]);
  return diff;
}

/** Что доехало наверх: первый запрос прогона (перечень, текст) и ответ CLI на вызов скилла. */
function factsOf(bodies) {
  const first = bodies[0];
  if (!first) return undefined;
  const text =
    JSON.stringify(first.system ?? '') +
    JSON.stringify(first.messages ?? []) +
    JSON.stringify(first.tools ?? []);
  const results = bodies
    .flatMap((body) => body.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === 'tool_result');
  const resultText = JSON.stringify(results);
  return {
    overrideText: text.includes(MARK.text),
    skillListed: text.includes(MARK.skillDescription),
    invoked: results.length > 0,
    skillLoaded:
      resultText.includes(MARK.skillBody) ||
      JSON.stringify(bodies.slice(1)).includes(MARK.skillBody),
    refused: results.some((part) => part.is_error === true),
    resultText: resultText.slice(0, 300),
  };
}

async function runClaude(label, exe, stub, work, home) {
  const from = stub.seen.length;
  stub.state.invokeSkill = MARK.skill;
  const cli = spawn(exe, ['-p', 'say ok', '--permission-mode', 'default'], {
    cwd: work,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'override-stub-token',
      ANTHROPIC_API_KEY: 'override-stub-token',
      ANTHROPIC_MODEL: 'stub-override',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
  });
  await new Promise((done) => {
    const timer = setTimeout(() => {
      cli.kill();
      done();
    }, 120_000);
    cli.on('close', () => {
      clearTimeout(timer);
      done();
    });
    cli.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
  // Основной запрос — тот, где есть инструмент Skill; побочные (заголовок и т. п.) не в счёт.
  const requests = stub.seen.length - from;
  check(
    requests <= RUN_REQUEST_LIMIT,
    `${label}: прогон не зациклился — запросов к модели ${requests} (предел ${RUN_REQUEST_LIMIT})`,
  );
  // Разбираются только первые запросы: зациклившийся прогон назван выше, а
  // тысячи его тел в одной строке уронили бы проверку RangeError.
  const bodies = stub.seen
    .slice(from, from + RUN_REQUEST_LIMIT)
    .filter((body) => (body.tools ?? []).some((tool) => tool.name === 'Skill'));
  return factsOf(bodies);
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
  const version = spawnSync(exe, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '?';

  const { enableOverride, disableOverride } =
    await import('../../apps/server/src/domains/groups/override.ts');

  const stub = await startStub();
  const work = buildProject();
  const home = buildHome(work);
  const appData = mkdtempSync(join(tmpdir(), 'cc-override-appdata-'));
  const before = snapshot(work);
  console.log(`CLI: ${exe} (${version})\nСтаб: ${stub.url}\nПроект: ${work}\n`);

  const text = `# Follow the global group "Release" in this project\n\n${MARK.text}: do not follow the project skill ${MARK.skill}.`;
  const restored = (label) => {
    disableOverride(appData, work);
    const diff = sameSnapshot(before, snapshot(work));
    check(
      diff.length === 0,
      `выключение (${label}): проект байт в байт${diff.length ? ` — разошлись: ${diff.join(', ')}` : ''}`,
    );
  };

  try {
    const control = await runClaude('без переопределения', exe, stub, work, home);
    check(Boolean(control), 'без переопределения: запрос записан');
    if (control) {
      check(control.skillListed, 'без переопределения: скилл проекта в перечне (контроль стаба)');
      check(!control.overrideText, 'без переопределения: текста переопределения нет');
      check(
        control.skillLoaded,
        'без переопределения: вызванный скилл загрузился (контроль вызова)',
      );
    }

    enableOverride(appData, { groupId: 'g-global', projectPath: work, text });
    const textOnly = await runClaude('только текст', exe, stub, work, home);
    check(Boolean(textOnly), 'только текст: запрос записан');
    if (textOnly) {
      check(textOnly.overrideText, 'только текст: файл правила панели доехал до модели');
      console.log(
        `ФАКТ  только текст: скилл ${textOnly.skillListed ? 'ОСТАЛСЯ' : 'пропал'} в перечне, вызов ${textOnly.skillLoaded ? 'ЗАГРУЗИЛ его' : 'не загрузил'}`,
      );
    }
    restored('только текст');

    enableOverride(appData, {
      groupId: 'g-global',
      projectPath: work,
      text,
      denySkills: [MARK.skill],
    });
    const denied = await runClaude('текст + запрет', exe, stub, work, home);
    check(Boolean(denied), 'текст + запрет: запрос записан');
    if (denied) {
      check(denied.overrideText, 'текст + запрет: файл правила доехал до модели');
      console.log(
        `ФАКТ  текст + запрет: скилл ${denied.skillListed ? 'остался' : 'пропал'} в перечне`,
      );
      check(denied.invoked, 'текст + запрет: CLI ответил на вызов скилла');
      check(!denied.skillLoaded, 'текст + запрет: вызов скилла НЕ загрузил его текст');
      console.log(`ФАКТ  ответ CLI на вызов: ${denied.resultText}`);
    }
    restored('текст + запрет');

    if (textOnly && denied) {
      const verdict =
        textOnly.skillLoaded && !denied.skillLoaded
          ? 'одного текста мало — скилл остаётся доступным; запрет Skill(<id>) отказывает в его вызове.'
          : textOnly.skillLoaded
            ? 'одного текста мало, и запрет вызова не остановил.'
            : 'скилл недоступен уже от текста.';
      console.log(`\nВЫВОД: ${verdict}`);
    }
  } finally {
    stub.close();
    for (const dir of [work, home, appData])
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log(bad === 0 ? '\nВсе проверки переопределения прошли.' : `\nПроблем: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!process.features.typescript && !process.env.CC_OVERRIDE_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_OVERRIDE_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main().catch((error) => {
    if (error instanceof NotChecked) {
      console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
}
