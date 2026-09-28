/**
 * Живой обход действий агента панели P3 (U5c) на одноразовом стенде: настоящий
 * сервер `apps/server/src/index.ts`, настоящая сборка маршрутов, настоящий
 * процесс хука и процесс «CLI». Модульные проверки рядом собирают Fastify сами;
 * здесь видно, что действия дошли до настоящей панели и работают её путём.
 *
 * Что подменено: `claude` и `code` — подделки первыми в PATH стенда (пишут, с
 * чем их запустили); контур — `tools/qa/stub-platform.mjs` на своём порту.
 * Решение человека — `/api/agent/pending/:id` с Origin окна стенда.
 *
 * Проверяется:
 * - все 13 действий в реестре настоящей панели с заявленным риском;
 * - sandbox_probe_hook: сторож блокирует `rm -rf`, пропускает безопасное;
 * - sandbox_ask: ответ подделки, каталог конфигурации — песочница, `--setting-sources user`,
 *   в прогоне только выбранное правило; после действия песочниц на диске нет;
 * - open_project_in_editor: редактор получил каталог проекта;
 * - ask_contour_agent / read / reset / contour_embeddings через активный контур-стаб;
 *   ключ контура в ответах агенту не встречается.
 *
 * Стенд человека (:5178/:8888, ~/.claude) не затрагивается. Выход 0/1, 2 — стенд не поднялся.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { startStubPlatform } from './stub-platform.mjs';

const HEADER = 'x-agentdeck-agent';
const KEY = `sk-walk-u5c-${'K'.repeat(24)}`;

const GUARD = `let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
const command = JSON.parse(raw || '{}').tool_input?.command ?? '';
if (/rm -rf|git push/.test(command)) {
  process.stderr.write('guard: blocked ' + command);
  process.exit(2);
}
process.exit(0);
`;

const FAKE_CLAUDE = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
const md = configDir && existsSync(join(configDir, 'CLAUDE.md'))
  ? readFileSync(join(configDir, 'CLAUDE.md'), 'utf8') : '';
appendFileSync(join(dirname(process.argv[1]), 'claude-launches.jsonl'), JSON.stringify({
  argv: process.argv.slice(2), configDir, cwd: process.cwd(), prompt, md,
}) + '\\n');
writeFileSync(join(process.cwd(), 'answer.txt'), '42');
const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'walk-1', model: 'fake', tools: [] });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ответ песочницы: 42.' } } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: 't1', input: {} }] } });
out({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 3, session_id: 'walk-1' });
`;

const FAKE_CODE = `import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
appendFileSync(join(dirname(process.argv[1]), 'code-launches.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
`;

const EXPECTED_RISK = {
  continue_chat_handoff: 'danger',
  restart_chat_session: 'danger',
  list_chat_artifacts: 'read',
  read_chat_artifact: 'read',
  delete_chat_artifact: 'danger',
  open_project_in_editor: 'change',
  list_sandbox_fixtures: 'read',
  sandbox_probe_hook: 'danger',
  sandbox_ask: 'danger',
  ask_contour_agent: 'danger',
  read_contour_agent_session: 'read',
  reset_contour_agent_session: 'danger',
  contour_embeddings: 'change',
};

const stub = await startStubPlatform({ port: 0 });
let projectDir = '';

try {
  await runOnStand(
    {
      web: true,
      label: 'agent-u5c',
      fakeCli: { claude: FAKE_CLAUDE, code: FAKE_CODE },
      seed: ({ root, cfg }) => {
        mkdirSync(join(cfg, 'hooks'), { recursive: true });
        writeFileSync(join(cfg, 'hooks', 'guard.mjs'), GUARD);
        writeFileSync(
          join(cfg, 'settings.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    { type: 'command', command: `node "${join(cfg, 'hooks', 'guard.mjs')}"` },
                  ],
                },
              ],
            },
          }),
        );
        writeFileSync(
          join(cfg, 'CLAUDE.md'),
          '# Правила\n\n## ПРАВИЛО: Краткость\n\nОтвечай в две строки.\n\n## ПРАВИЛО: Личное\n\nНЕ-В-ПЕСОЧНИЦУ\n',
        );
        writeFileSync(join(cfg, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake"}}');
        projectDir = join(root, 'work', 'shop');
        mkdirSync(projectDir, { recursive: true });
      },
    },
    async (stand, check) => {
      const origin = stand.webUrl;
      const sandboxes = join(stand.home, '.agentdeck', 'sandboxes');
      const leftovers = () => (existsSync(sandboxes) ? readdirSync(sandboxes) : []);
      const lines = (file) =>
        existsSync(join(stand.bin, file))
          ? readFileSync(join(stand.bin, file), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : [];

      const act = (name, input) =>
        stand.api(`/agent/actions/${name}`, {
          method: 'POST',
          headers: { [HEADER]: '1' },
          body: { input, conversationId: 'walk-u5c' },
        });
      /** Действие с карточкой: ждём её и решаем как человек в окне. */
      const decided = async (name, input, decision = 'approve') => {
        const answer = act(name, input);
        let card;
        for (let i = 0; i < 400 && !card; i += 1) {
          card = ((await stand.api('/agent/pending')).body ?? [])[0];
          if (!card) await wait(25);
        }
        if (!card) throw new Error(`карточка ${name} не появилась`);
        const decided = await stand.api(`/agent/pending/${card.id}`, {
          method: 'POST',
          headers: { origin },
          body: { decision },
        });
        if (decided.status !== 200) {
          throw new Error(`решение по ${name}: ${decided.status} ${decided.text}`);
        }
        return { card, result: (await answer).body };
      };

      // ── реестр настоящей панели ──
      const listed = (await stand.api('/agent/actions')).body?.actions ?? [];
      const risk = Object.fromEntries(listed.map((action) => [action.name, action.risk]));
      const wrong = Object.entries(EXPECTED_RISK).filter(([name, value]) => risk[name] !== value);
      check(
        '13 действий U5c в реестре с заявленным риском',
        wrong.length === 0,
        JSON.stringify(wrong),
      );

      // ── песочница: хук ──
      const fixtures = await act('list_sandbox_fixtures', {});
      check(
        'list_sandbox_fixtures отдаёт заготовки',
        fixtures.body?.outcome === 'done' && fixtures.body.result.fixtures.length > 0,
        fixtures.text.slice(0, 300),
      );
      const hookId = (await stand.api('/hooks')).body?.[0]?.id;
      const probe = await decided('sandbox_probe_hook', {
        hook: hookId,
        fixtures: ['bash-safe', 'bash-destructive'],
      });
      const decisions = Object.fromEntries(
        (probe.result?.result?.results ?? []).map((row) => [row.fixtureId, row.decision]),
      );
      check(
        'sandbox_probe_hook: rm -rf заблокирован, безопасное пропущено',
        decisions['bash-safe'] === 'pass' && decisions['bash-destructive'] === 'block',
        JSON.stringify(probe.result).slice(0, 400),
      );
      check(
        'после прогона хука песочниц на диске нет',
        leftovers().length === 0,
        leftovers().join(', '),
      );

      // ── песочница: вопрос Claude ──
      const ruleId = ((await stand.api('/rules')).body ?? []).find(
        (rule) => rule.title === 'Краткость',
      )?.id;
      const ask = await decided('sandbox_ask', { question: 'Сколько будет 6×7?', rules: [ruleId] });
      const answer = ask.result?.result ?? {};
      check(
        'sandbox_ask: ответ, инструмент и файл пришли агенту',
        ask.result?.outcome === 'done' &&
          answer.answer === 'Ответ песочницы: 42.' &&
          answer.tools?.includes('Write') &&
          answer.files?.includes('answer.txt'),
        JSON.stringify(ask.result).slice(0, 400),
      );
      const [launch] = lines('claude-launches.jsonl');
      const flag = launch?.argv.indexOf('--setting-sources') ?? -1;
      check(
        'CLI запущен с каталогом песочницы и --setting-sources user',
        Boolean(launch?.configDir.startsWith(sandboxes)) && launch?.argv[flag + 1] === 'user',
        JSON.stringify(launch).slice(0, 400),
      );
      check(
        'в прогоне только выбранное правило',
        Boolean(launch?.md.includes('Отвечай в две строки.')) &&
          !launch?.md.includes('НЕ-В-ПЕСОЧНИЦУ'),
        launch?.md,
      );
      check(
        'после вопроса песочниц на диске нет',
        leftovers().length === 0,
        leftovers().join(', '),
      );

      // ── редактор ──
      const project = await stand.api('/projects', {
        method: 'POST',
        headers: { origin },
        body: { name: 'Shop', path: projectDir },
      });
      const projectId = project.body?.id ?? projectDir;
      const editor = await decided('open_project_in_editor', {
        project: projectId,
        editor: 'code',
      });
      // Редактор запускается отвязанным процессом: ответ маршрута его не ждёт.
      for (
        let waited = 0;
        lines('code-launches.jsonl').length === 0 && waited < 10_000;
        waited += 100
      ) {
        await wait(100);
      }
      const codeArgs = lines('code-launches.jsonl').flat();
      check(
        'open_project_in_editor: редактор получил каталог проекта',
        editor.result?.outcome === 'done' && codeArgs.some((arg) => arg.includes('shop')),
        `${JSON.stringify(editor.result).slice(0, 300)} | ${JSON.stringify(codeArgs)}`,
      );

      // ── контур: человек заводит и включает ──
      const saved = await stand.api('/platforms/corp', {
        method: 'PUT',
        headers: { origin },
        body: {
          settings: {
            id: 'corp',
            title: 'Корпоративный',
            driver: 'enterprise-platform',
            baseUrl: `${stub.url}/v1`,
            enabled: true,
            mode: 'best-effort',
            budgetUsd: 0,
            budgetSince: '',
            capabilities: [],
            targets: [],
            projectPaths: [],
            agents: [{ id: 'agent-legal', title: 'Юрист' }],
            caCertPath: '',
          },
          token: KEY,
        },
      });
      const activated = await stand.api('/platforms/corp/activate', {
        method: 'POST',
        headers: { origin },
        body: '{}',
      });
      check(
        'контур-стаб заведён и активен',
        saved.status === 200 && activated.status === 200,
        activated.text.slice(0, 300),
      );

      const asked = await decided('ask_contour_agent', {
        contour: 'corp',
        agent: 'agent-legal',
        message: 'Проверь договор',
        session: 'walk-s1',
      });
      check(
        'ask_contour_agent: агент ответил через контур',
        asked.result?.outcome === 'done' && asked.result.result?.outcome === 'ok',
        JSON.stringify(asked.result).slice(0, 400),
      );
      const session = await act('read_contour_agent_session', {
        contour: 'corp',
        session: 'walk-s1',
      });
      check(
        'read_contour_agent_session: контур помнит разговор',
        session.body?.outcome === 'done' && session.body.result?.empty === false,
        session.text.slice(0, 400),
      );
      const reset = await decided('reset_contour_agent_session', {
        contour: 'corp',
        session: 'walk-s1',
      });
      const after = await act('read_contour_agent_session', {
        contour: 'corp',
        session: 'walk-s1',
      });
      check(
        'reset_contour_agent_session: после сброса сессия пуста',
        reset.result?.outcome === 'done' && after.body?.result?.empty === true,
        `${JSON.stringify(reset.result).slice(0, 200)} | ${after.text.slice(0, 200)}`,
      );
      const embedded = await decided('contour_embeddings', {
        contour: 'corp',
        model: 'embed-small',
        texts: ['первый', 'второй'],
      });
      check(
        'contour_embeddings: число и размер векторов, без самих чисел',
        embedded.result?.outcome === 'done' &&
          embedded.result.result?.vectors === 2 &&
          typeof embedded.result.result?.dimensions === 'number',
        JSON.stringify(embedded.result).slice(0, 300),
      );
      const everything = JSON.stringify([asked, session, reset, after, embedded]);
      check('ключ контура в ответах агенту не встречается', !everything.includes(KEY));
      check(
        'вызовы дошли до стаба с ключом',
        stub.calls.some((call) => call.path.endsWith('/agent/completions')) &&
          stub.calls.some((call) => call.path.endsWith('/embeddings')),
        JSON.stringify(stub.calls.map((call) => `${call.method} ${call.path}`)),
      );
    },
  );
} finally {
  await stub.close();
}
