import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEnvironment, EnvScope } from '@agentdeck/contracts/portable-env';
import { agentEnvironment, envItemId, envSource, needsFacts, needsNone } from './canon.ts';

/**
 * ПРОБНАЯ СРЕДА приёмочной пробы (П2.4): шесть записей канона, по одной на слой,
 * и у каждой — условленное слово.
 *
 * Почему проба сажает СВОИ записи, а не меряет перенесённые. У записей человека
 * нет условленного слова: его скилл может отвечать чем угодно, его хук блокирует
 * то, чего проба не знает, а его право отказывает в том, что проба не вправе
 * трогать. Измерить «доехал ли механизм» можно только тем, чей правильный ответ
 * известен заранее.
 *
 * Записи при этом САМЫЕ ОБЫЧНЫЕ: тот же канон, тот же эмиттер, те же адаптеры
 * форматов. Проба не строит себе отдельной дороги — иначе она мерила бы дорогу,
 * а не ту, по которой поедет человек.
 *
 * Происхождение записей — НАСТОЯЩИЙ источник переноса, а не выдуманный
 * провайдер: от пары «источник → цель» зависят приговоры (общий каталог скиллов
 * у kimi и opencode — `target_shares_location`), и проба обязана мерить ту же
 * пару, о которой отчитывается матрица.
 */

/** Условленные слова. Длинные и бессмысленные намеренно: случайно такое не встретится. */
export const PROBE_MARKS = {
  /** Слово скилла: обязано доехать до модели в описании скилла. */
  skill: 'AGENTDECK-PROBE-SKILL-4f1c9a',
  /** Слово команды: обязано оказаться в развёрнутом запросе. */
  command: 'AGENTDECK-PROBE-COMMAND-9b2e07',
  /** Значение переменной окружения: обязано доехать до процесса инструмента. */
  env: 'AGENTDECK-PROBE-ENV-7d3315',
  /** Что печатает хук, останавливая запрещённый вызов. */
  hookBlocked: 'AGENTDECK-PROBE-HOOK-BLOCKED-2a0541',
  /** Кусок команды, который хук обязан остановить. */
  forbidden: 'AGENTDECK-PROBE-FORBIDDEN',
  /** Что напечатает запрещённый вызов, ЕСЛИ хук его не остановил. */
  forbiddenRan: 'AGENTDECK-PROBE-FORBIDDEN-RAN',
  /** Приставка вывода разрешённого вызова: за ней обязано стоять значение переменной. */
  envEcho: 'AGENTDECK-PROBE-ENV-SAYS=',
  /** Файл, читать который запрещает пробное право. */
  deniedFile: 'agentdeck-probe-denied.txt',
  /** Что лежит в том файле: появилось в ответе инструмента — право не сработало. */
  deniedContent: 'AGENTDECK-PROBE-DENIED-CONTENT-6e12b4',
  /** Имя инструмента пробного MCP-сервера: обязано оказаться в списке у модели. */
  mcpTool: 'agentdeck_probe_marker',
} as const;

/** Имя пробной переменной окружения. */
export const PROBE_ENV_NAME = 'AGENTDECK_PROBE_VALUE';

/** Общее имя пробных записей — по нему же строятся идентификаторы канона. */
const PROBE_NAME = 'agentdeck-probe';

/**
 * Имя пробной КОМАНДЫ — отдельное, и это не косметика.
 *
 * Живой прогон 20.09.2026 (claude 2.1.263) показал, что у цели скилл и команда
 * живут в ОДНОМ пространстве имён: на `/agentdeck-probe` CLI развернул скилл с
 * тем же именем, тело команды до модели не доехало вовсе, и строка «команда»
 * краснела при совершенно исправном переносе. Красный про имя пробы — это
 * красный про пробу, а она обязана говорить о переносе.
 */
const PROBE_COMMAND_NAME = 'agentdeck-probe-command';

/**
 * Скрипт хука. Node, а не оболочка: проба обязана работать одинаково на Windows
 * и POSIX, и `sh` на первой есть не всегда.
 *
 * Хук РАЗРЕШАЕТ всё, кроме одной условленной команды. Так одна запись канона
 * даёт две разные пробы: запрещённый вызов проверяет, что блокировка доехала, а
 * разрешённый — что переменная окружения дошла до процесса инструмента. Хук,
 * блокирующий всё подряд, второй пробе не оставил бы дороги.
 */
function hookScript(): string {
  return [
    '// Скрипт приёмочной пробы переноса (П2.4). Живёт во временном каталоге и',
    '// удаляется вместе с ним; ничего, кроме собственного вывода, не делает.',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  let payload = {};',
    '  try { payload = JSON.parse(input); } catch { payload = {}; }',
    "  const command = String(payload?.tool_input?.command ?? '');",
    `  if (command.includes(${JSON.stringify(PROBE_MARKS.forbidden)})) {`,
    `    process.stderr.write(${JSON.stringify(PROBE_MARKS.hookBlocked)});`,
    '    process.exit(2);',
    '  }',
    '  process.exit(0);',
    '});',
  ].join('\n');
}

