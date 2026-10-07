/**
 * Заглушка модели OpenAI responses для агента панели на настоящем Codex
 * (`check-panel-agent-codex.mjs`). Сценарий хода — по метке в просьбе человека.
 *
 * Модель говорит с Codex так, как этого ждёт сам Codex: если инструмент
 * переходника предложен прямо (функция в пространстве `mcp__agentdeck_panel`) —
 * обычным вызовом функции; если модель в «режиме кода» (Codex 0.160 с моделью по
 * умолчанию: всё вложено в инструмент `exec`, инструменты MCP отложены и видны
 * только в `ALL_TOOLS`) — скриптом `exec`, который зовёт
 * `tools.mcp__agentdeck_panel__<действие>` и заодно выписывает `ALL_TOOLS`. Иначе
 * проверка требовала бы от Codex формы, которой он модели уже не даёт.
 *
 * Каждый запрос раскладывается в `requests`: ключ, все имена инструментов
 * (прямые, из `additional_tools`, вложенные в `exec`, и полный `ALL_TOOLS`, когда
 * скрипт его выписал), инструкции, просьба, выводы вызовов, картинки, рабочий
 * каталог из `environment_context`.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Пространство имён переходника у Codex: `agentdeck-panel` → идентификатор JS. */
export const BRIDGE_NS = 'mcp__agentdeck_panel';
export const isBridgeTool = (name) =>
  name.startsWith(`${BRIDGE_NS}__`) || name.startsWith('mcp__agentdeck-panel__');

/** Текст элемента входа: строка или части `input_text`/`output_text`. */
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : []).map((part) => part?.text ?? '').join('\n');

/** Имена инструментов: пространство `functions` — без префикса, прочие — `ns__имя`. */
function flatNames(tools) {
  return (tools ?? []).flatMap((tool) =>
    Array.isArray(tool.tools)
      ? tool.tools.map((inner) =>
          tool.name === 'functions' ? inner.name : `${tool.name}__${inner.name}`,
        )
      : [tool.name ?? tool.type],
  );
}

/** Вложенные в `exec` инструменты — заголовки `### \`имя\`` его описания. */
function nestedNames(tools) {
  const exec = (tools ?? [])
    .flatMap((tool) => (Array.isArray(tool.tools) ? tool.tools : [tool]))
    .find((tool) => tool.name === 'exec');
  return [...String(exec?.description ?? '').matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]);
}

function parseRequest(raw, auth) {
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    // не JSON — пустой сценарий
  }
  const input = Array.isArray(body.input) ? body.input : [];
  const extraTools = input
    .filter((item) => item.type === 'additional_tools')
    .flatMap((item) => item.tools ?? []);
  const outputs = input
    .filter(
      (item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output',
    )
    .map((item) => textOf(item.output));
  const allTools = outputs.flatMap((text) => {
    const found = /ALL_TOOLS:(\[[^\n]*\])/.exec(text);
    try {
      return found ? JSON.parse(found[1]) : [];
    } catch {
      return [];
    }
  });
  const userTexts = input
    .filter((item) => item.role === 'user')
    .map((item) => textOf(item.content));
  return {
    auth,
    direct: flatNames(body.tools),
    additional: flatNames(extraTools),
    nested: nestedNames([...(body.tools ?? []), ...extraTools]),
    allTools,
    instructions: [
      String(body.instructions ?? ''),
      ...input
        .filter((item) => item.role === 'developer' || item.role === 'system')
        .map((item) => textOf(item.content)),
    ].join('\n'),
    prompt: userTexts.at(-1) ?? '',
    cwd: /<cwd>([^<]+)<\/cwd>/.exec(userTexts.join('\n'))?.[1] ?? '',
    outputs,
    images: input.flatMap((item) =>
      (Array.isArray(item.content) ? item.content : []).filter(
        (part) => part.type === 'input_image',
      ),
    ),
  };
}

/** Все имена, что модель видела в этом запросе (без `ALL_TOOLS`). */
export const offeredNames = (entry) => [...entry.direct, ...entry.additional, ...entry.nested];

/**
 * @param marks `{ route, patchFile }` — метки сценариев проверки.
 */
