/**
 * ПОДДЕЛЬНЫЙ CLI для проверки приёмочной пробы (П2.4).
 *
 * Ни одного чужого CLI, кроме `claude`, на этой машине нет (§9 плана), а проба
 * обязана уметь краснеть сегодня, а не когда-нибудь. Поэтому здесь живёт
 * читатель, который ДОБРОСОВЕСТНО исполняет ровно те механизмы, о которых
 * спрашивает проба, и ничего сверх них:
 *
 *  - находит скиллы в `<дом>/.claude/skills/*` и кладёт их в системный промпт;
 *  - разворачивает слэш-команду из `<дом>/.claude/commands/<имя>.md`;
 *  - поднимает каждый MCP-сервер из `<дом>/.claude.json` и спрашивает у него
 *    список инструментов;
 *  - перед каждым вызовом инструмента прогоняет хуки `PreToolUse` из
 *    `settings.json` (код возврата 2 = вызов остановлен) и правила `deny`;
 *  - исполняет разрешённое, подмешав в окружение блок `env` из `settings.json`.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Он не моделирует поведение настоящего Claude Code и не
 * заменяет живой прогон: доказывает он одно — что проба ВИДИТ разницу между
 * доехавшим механизмом и недоехавшим. Живая приёмка на настоящих CLI остаётся
 * отдельным пунктом (§11 плана).
 *
 * ПОРЧА. Аргумент `--poison <слой>` удаляет с диска ровно один
 * перенесённый слой ПЕРЕД чтением — это и есть «намеренно испорченный перенос»
 * из критериев приёмки. Дальше подделка работает честно, поэтому красным обязана
 * стать ровно одна строка отчёта.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME || '';
// Каталог настроек — по правилу настоящего CLI: заданный `CLAUDE_CONFIG_DIR`
// перебивает дом, и `.claude.json` при нём лежит ВНУТРИ каталога, а не рядом
// (`apps/server/src/lib/claude-paths.mcp-config.test.ts`, живая проверка
// 18.09.2026). Подделка, читающая по-своему, краснела бы про себя.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
const settingsPath = join(claudeDir, 'settings.json');
const configPath = process.env.CLAUDE_CONFIG_DIR
  ? join(claudeDir, '.claude.json')
  : join(home, '.claude.json');
const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
// Слой, который надо испортить, приезжает АРГУМЕНТОМ, а не переменной
// окружения: окружение чужого процесса проба собирает сама и ничего лишнего в
// него не пускает — и правильно делает.
const poisonAt = process.argv.indexOf('--poison');
const poison = poisonAt >= 0 ? (process.argv[poisonAt + 1] ?? '') : '';

/** Прочитать объект JSON; нет файла или он битый — пустой объект. */
function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Убрать ОДИН слой из перенесённого дома — настоящей правкой файлов, а не
 * пропуском при чтении: проба обязана краснеть от состояния диска.
 */
function poisonHome() {
  if (!poison) return;
  const settings = readJson(settingsPath);
  if (poison === 'hook') delete settings.hooks;
  if (poison === 'permission') delete settings.permissions;
  if (poison === 'envVar') delete settings.env;
  if (poison === 'hook' || poison === 'permission' || poison === 'envVar') {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return;
  }
  if (poison === 'skill') {
    rmSync(join(claudeDir, 'skills'), { recursive: true, force: true });
    return;
  }
  if (poison === 'command') {
    rmSync(join(claudeDir, 'commands'), { recursive: true, force: true });
    return;
  }
  if (poison === 'mcpServer') {
    const config = readJson(configPath);
    delete config.mcpServers;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }
}

/** Скиллы дома — телом целиком: их текст и есть то, что доезжает до модели. */
function readSkills() {
  const dir = join(claudeDir, 'skills');
  if (!existsSync(dir)) return [];
  const parts = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'SKILL.md');
    if (existsSync(file)) parts.push(readFileSync(file, 'utf8'));
  }
  return parts;
}

/** Развернуть слэш-команду в текст. Не команда — запрос идёт как есть. */
function expandPrompt(prompt) {
  if (!prompt.startsWith('/')) return prompt;
  const file = join(claudeDir, 'commands', `${prompt.slice(1)}.md`);
  if (!existsSync(file)) return prompt;
  const text = readFileSync(file, 'utf8');
  // Заголовочный блок — метаданные команды, в запрос уходит тело.
  return text.startsWith('---') ? text.slice(text.indexOf('\n---', 3) + 4).trim() : text.trim();
}