/**
 * Пробный MCP-сервер: stdio, один инструмент, ничего не делает.
 *
 * Отвечает ровно на три метода протокола — `initialize`, `tools/list` и
 * `notifications/initialized`. Больше и не нужно: проба смотрит, попал ли
 * инструмент в список, который CLI отправляет модели, а вызывать его никто не
 * будет.
 */
function mcpScript(): string {
  return [
    '// MCP-сервер приёмочной пробы (П2.4): один инструмент, никакой работы.',
    "let buffer = '';",
    'function send(message) {',
    '  process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));',
    '}',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    '  let at = buffer.indexOf(String.fromCharCode(10));',
    '  while (at >= 0) {',
    '    const line = buffer.slice(0, at);',
    '    buffer = buffer.slice(at + 1);',
    '    at = buffer.indexOf(String.fromCharCode(10));',
    '    if (!line.trim()) continue;',
    '    let request;',
    '    try { request = JSON.parse(line); } catch { continue; }',
    '    if (request.id === undefined) continue;',
    "    if (request.method === 'initialize') {",
    '      send({',
    "        jsonrpc: '2.0',",
    '        id: request.id,',
    '        result: {',
    "          protocolVersion: '2024-11-05',",
    '          capabilities: { tools: {} },',
    `          serverInfo: { name: ${JSON.stringify(PROBE_NAME)}, version: '1.0.0' },`,
    '        },',
    '      });',
    "    } else if (request.method === 'tools/list') {",
    '      send({',
    "        jsonrpc: '2.0',",
    '        id: request.id,',
    '        result: {',
    '          tools: [{',
    `            name: ${JSON.stringify(PROBE_MARKS.mcpTool)},`,
    "            description: 'Метка приёмочной пробы переноса среды.',",
    "            inputSchema: { type: 'object', properties: {} },",
    '          }],',
    '        },',
    '      });',
    '    } else {',
    "      send({ jsonrpc: '2.0', id: request.id, result: {} });",
    '    }',
    '  }',
    '});',
  ].join('\n');
}

/** Пути вспомогательных файлов пробы — их создаёт `writeProbeScripts`. */
export interface ProbeScripts {
  readonly hookPath: string;
  readonly mcpPath: string;
  readonly skillDir: string;
  /**
   * Скрипт ЗАПРЕЩЁННОГО вызова. Условленное слово стоит в ИМЕНИ ФАЙЛА, потому
   * что хук судит по тексту команды — ровно так, как судит любой настоящий хук
   * (`tool_input.command`), и никакой особой дороги для пробы это не заводит.
   */
  readonly forbiddenPath: string;
  /**
   * Скрипт, печатающий значение пробной переменной окружения.
   *
   * Отдельный файл вместо `echo $ПЕРЕМЕННАЯ` — не из любви к файлам: `cmd.exe`
   * не разворачивает `$ИМЯ`, и на Windows проба показывала бы «переменная не
   * доехала» там, где она доехала. Оболочка у каждого CLI своя, а node один.
   */
  readonly envPath: string;
}

/**
 * Разложить вспомогательные файлы пробы по каталогу, который вызывающий удалит
 * целиком. Скрипты нужны настоящие: хук цель ЗАПУСКАЕТ, MCP-сервер цель
 * СПРАШИВАЕТ, и подделать это описанием нельзя.
 */
