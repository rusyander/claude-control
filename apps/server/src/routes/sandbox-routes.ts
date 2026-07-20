import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { platform } from 'node:process';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  createSandbox,
  removeSandbox,
  sandboxPaths,
  type SandboxSelection,
} from '../domains/sandbox/SandboxConfig.ts';
import {
  EVENT_FIXTURES,
  runHookProbe,
  scriptCommand,
  type ProbeResult,
} from '../domains/sandbox/HookProbe.ts';
import { listMcpTools, callMcpTool } from '../domains/sandbox/McpProbe.ts';
import { ChatRun, type ChatEvent } from '../domains/chat/ChatRunner.ts';
import { readClaudeCredentials } from '../lib/credentials.ts';
import { readHooks } from '../domains/hooks.ts';
import { readMcpServers } from '../domains/mcp.ts';
import { hasOAuthTokens, oauthProviderFor } from '../domains/mcp-oauth.ts';
import { readArtifacts } from '../domains/chat/ChatArtifacts.ts';

/**
 * Песочница: проверка отдельных настроек в изоляции.
 *
 * Три вида проверки, от дешёвой к дорогой. Хуки и скрипты запускаются напрямую
 * на заготовленном событии — мгновенно и без обращения к модели. MCP-сервер
 * поднимается и опрашивается по протоколу. Правила и скиллы иначе как
 * настоящим разговором не проверить, поэтому для них поднимается Claude Code
 * с временной конфигурацией, где есть только проверяемое.
 */