/** Спросить у stdio-сервера MCP список инструментов. Молчит — считаем, что их нет. */
function mcpTools(name, server) {
  return new Promise((done) => {
    if (!server || server.type === 'sdk' || !server.command) return done([]);
    const child = spawn(server.command, server.args ?? [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(server.env ?? {}) },
      windowsHide: true,
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      done([]);
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result?.tools) {
          clearTimeout(timer);
          child.kill();
          done(message.result.tools.map((tool) => ({ name: `mcp__${name}__${tool.name}` })));
          return;
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      done([]);
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe-fake', version: '1' } } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  });
}

/** Отказывает ли правило `deny` этому вызову. Грамматика — `Инструмент(довод)`. */
function deniedBy(settings, toolName, input) {
  const rules = settings.permissions?.deny ?? [];
  const argument = String(input.file_path ?? input.command ?? '');
  return rules.some((rule) => {
    const match = /^([A-Za-z_]+)\((.*)\)$/.exec(String(rule));
    if (!match) return String(rule) === toolName;
    return match[1] === toolName && argument.includes(match[2]);
  });
}

/** Прогнать хуки `PreToolUse`. Код 2 — вызов остановлен, и текст отказа его. */
async function runHooks(settings, toolName, input) {
  const groups = settings.hooks?.PreToolUse ?? [];
  for (const group of groups) {
    const matcher = group.matcher ?? '';
    if (matcher && matcher !== '*' && !new RegExp(`^(${matcher})$`).test(toolName)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command' || !hook.command) continue;
      const verdict = await new Promise((done) => {
        const child = spawn(hook.command, {
          shell: true,
          stdio: ['pipe', 'ignore', 'pipe'],
          env: { ...process.env, ...(settings.env ?? {}) },
          windowsHide: true,
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', () => done(null));
        child.on('close', (code) => done(code === 2 ? stderr : null));
        child.stdin.on('error', () => undefined);
        child.stdin.end(
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: toolName,
            tool_input: input,
          }),
        );
      });
      if (verdict !== null) return verdict || 'blocked by hook';
    }
  }
  return null;
}

/** Исполнить разрешённый вызов. Окружение — процесса плюс блок `env` настроек. */
function runTool(settings, toolName, input) {
  if (toolName === 'Read') {
    const path = resolve(process.cwd(), String(input.file_path ?? ''));
    try {
      return Promise.resolve(readFileSync(path, 'utf8'));
    } catch (error) {
      return Promise.resolve(`не прочитано: ${error.message}`);
    }
  }
  return new Promise((done) => {
    execFile(
      String(input.command ?? ''),
      {
        shell: true,
        env: { ...process.env, ...(settings.env ?? {}) },
        windowsHide: true,
        timeout: 15_000,
      },
      (error, stdout, stderr) => done(error ? `${stdout}${stderr}` : String(stdout)),
    );
  });
}

/** Один запрос к заглушке. */
async function ask(messages, system, tools) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'probe', max_tokens: 64, system, tools, messages }),
  });
  return await response.json();
}

async function main() {
  const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
  poisonHome();

  const settings = readJson(settingsPath);
  const config = readJson(configPath);
  const tools = [{ name: 'Bash' }, { name: 'Read' }];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    tools.push(...(await mcpTools(name, server)));
  }

  const system = ['Ты приёмочная проба.', ...readSkills()].join('\n\n');
  const messages = [{ role: 'user', content: expandPrompt(prompt) }];

  const first = await ask(messages, system, tools);
  const blocks = first.content ?? [];
  messages.push({ role: 'assistant', content: blocks });

  const results = [];
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    const input = block.input ?? {};
    const refusal =
      (await runHooks(settings, block.name, input)) ??
      (deniedBy(settings, block.name, input) ? 'permission denied by rule' : null);
    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      is_error: refusal !== null,
      content: refusal ?? (await runTool(settings, block.name, input)),
    });
  }

  if (results.length > 0) {
    messages.push({ role: 'user', content: results });
    await ask(messages, system, tools);
  }
  process.stdout.write(JSON.stringify({ ok: true }));
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error));
  process.exit(1);
});
