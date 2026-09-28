import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PanelActionPreviewField } from '@agentdeck/contracts/panel-agent';
import { maskSecretsInLine } from '../../domains/config-preview/unified-diff.ts';
import type { SandboxSelection } from '../../domains/sandbox/SandboxConfig.types.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
  type RouteAnswer,
} from './registry.ts';
import { card, encode, readRoute, routeError, textOf, textWindow } from './action-kit.ts';
import { dataField, textField } from './texts.ts';
import { assertClaude } from './actions-config.ts';

/**
 * Песочница (P3): проверка хука или скрипта на заготовленных событиях и вопрос
 * Claude с временной копией выбранных настроек — ровно то, что делает окно
 * «Песочница» у правила, скилла, хука, скрипта и группы.
 *
 * Окно само собирает песочницу при открытии и стирает при закрытии. У агента
 * окна нет, поэтому одно действие = весь цикл окна: собрать → прогнать →
 * стереть, всё маршрутами окна. Копия доступа к аккаунту не переживает
 * действие ни при каком исходе прогона (стирание — в `finally`).
 *
 * Вызов инструмента MCP-сервера из песочницы агенту НЕ дан: инструмент может
 * писать наружу (трекер, вики, чужой API), а какой из них пишет — по имени не
 * узнать (решение владельца D2 «всё, что пишет наружу, — человеку»). Список
 * инструментов сервера — у проверки MCP в разделе «MCP».
 */

/** Своя песочница на каждый вызов: чужую (окно человека) действие не тронет. */
const sandboxIds = new WeakMap<object, string>();

function sandboxIdFor(input: object): string {
  let id = sandboxIds.get(input);
  if (!id) {
    id = `agent-${Date.now()}-${randomBytes(4).toString('hex')}`;
    sandboxIds.set(input, id);
  }
  return id;
}

interface HookRow {
  id: string;
  event: string;
  matcher?: string;
  command: string;
  scriptPath?: string;
}