export function registerSandboxRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const running = new Map<string, ChatRun>();

  app.get('/api/sandbox/fixtures', () => EVENT_FIXTURES);

  /** Сборка песочницы: показываем состав до того, как что-либо запускать. */
  app.post<{ Body: { id: string; selection: SandboxSelection } }>(
    '/api/sandbox/create',
    (request) => {
      const sandbox = createSandbox(
        request.body.id,
        request.body.selection,
        ctx.location,
        ctx.store,
      );

      return {
        id: sandbox.id,
        configDir: sandbox.configDir,
        workDir: sandbox.workDir,
        description: sandbox.description,
        // Без доступа к аккаунту разговор в песочнице не пойдёт — пусть
        // интерфейс скажет об этом сразу, а не после неудачной попытки.
        credentials: sandbox.credentials,
      };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/sandbox/:id', (request) => {
    running.get(request.params.id)?.stop();
    running.delete(request.params.id);
    removeSandbox(request.params.id);
    return { ok: true };
  });

  /**
   * Прогон хука или скрипта на заготовках. Модель не участвует, поэтому
   * ответ приходит за доли секунды и ничего не стоит.
   */
  app.post<{
    Body: { id: string; hookId?: string; scriptName?: string; fixtureIds?: string[] };
  }>('/api/sandbox/probe-hook', async (request) => {
    const { id, hookId, scriptName, fixtureIds } = request.body;
    const { workDir, configDir } = sandboxPaths(id);

    let command = '';

    if (hookId) {
      const hook = readHooks(ctx.location.paths.settings, ctx.store).find(
        (item) => item.id === hookId,
      );
      command = hook?.command ?? '';

      // Запускаем копию скрипта из песочницы, а не оригинал: если хук что-то
      // пишет на диск, это должно остаться внутри песочницы.
      if (hook?.scriptPath) {
        const copy = join(configDir, 'hooks', hook.scriptPath.split(/[\\/]/).pop() ?? '');
        if (existsSync(copy)) command = command.split(hook.scriptPath).join(copy);
      }
    } else if (scriptName) {
      const copy = join(configDir, 'hooks', scriptName);
      const source = existsSync(copy) ? copy : join(ctx.location.paths.hooks, scriptName);
      command = scriptCommand(source);
    }

    if (!command) {
      // Отдельный случай: сам скрипт на месте, но запустить его нечем.
      // Молчаливое «команда не найдена» отправило бы искать несуществующую
      // проблему в пути к файлу.
      const needsPowerShell = scriptName?.toLowerCase().endsWith('.ps1') && platform !== 'win32';

      return {
        results: [],
        error: needsPowerShell
          ? 'Скрипты .ps1 запускаются через PowerShell — вне Windows нужен pwsh (PowerShell Core). Установите его или перепишите хук на .sh либо .mjs.'
          : 'Нечего запускать: команда не найдена',
      };
    }

    const fixtures = EVENT_FIXTURES.filter(
      (fixture) => !fixtureIds?.length || fixtureIds.includes(fixture.id),
    );

    const results: ProbeResult[] = [];
    for (const fixture of fixtures) {
      results.push(await runHookProbe(command, fixture, workDir));
    }

    return { results, command };
  });

  // Сетевой сервер с сохранёнными токенами опрашиваем через OAuth-провайдер —
  // так же, как проверка связи на странице MCP. Без этого стенд ходил в
  // OAuth-сервер без токена и всегда получал «требуется авторизация», хотя вход
  // уже был выполнен.
  const mcpAuthProvider = (server: ReturnType<typeof readMcpServers>[number]) =>
    server.transport !== 'stdio' && hasOAuthTokens(ctx.location.paths.appData, server.id)
      ? oauthProviderFor(server, ctx.location.paths.appData)
      : undefined;

  app.post<{ Body: { mcpId: string } }>('/api/sandbox/mcp-tools', async (request) => {
    const server = readMcpServers(ctx.location.paths.mcpConfig, ctx.store).find(
      (item) => item.id === request.body.mcpId,
    );
    if (!server) return { tools: [], error: 'Сервер не найден' };

    try {
      return { tools: await listMcpTools(server, undefined, mcpAuthProvider(server)) };
    } catch (error) {
      return { tools: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{ Body: { mcpId: string; tool: string; args?: Record<string, unknown> } }>(
    '/api/sandbox/mcp-call',
    async (request) => {
      const server = readMcpServers(ctx.location.paths.mcpConfig, ctx.store).find(
        (item) => item.id === request.body.mcpId,
      );
      if (!server) return { ok: false, content: 'Сервер не найден', isError: true, durationMs: 0 };

      return callMcpTool(
        server,
        request.body.tool,
        request.body.args ?? {},
        undefined,
        mcpAuthProvider(server),
      );
    },
  );

  /**
   * Разговор внутри песочницы. Отличие от обычного чата одно, но решающее:
   * Claude Code запускается с временным каталогом конфигурации, поэтому видит
   * только проверяемые настройки и ничего из настоящих.
   */
  app.post<{ Body: { id: string; prompt: string; sessionId?: string } }>(
    '/api/sandbox/run',
    async (request, reply) => {
      const { id, prompt, sessionId } = request.body;

      // Песочницу без выбранных элементов заводим на месте: она нужна для
      // сравнения «как отвечает Claude без этого правила».
      if (!existsSync(sandboxPaths(id).configDir)) {
        createSandbox(id, {}, ctx.location, ctx.store);
      }

      const { configDir, workDir } = sandboxPaths(id);
      // Доступ может быть не файлом, а ключом API: тогда он приходит
      // переменной окружения и в каталоге песочницы его нет.
      const { apiKey } = readClaudeCredentials(ctx.location.paths.root);
      const env = apiKey ? { ANTHROPIC_API_KEY: apiKey } : undefined;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const send = (event: ChatEvent): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const run = new ChatRun();
      running.set(id, run);

      reply.raw.on('close', () => {
        if (running.get(id) === run) {
          run.stop();
          running.delete(id);
        }
      });

      try {
        await run.start({ prompt, sessionId, cwd: workDir, configDir, env }, send);
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        running.delete(id);
        reply.raw.end();
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/sandbox/:id/stop', (request) => {
    const run = running.get(request.params.id);
    run?.stop();
    return { ok: Boolean(run) };
  });

  /** Файлы, созданные внутри песочницы: видно, что именно там натворили. */
  app.get<{ Params: { id: string } }>('/api/sandbox/:id/files', (request) =>
    readArtifacts(sandboxPaths(request.params.id).workDir),
  );
}