export function writeProbeScripts(scratchDir: string): ProbeScripts {
  const hookPath = join(scratchDir, 'probe-hook.mjs');
  const mcpPath = join(scratchDir, 'probe-mcp.mjs');
  const forbiddenPath = join(scratchDir, `${PROBE_MARKS.forbidden}.mjs`);
  const envPath = join(scratchDir, 'probe-env.mjs');
  const skillDir = join(scratchDir, 'skills', PROBE_NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(hookPath, hookScript(), 'utf8');
  writeFileSync(mcpPath, mcpScript(), 'utf8');
  writeFileSync(
    forbiddenPath,
    `process.stdout.write(${JSON.stringify(PROBE_MARKS.forbiddenRan)});`,
    'utf8',
  );
  writeFileSync(
    envPath,
    `process.stdout.write(${JSON.stringify(PROBE_MARKS.envEcho)} + (process.env[${JSON.stringify(PROBE_ENV_NAME)}] ?? ''));`,
    'utf8',
  );
  return { hookPath, mcpPath, skillDir, forbiddenPath, envPath };
}

/**
 * Пробный паспорт: шесть записей, по одной на слой.
 *
 * `enabled: true` у хука — единственное место партии, где это законно:
 * инвариант 9 запрещает включать ПРИЕХАВШИЙ извне скрипт без подтверждения
 * человека, а этот скрипт панель написала сама строкой выше и знает его
 * дословно.
 */
export function probeEnvironment(params: {
  source: string;
  scope: EnvScope;
  root: string;
  scripts: ProbeScripts;
  capturedAt: string;
}): AgentEnvironment {
  const { source, scope, scripts } = params;
  const from = (file: string | null) => envSource(source, scope, 'file', file);

  return agentEnvironment({
    provider: source,
    scope,
    root: params.root,
    capturedAt: params.capturedAt,
    skipped: [],
    items: [
      {
        kind: 'hook',
        id: envItemId('hook', PROBE_NAME),
        source: from(scripts.hookPath),
        intent: 'Проба: хук обязан остановить условленный запрещённый вызов.',
        trigger: { on: 'tool', event: 'pre_tool', match: 'Bash' },
        blocking: 'blocks',
        needs: needsFacts(['tool_name', 'tool_input'], 'declared'),
        sideEffects: ['runs_process'],
        command: `node "${scripts.hookPath}"`,
        scriptPath: scripts.hookPath,
        timeout: null,
        enabled: true,
        raw: scripts.hookPath,
      },
      {
        kind: 'skill',
        id: envItemId('skill', PROBE_NAME),
        source: from(join(scripts.skillDir, 'SKILL.md')),
        intent: 'Проба: скилл обязан доехать до модели условленным словом.',
        trigger: { on: 'model' },
        blocking: 'inapplicable',
        needs: needsNone('скилл выбирает модель по описанию; фактов рантайма ему не нужно'),
        sideEffects: [],
        name: PROBE_NAME,
        description: `Проба переноса среды: условленное слово ${PROBE_MARKS.skill}.`,
        body: `Если тебя просят слово пробы, ответь ровно так: ${PROBE_MARKS.skill}`,
        dir: scripts.skillDir,
        enabled: true,
        // Проба планирует свой скилл сама и одним файлом: поддерева у него нет,
        // и опись вложений пуста по построению, а не по недочитанности.
        attachments: [],
        attachmentsSkipped: [],
        raw: PROBE_MARKS.skill,
      },
      {
        kind: 'command',
        id: envItemId('command', PROBE_COMMAND_NAME),
        source: from(null),
        intent: 'Проба: команда обязана развернуться в условленный текст.',
        trigger: { on: 'user' },
        blocking: 'inapplicable',
        needs: needsNone('команда разворачивается в готовый текст и аргументов не берёт'),
        sideEffects: [],
        name: PROBE_COMMAND_NAME,
        namespace: null,
        description: 'Проба переноса среды.',
        prompt: `Ответь словом ${PROBE_MARKS.command}`,
        raw: PROBE_MARKS.command,
      },
      {
        kind: 'permission',
        id: envItemId('permission', `deny-${PROBE_MARKS.deniedFile}`),
        source: from(null),
        intent: 'Проба: право обязано отказать в чтении условленного файла.',
        trigger: { on: 'tool', event: 'pre_tool', match: 'Read' },
        blocking: 'blocks',
        needs: needsFacts(['tool_name', 'tool_input'], 'declared'),
        sideEffects: [],
        rule: `Read(${PROBE_MARKS.deniedFile})`,
        decision: 'deny',
        order: 0,
        enabled: true,
        raw: `Read(${PROBE_MARKS.deniedFile})`,
      },
      {
        kind: 'mcpServer',
        id: envItemId('mcpServer', PROBE_NAME),
        source: from(null),
        intent: 'Проба: инструмент MCP обязан оказаться в списке у модели.',
        trigger: { on: 'model' },
        blocking: 'inapplicable',
        needs: needsNone('сервер отвечает на запрос модели и фактов разговора не требует'),
        sideEffects: ['runs_process'],
        name: PROBE_NAME,
        transport: 'stdio',
        command: process.execPath,
        args: [scripts.mcpPath],
        url: null,
        envKeys: [],
        enabled: true,
        raw: scripts.mcpPath,
      },
      {
        kind: 'envVar',
        id: envItemId('envVar', PROBE_ENV_NAME),
        source: from(null),
        intent: 'Проба: переменная окружения обязана доехать до процесса инструмента.',
        trigger: { on: 'always' },
        blocking: 'inapplicable',
        needs: needsNone('переменная окружения действует постоянно и фактов разговора не требует'),
        sideEffects: [],
        name: PROBE_ENV_NAME,
        value: PROBE_MARKS.env,
        raw: `${PROBE_ENV_NAME}=${PROBE_MARKS.env}`,
      },
    ],
  });
}