interface Fixture {
  id: string;
  event: string;
  title: string;
  description: string;
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

/** Ответ маршрута записи или исключение с его текстом. */
function answered(url: string, answer: RouteAnswer): unknown {
  if (answer.status >= 400) throw routeError(url, answer.status, answer.body);
  return answer.body;
}

/**
 * Стереть песочницу. Отказ стирания — в текст исхода: промолчать значило бы
 * оставить на диске копию доступа, называя прогон изолированным.
 */
async function dropSandbox(inject: InjectRoute, id: string): Promise<string | undefined> {
  try {
    const answer = await inject({ method: 'DELETE', url: `/api/sandbox/${encode(id)}` });
    return answer.status >= 400 ? textOf(answer.body) || `HTTP ${answer.status}` : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Отказ после сборки: песочница уже стёрта, текст говорит об этом. */
function afterCleanup(reason: string, leftover: string | undefined): Error {
  return new Error(
    `${reason}${leftover ? ` The temporary sandbox could not be removed: ${leftover}.` : ' The temporary sandbox was removed.'}`,
  );
}

const listSandboxFixtures = definePanelAction({
  name: 'list_sandbox_fixtures',
  section: 'hooks',
  risk: 'read',
  description:
    'Prepared hook events of the sandbox (id, event, title, whether a guard hook is expected to ' +
    'block it, payload). Pass ids to sandbox_probe_hook; none = all of them.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/sandbox/fixtures' }),
  shape: (_input, body) => ({
    fixtures: (Array.isArray(body) ? (body as Fixture[]) : []).map(
      ({ id, event, title, description, expectsBlock, payload }) => ({
        id,
        event,
        title,
        description,
        expectsBlock,
        payload,
      }),
    ),
  }),
  summary: 'journal-list-sandbox-fixtures',
});

const probeInput = z
  .object({
    hook: z.string().trim().min(1).optional().describe('Hook id from list_hooks'),
    script: z.string().trim().min(1).optional().describe('Script id from list_scripts'),
    fixtures: z
      .array(z.string().trim().min(1))
      .max(50)
      .optional()
      .describe('Fixture ids from list_sandbox_fixtures; omitted = all'),
    event: z
      .string()
      .trim()
      .min(2)
      .max(20_000)
      .optional()
      .describe('Own event instead of fixtures: a raw JSON object, as the hook receives it'),
  })
  .refine((input) => Boolean(input.hook) !== Boolean(input.script), {
    message: 'Name exactly one of hook or script',
  })
  .refine((input) => !(input.event && input.fixtures?.length), {
    message: 'Pass fixtures or event, not both',
  });
type ProbeInput = z.infer<typeof probeInput>;

/** Что будет прогнано: хук настроек (команда) или скрипт каталога hooks/. */
async function probeTarget(inject: InjectRoute, input: ProbeInput) {
  if (input.hook) {
    const hook = (await readRoute<HookRow[]>(inject, '/api/hooks')).find(
      (item) => item.id === input.hook,
    );
    if (!hook) throw new Error(`Hook «${input.hook}» not found. Call list_hooks.`);
    return {
      name: `${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`,
      command: maskSecretsInLine(hook.command),
      record: hook,
    };
  }
  const script = (await readRoute<Array<{ name: string }>>(inject, '/api/scripts')).find(
    (item) => item.name === input.script,
  );
  if (!script) throw new Error(`Script «${input.script}» not found. Call list_scripts.`);
  return { name: script.name, command: script.name, record: script };
}

/** Заготовки по id; неизвестный id — отказ до карточки. */
async function pickedFixtures(inject: InjectRoute, ids: string[] | undefined) {
  if (!ids?.length) return undefined;
  const known = await readRoute<Fixture[]>(inject, '/api/sandbox/fixtures');
  const unknown = ids.filter((id) => !known.some((fixture) => fixture.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture ids: ${unknown.join(', ')}. Call list_sandbox_fixtures.`);
  }
  return ids;
}

interface ProbeRow {
  fixtureId: string;
  exitCode: number;
  signal?: string;
  stdout: string;
  stderr: string;
  decision: string;
  reason?: string;
  addedContext?: string;
  matchesExpectation: boolean;
  durationMs: number;
  timedOut: boolean;
}

/** Вывод хука для модели: секреты под маской, длинный хвост срезан. */
const clip = (text: string | undefined, max = 2_000): string | undefined =>
  text ? maskSecretsInText(text.length > max ? `${text.slice(0, max)}…` : text) : undefined;

const sandboxProbeHook = definePanelAction({
  name: 'sandbox_probe_hook',
  section: 'hooks',
  risk: 'danger',
  title: 'journal-sandbox-probe-hook',
  description:
    'Run a hook (or a script from the hooks folder) in the sandbox on prepared events or on your ' +
    'own event JSON: no model involved, the COPY of the script runs in a temporary folder, the ' +
    'real config is not touched. Returns per event: decision block/ask/pass/error, reason, exit ' +
    'code, whether it matched the expectation. The command still runs on this machine — Needs confirmation.',
  input: probeInput,
  route: async (input, inject) => {
    await assertClaude(inject);
    return {
      method: 'POST',
      url: '/api/sandbox/create',
      body: {
        id: sandboxIdFor(input),
        selection: input.hook ? { hookIds: [input.hook] } : { scriptNames: [input.script] },
      },
    };
  },
  afterRoute: async (input, _body, inject) => {
    const id = sandboxIdFor(input);
    let result: { results?: ProbeRow[]; command?: string; error?: string };
    try {
      const fixtures = await pickedFixtures(inject, input.fixtures);
      result = answered(
        '/api/sandbox/probe-hook',
        await inject({
          method: 'POST',
          url: '/api/sandbox/probe-hook',
          body: {
            id,
            ...(input.hook ? { hookId: input.hook } : { scriptName: input.script }),
            ...(input.event !== undefined ? { customEvent: input.event } : {}),
            ...(fixtures ? { fixtureIds: fixtures } : {}),
          },
        }),
      ) as typeof result;
    } catch (error) {
      throw afterCleanup(
        `The probe did not run: ${error instanceof Error ? error.message : String(error)}.`,
        await dropSandbox(inject, id),
      );
    }
    const leftover = await dropSandbox(inject, id);
    if (result.error) throw afterCleanup(`The probe did not run: ${result.error}`, leftover);
    return { ...result, ...(leftover ? { cleanup: leftover } : {}) };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({
      target: (await probeTarget(inject, input)).record,
      fixtures: await pickedFixtures(inject, input.fixtures),
      event: input.event ?? null,
    }),
  preview: async (input, inject) => {
    const target = await probeTarget(inject, input);
    const fixtures = await pickedFixtures(inject, input.fixtures);
    const events: PanelActionPreviewField =
      input.event !== undefined
        ? dataField('label-sandbox-events', maskSecretsInText(input.event))
        : fixtures
          ? dataField('label-sandbox-events', fixtures.join(', '))
          : textField('label-sandbox-events', 'value-sandbox-events-all');
    return {
      ...card('summary-sandbox-probe-hook', { name: target.name }),
      fields: [
        dataField('label-command', target.command),
        events,
        textField('label-what-happens', 'value-sandbox-cleanup'),
      ],
    };
  },
  shape: (_input, body) => {
    const result = body as { results?: ProbeRow[]; command?: string; cleanup?: string };
    return {
      ...(result.command ? { command: maskSecretsInLine(result.command) } : {}),
      results: (result.results ?? []).map((row) => ({
        fixtureId: row.fixtureId,
        decision: row.decision,
        ...(row.reason ? { reason: clip(row.reason) } : {}),
        exitCode: row.exitCode,
        ...(row.signal ? { signal: row.signal } : {}),
        matchesExpectation: row.matchesExpectation,
        timedOut: row.timedOut,
        durationMs: row.durationMs,
        ...(row.stdout ? { stdout: clip(row.stdout) } : {}),
        ...(row.stderr ? { stderr: clip(row.stderr) } : {}),
        ...(row.addedContext ? { addedContext: clip(row.addedContext) } : {}),
      })),
      ...(result.cleanup ? { cleanupFailed: result.cleanup } : {}),
    };
  },
});

const idList = (what: string) =>
  z.array(z.string().trim().min(1)).max(50).optional().describe(what);

const askInput = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe('What to ask Claude inside the sandbox, in the human’s words'),
  rules: idList('Rule ids from list_rules to include'),
  skills: idList('Skill ids from list_skills to include'),
  hooks: idList('Hook ids from list_hooks to include'),
  mcp: idList('MCP server names from list_mcp to include'),
  scripts: idList('Script ids from list_scripts to include'),
  draftRule: z
    .object({
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(20_000),
    })
    .optional()
    .describe('A rule that is not saved anywhere yet — tried only inside the sandbox'),
});
type AskInput = z.infer<typeof askInput>;

/**
 * Состав песочницы по списку раздела: имя для карточки и id для маршрута.
 * Неизвестный id — отказ до карточки: окно такого не соберёт, и одобрять
 * пришлось бы состав, которого в прогоне не будет.
 */
async function resolveKind(
  inject: InjectRoute,
  ids: string[] | undefined,
  url: string,
  label: (row: Record<string, unknown>) => string,
  what: string,
  matches: (row: Record<string, unknown>, id: string) => boolean = (row, id) => row.id === id,
): Promise<Array<{ id: string; name: string }>> {
  if (!ids?.length) return [];
  const rows = await readRoute<Array<Record<string, unknown>>>(inject, url);
  return ids.map((id) => {
    const row = rows.find((item) => matches(item, id));
    if (!row) throw new Error(`${what} «${id}» not found. Call list_${what.toLowerCase()}s.`);
    return { id: String(row.id ?? row.name), name: label(row) };
  });
}

async function askPlan(inject: InjectRoute, input: AskInput) {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const rules = await resolveKind(
    inject,
    input.rules,
    '/api/rules',
    (row) => text(row.title),
    'Rule',
  );
  const skills = await resolveKind(
    inject,
    input.skills,
    '/api/skills',
    (row) => text(row.name),
    'Skill',
  );
  const hooks = await resolveKind(
    inject,
    input.hooks,
    '/api/hooks',
    (row) => `${text(row.event)}: ${maskSecretsInLine(text(row.command))}`,
    'Hook',
  );
  const mcp = await resolveKind(
    inject,
    input.mcp,
    '/api/mcp',
    (row) => text(row.name),
    'Mcp',
    (row, id) => row.id === id || row.name === id,
  );
  const scripts = await resolveKind(
    inject,
    input.scripts,
    '/api/scripts',
    (row) => text(row.name),
    'Script',
    (row, id) => row.name === id,
  );
  const selection: SandboxSelection = {
    ...(rules.length ? { ruleIds: rules.map((item) => item.id) } : {}),
    ...(skills.length ? { skillIds: skills.map((item) => item.id) } : {}),
    ...(hooks.length ? { hookIds: hooks.map((item) => item.id) } : {}),
    ...(mcp.length ? { mcpIds: mcp.map((item) => item.id) } : {}),
    ...(scripts.length ? { scriptNames: scripts.map((item) => item.name) } : {}),
    ...(input.draftRule ? { draftRule: input.draftRule } : {}),
  };
  return { selection, rules, skills, hooks, mcp, scripts };
}

/**
 * Сколько ждём ответа Claude в песочнице. Дольше — прогон останавливается тем
 * же маршрутом, что и кнопка «Стоп» окна: переходник ждёт вызов 10,5 мин, и
 * прогон без потолка съел бы весь ход агента панели.
 */
export const SANDBOX_ASK_BUDGET_MS = 5 * 60_000;

/** Кадры `data: {json}` из ответа потока, прочитанного целиком. */
function sseFrames(body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== 'string') return [];
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .flatMap((line) => {
      try {
        const frame = JSON.parse(line.slice(6)) as unknown;
        return frame && typeof frame === 'object' ? [frame as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

interface AskOutcome {
  answer: string;
  tools: string[];
  error?: string;
  costUsd?: number;
  stoppedAtBudget?: true;
  files: string[];
  contents?: unknown;
  cleanup?: string;
}

/** Подменяется только проверкой: ждать пять минут ради ветки остановки незачем. */
let askBudgetMs = SANDBOX_ASK_BUDGET_MS;
export function setSandboxAskBudgetForTests(ms: number): () => void {
  const previous = askBudgetMs;
  askBudgetMs = ms;
  return () => {
    askBudgetMs = previous;
  };
}

const sandboxAsk = definePanelAction({
  name: 'sandbox_ask',
  section: 'rules',
  risk: 'danger',
  title: 'journal-sandbox-ask',
  description:
    'Ask Claude a question inside the sandbox: Claude Code runs with a temporary config that holds ' +
    'ONLY the chosen rules/skills/hooks/MCP servers/scripts (or an unsaved draft rule), so you can ' +
    'see how they change its answer; nothing selected = Claude without them, for comparison. ' +
    'Spends the subscription limit; the copy is removed right after the answer. Returns the answer ' +
    'text, tools it used and files it created. Needs confirmation.',
  input: askInput,
  route: async (input, inject) => {
    await assertClaude(inject);
    return {
      method: 'POST',
      url: '/api/sandbox/create',
      body: { id: sandboxIdFor(input), selection: (await askPlan(inject, input)).selection },
    };
  },
  afterRoute: async (input, body, inject) => {
    const id = sandboxIdFor(input);
    const created = body as {
      description?: unknown;
      credentials?: { source?: string; reason?: string };
    };
    if (created.credentials?.source === 'none') {
      throw afterCleanup(
        `The sandbox has no access to the account, so Claude cannot answer there${created.credentials.reason ? ` (${created.credentials.reason})` : ''}.`,
        await dropSandbox(inject, id),
      );
    }
    let outcome: AskOutcome;
    try {
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        void inject({ method: 'POST', url: `/api/sandbox/${encode(id)}/stop` }).catch(() => {});
      }, askBudgetMs);
      let run: RouteAnswer;
      try {
        run = await inject({
          method: 'POST',
          url: '/api/sandbox/run',
          body: { id, prompt: input.question },
        });
      } finally {
        clearTimeout(timer);
      }
      const frames = sseFrames(answered('/api/sandbox/run', run));
      const error = frames.find((frame) => frame.kind === 'error');
      const done = frames.find((frame) => frame.kind === 'done');
      // Список файлов — дополнение к ответу: его сбой прогон не отменяет.
      const listed = await inject({
        method: 'GET',
        url: `/api/sandbox/${encode(id)}/files`,
      }).catch(() => undefined);
      const files =
        listed && listed.status < 400 && Array.isArray(listed.body)
          ? (listed.body as Array<{ name: string }>)
          : [];
      outcome = {
        answer: frames
          .filter((frame) => frame.kind === 'text')
          .map((frame) => String(frame.text ?? ''))
          .join(''),
        tools: frames.filter((frame) => frame.kind === 'tool').map((frame) => String(frame.name)),
        ...(error ? { error: String(error.message ?? 'the run failed') } : {}),
        ...(typeof done?.costUsd === 'number' ? { costUsd: done.costUsd } : {}),
        ...(stopped ? { stoppedAtBudget: true as const } : {}),
        files: files.map((file) => file.name),
        contents: created.description,
      };
    } catch (error) {
      throw afterCleanup(
        `The sandbox run did not happen: ${error instanceof Error ? error.message : String(error)}.`,
        await dropSandbox(inject, id),
      );
    }
    const leftover = await dropSandbox(inject, id);
    return { ...outcome, ...(leftover ? { cleanup: leftover } : {}) };
  },
  fingerprint: async (input, inject) => {
    const plan = await askPlan(inject, input);
    return fingerprintOf({ question: input.question, plan });
  },
  preview: async (input, inject) => {
    const plan = await askPlan(inject, input);
    const names = (items: Array<{ name: string }>) => items.map((item) => item.name).join('\n');
    const kinds: Array<[Parameters<typeof dataField>[0], Array<{ name: string }>]> = [
      ['label-sandbox-rules', plan.rules],
      ['label-sandbox-skills', plan.skills],
      ['label-sandbox-hooks', plan.hooks],
      ['label-sandbox-mcp', plan.mcp],
      ['label-sandbox-scripts', plan.scripts],
    ];
    const contents = kinds
      .filter(([, items]) => items.length > 0)
      .map(([label, items]) => dataField(label, names(items)));
    const draft = input.draftRule
      ? [
          dataField(
            'label-sandbox-draft-rule',
            maskSecretsInText(`${input.draftRule.title}\n\n${input.draftRule.text}`),
          ),
        ]
      : [];
    return {
      ...card('summary-sandbox-ask'),
      fields: [
        dataField('label-sandbox-question', maskSecretsInText(input.question)),
        ...(contents.length || draft.length
          ? [...contents, ...draft]
          : [textField('label-sandbox-rules', 'value-sandbox-empty')]),
        textField('label-what-happens', 'value-sandbox-ask-how'),
      ],
    };
  },
  shape: (_input, body) => {
    const outcome = body as AskOutcome;
    const window = textWindow(maskSecretsInText(outcome.answer));
    return {
      answer: window.text,
      ...(window.nextOffset !== undefined
        ? { answerTruncated: true, answerLength: window.length }
        : {}),
      tools: outcome.tools,
      files: outcome.files,
      ...(outcome.error ? { error: maskSecretsInText(outcome.error) } : {}),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.stoppedAtBudget
        ? {
            note: `Stopped after ${Math.round(askBudgetMs / 1000)} s: the answer may be incomplete.`,
          }
        : {}),
      ...(outcome.contents ? { contents: outcome.contents } : {}),
      ...(outcome.cleanup ? { cleanupFailed: outcome.cleanup } : {}),
    };
  },
});

/** Действия песочницы в порядке показа. */
export const SANDBOX_ACTIONS: readonly AnyPanelAction[] = [
  listSandboxFixtures,
  sandboxProbeHook,
  sandboxAsk,
];
