/**
 * Окно ассистента по каждому CLI (этап 10, F2b): служебный вопрос — сессия ядра «ask» без
 * инструментов, своего процесса CLI и прямого API вендора у панели нет.
 *
 * Что гоняется: одноразовая панель со своим ядром, НАСТОЯЩИЕ `claude` и `codex` из PATH, модель —
 * сценарий `packages/stub-model` в этом процессе (два профиля «Ассистент панели» на один адрес:
 * Anthropic и OpenAI-совместимый). Путь целиком настоящий: `POST /api/assistant/run` → вопрос ядра →
 * маршрут ядра `api-key:endpoint:<профиль>` → CLI → модель → ответ окну. Подменена только модель.
 *
 * Проверяется:
 *   - claude и codex отвечают словами модели, модель не видит ни одного инструмента окна;
 *   - Gemini, Cursor, Aider и Continue получают названный отказ панели до ядра
 *     (`assistant-provider-unsupported`): задача ядру не заводится, модель не вызвана.
 * Отказ ядра `tools-none-unsupported` из панели недостижим: каждый CLI вне списка отказа панели
 * объявляет `toolsNone` у своего переходника.
 *
 * Нет `claude` или `codex` в PATH — «не проверено» (код 2). Ничего не сохраняет вне стенда.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NotChecked, runOnStand } from './throwaway-stand.mjs';
import { cliDir } from './panel-agent-core-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const PROBE = 'QA-PROBE';
const KEY = 'stand-stub-key';
const PROFILES = { anthropic: 'stub-a', 'openai-compat': 'stub-o' };
const ANSWERING = [
  { cli: 'claude', profile: PROFILES.anthropic },
  { cli: 'codex', profile: PROFILES['openai-compat'] },
];
const REFUSED = ['gemini', 'cursor', 'aider', 'continue'];
/**
 * Инструменты, которые CLI добавляет сам, когда сеансу даны серверы MCP (сервер ядра есть у
 * каждого сеанса): это не встроенные инструменты и не инструменты окна. Claude прячет серверы
 * отложенной загрузкой (`ToolSearch`), Codex 0.155 добавляет три инструмента ресурсов MCP
 * (`.agent/provider-formats-core.agent.md` §Tools none). Любое другое имя — красный.
 */
const MCP_PLUMBING = {
  claude: ['ToolSearch', 'DeferredToolPlaceholder'],
  codex: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
};

/** Что дошло до модели вопросом окна (служебные запросы CLI — заголовок разговора — мимо). */
const probes = [];

function script(ctx) {
  const texts = (ctx.info.userTexts ?? []).join('\n');
  if (!texts.includes(PROBE)) return { text: 'stub side reply' };
  probes.push({ dialect: ctx.dialect, tools: (ctx.info.tools ?? []).map((t) => t.name) });
  return { text: `QA-ANSWER ${ctx.dialect}` };
}

/** Число задач в доме ядра стенда (`core-home/tasks/<taskId>`). */
const coreTasks = (stand) => {
  const dir = join(stand.coreHome, 'tasks');
  return existsSync(dir) ? readdirSync(dir).length : 0;
};

const dirs = ANSWERING.map(({ cli }) => cliDir(cli));
const model = await startStubModel({ script });
const profile = (id, apiKind) => ({
  id,
  name: id,
  baseUrl: apiKind === 'openai-compat' ? `${model.baseUrl}/v1` : model.baseUrl,
  apiKind,
  model: 'stub-model',
  writeToken: false,
  imagesUrl: '',
  ownerPlatformId: '',
});
const standEnv = {};

try {
  await runOnStand(
    {
      label: 'assistant-providers',
      core: true,
      web: true,
      env: standEnv,
      extraPath: dirs.filter(Boolean),
      seed: ({ cfg }) => {
        // Реестр маршрутов ядро строит при загрузке из state.json панели — каталог называется явно.
        standEnv.AGENTDECK_PANEL_DATA = join(cfg, 'agentdeck');
      },
      settings: {
        provider: 'claude',
        endpointProfiles: Object.entries(PROFILES).map(([apiKind, id]) => profile(id, apiKind)),
        assistantEndpointId: PROFILES.anthropic,
      },
    },
    async (stand, check) => {
      ANSWERING.forEach(({ cli }, i) => {
        if (!dirs[i]) throw new NotChecked(`${cli} нет в PATH`);
      });
      const human = { origin: stand.webUrl };
      for (const id of Object.values(PROFILES)) {
        const token = await stand.api(`/endpoints/${id}/token`, {
          method: 'PUT',
          headers: human,
          body: { token: KEY },
        });
        if (token.status !== 200) throw new Error(`ключ ${id}: HTTP ${token.status} ${token.text}`);
      }
      const choose = async (provider, assistantEndpointId) => {
        const res = await stand.api('/settings', {
          method: 'PATCH',
          headers: human,
          body: { provider, ...(assistantEndpointId ? { assistantEndpointId } : {}) },
        });
        if (res.status !== 200) throw new Error(`${provider}: HTTP ${res.status} ${res.text}`);
      };
      const ask = (cli) =>
        stand.api('/assistant/run', {
          method: 'POST',
          body: { messages: [{ role: 'user', content: `${PROBE} ${cli}: ответь одним словом` }] },
        });

      for (const { cli, profile: id } of ANSWERING) {
        await choose(cli, id);
        const before = probes.length;
        const tasksBefore = coreTasks(stand);
        const res = await ask(cli);
        const body = res.body ?? {};
        check(
          `${cli}: ход — задача ядра`,
          coreTasks(stand) > tasksBefore,
          `задач ядра ${tasksBefore} → ${coreTasks(stand)}`,
        );
        check(
          `${cli}: ассистент ответил словами модели через ядро`,
          res.status === 200 &&
            body.ok === true &&
            body.providerId === cli &&
            body.mode === 'cli' &&
            /QA-ANSWER/.test(body.reply ?? ''),
          `${res.status} ${JSON.stringify(body).slice(0, 400)}`,
        );
        const seen = probes.slice(before);
        const allowed = MCP_PLUMBING[cli] ?? [];
        check(
          `${cli}: вопрос дошёл до модели, инструментов окна у модели нет`,
          seen.length > 0 && seen.every((p) => p.tools.every((t) => allowed.includes(t))),
          JSON.stringify(seen).slice(0, 400),
        );
      }

      for (const cli of REFUSED) {
        await choose(cli);
        const before = probes.length;
        const tasksBefore = coreTasks(stand);
        const res = await ask(cli);
        const body = res.body ?? {};
        check(
          `${cli}: названный отказ панели до ядра`,
          res.status === 200 &&
            body.ok === false &&
            body.providerId === cli &&
            body.mode === 'none' &&
            body.reason === 'unsupported' &&
            typeof body.error === 'string' &&
            body.error.length > 0,
          `${res.status} ${JSON.stringify(body).slice(0, 400)}`,
        );
        const tasksAfter = coreTasks(stand);
        check(
          `${cli}: модель не вызвана, задача ядру не заведена`,
          probes.length === before && tasksAfter === tasksBefore,
          `вызовов модели ${probes.length - before}, задач ядра ${tasksBefore} → ${tasksAfter}`,
        );
      }
    },
  );
} finally {
  await model.close();
}