export function createCodexAgentModel(marks) {
  const requests = [];
  const hanging = [];

  /** Вызов действия переходника: прямой функцией или скриптом `exec`. */
  function bridgeCall(entry, tool, args) {
    const names = [...entry.direct, ...entry.additional];
    if (names.includes(`${BRIDGE_NS}__${tool}`)) {
      return {
        type: 'function_call',
        name: tool,
        namespace: BRIDGE_NS,
        arguments: JSON.stringify(args),
      };
    }
    if (names.includes('exec')) {
      return {
        type: 'custom_tool_call',
        name: 'exec',
        input: [
          'text("ALL_TOOLS:" + JSON.stringify(ALL_TOOLS.map((t) => t.name)));',
          `const r = await tools.${BRIDGE_NS}__${tool}(${JSON.stringify(args)});`,
          'text("RESULT:" + JSON.stringify(r));',
        ].join('\n'),
      };
    }
    return undefined;
  }

  /** Попытка записать файл тем, что Codex даёт сверх переходника (`apply_patch`). */
  function patchCall(entry) {
    const patch = `*** Begin Patch\n*** Add File: ${marks.patchFile}\n+written by the agent\n*** End Patch\n`;
    const names = [...entry.direct, ...entry.additional];
    if (names.includes('exec')) {
      return {
        type: 'custom_tool_call',
        name: 'exec',
        input: `try { text("PATCH:" + JSON.stringify(await tools.apply_patch(${JSON.stringify(patch)}))); } catch (e) { text("PATCH_ERR:" + String(e)); }`,
      };
    }
    if (names.includes('apply_patch'))
      return { type: 'custom_tool_call', name: 'apply_patch', input: patch };
    return undefined;
  }

  /** Ответ на запрос: элемент вывода или особый исход (401, зависание). */
  function decide(entry) {
    const { outputs } = entry;
    // Метка сценария — только в просьбе этого хода: история разговора несёт метки прошлых.
    const prompt = entry.prompt.split('Human (current request): ').at(-1);
    const said = outputs.join('\n');
    const first = outputs.length === 0;
    if (prompt.includes('FAIL401')) return { status: 401 };
    if (prompt.includes('HANG')) return { hang: true };
    if (prompt.includes('WHERE')) {
      if (first)
        return { call: bridgeCall(entry, 'where_am_i', {}) ?? { text: 'NO_BRIDGE_ROUTE' } };
      return { text: `AGENT_OK ${said.includes(marks.route) ? 'ROUTE_SEEN' : 'ROUTE_MISSING'}` };
    }
    if (prompt.includes('MEMORY_FAIL')) {
      // Итог неудачного действия прошлого хода — с причиной, а не пустым хвостом.
      const note = /update_settings \(failed\):([^\n]*)/.exec(entry.prompt);
      return {
        text: /Input rejected/.test(note?.[1] ?? '')
          ? 'MEMORY_FAIL_SEEN'
          : `MEMORY_FAIL_MISSING [${note ? note[0] : 'no note'}]`,
      };
    }
    if (prompt.includes('MEMORY')) {
      return {
        text:
          entry.prompt.includes('Panel actions already done') &&
          entry.prompt.includes('where_am_i: ')
            ? 'MEMORY_SEEN'
            : 'MEMORY_MISSING',
      };
    }
    // Действие с карточкой, не зависящее от активного CLI: настройки самой панели
    // (действия раздела «Конфигурация» при Codex отказывают — они правят файлы Claude).
    if (prompt.includes('SET_OK') || prompt.includes('SET_NO')) {
      const accent = prompt.includes('SET_OK') ? 'purple' : 'amber';
      if (first)
        return {
          call: bridgeCall(entry, 'update_settings', { accent }) ?? { text: 'NO_BRIDGE_ROUTE' },
        };
      if (said.includes('REJECTED this action')) return { text: 'SET_REJECT_SEEN' };
      return { text: said.includes('Done.') ? 'SET_DONE' : `SET_UNCLEAR ${said.slice(0, 160)}` };
    }
    if (prompt.includes('INVALID')) {
      if (first)
        return {
          call: bridgeCall(entry, 'update_settings', { theme: 'neon' }) ?? {
            text: 'NO_BRIDGE_ROUTE',
          },
        };
      return {
        text: said.includes('Input rejected')
          ? 'INVALID_SEEN'
          : `INVALID_MISSING ${said.slice(0, 160)}`,
      };
    }
    if (prompt.includes('PATCH')) {
      if (first) return { call: patchCall(entry) ?? { text: 'NO_PATCH_ROUTE' } };
      const written = entry.cwd && existsSync(join(entry.cwd, marks.patchFile));
      return {
        text: written
          ? 'PATCH_WRITTEN'
          : /read-only sandbox|rejected/i.test(said)
            ? 'PATCH_BLOCKED'
            : `PATCH_UNCLEAR ${said.slice(0, 160)}`,
      };
    }
    if (prompt.includes('IMAGE'))
      return { text: entry.images.length > 0 ? 'IMAGE_SEEN' : 'IMAGE_MISSING' };
    return { text: 'UNKNOWN_SCENARIO' };
  }

  const handler = (req, res, raw) => {
    if (req.method !== 'POST' || !/\/responses$/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const entry = parseRequest(raw, String(req.headers.authorization ?? ''));
    requests.push(entry);
    if (process.env.DUMP_BODIES) {
      writeFileSync(join(process.env.DUMP_BODIES, `req-${requests.length}.json`), raw);
    }
    const plan = decide(entry);
    if (plan.status) {
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'stub: Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
      );
      return;
    }
    const n = requests.length;
    const resp = {
      id: `resp_${n}`,
      object: 'response',
      model: 'stub-model',
      status: 'in_progress',
      output: [],
    };
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send('response.created', { type: 'response.created', response: resp });
    if (plan.hang) {
      const hold = { closedAt: 0 };
      hanging.push(hold);
      res.on('close', () => (hold.closedAt = Date.now()));
      return;
    }
    const item = plan.call?.type
      ? {
          ...plan.call,
          id: `${plan.call.type === 'function_call' ? 'fc' : 'ctc'}_${n}`,
          call_id: `call_${n}`,
          status: 'completed',
        }
      : {
          type: 'message',
          id: `msg_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: plan.text ?? plan.call?.text ?? '', annotations: [] },
          ],
        };
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
    send('response.completed', {
      type: 'response.completed',
      response: {
        ...resp,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    res.end();
  };
  return { handler, requests, hanging };
}
