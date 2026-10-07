// Заглушка модели для проверки сообщения посреди ответа (`check-foreign-steer.mjs`):
// держит ход занятым, чтобы сообщение пришло ПОСРЕДИ него. Говорит тремя
// протоколами, все потоком (SSE): OpenAI chat/completions, OpenAI responses,
// Anthropic messages. Сценарий на запрос:
//   в теле есть MARKER          → итоговый текст «STEER_SEEN» (сообщение дошло до модели)
//   результата инструмента нет  → один вызов инструмента-оболочки (аргументы — по схеме)
//   иначе                       → держит holdMs, потом «NO_STEER»
// `GET /__state` → { requests, holding }: проверка знает, когда слать сообщение.
import { createServer } from 'node:http';

const IS_WIN = process.platform === 'win32';

// `toolLine` — своя строка для инструмента-оболочки (проверка прав пишет ею файл).
export function startStubModel({
  marker,
  holdMs = 9000,
  port = 0,
  slowTool = false,
  toolLine,
} = {}) {
  const requests = [];
  let holding = false;

  const pickTool = (tools) => {
    const named = tools.map((t) => ({
      name: t.name ?? t.function?.name,
      schema: t.parameters ?? t.input_schema ?? t.function?.parameters ?? {},
    }));
    return (
      named.find((t) =>
        /^(shell|bash|exec_command|run_shell_command|developer__shell|Bash|Shell)$/.test(
          t.name ?? '',
        ),
      ) ?? named.find((t) => /shell|bash|exec|command/i.test(t.name ?? ''))
    );
  };
  const argsFor = (schema) => {
    const props = schema?.properties ?? {};
    const required = schema?.required ?? Object.keys(props).slice(0, 1);
    const out = {};
    // Медленный инструмент — чтобы сообщение пришло, пока он идёт.
    const line =
      toolLine ?? (slowTool ? (IS_WIN ? 'ping -n 7 127.0.0.1' : 'sleep 6') : 'echo steer-probe');
    for (const key of required) {
      const type = props[key]?.type;
      if (type === 'array')
        out[key] = IS_WIN ? ['cmd', '/c', ...line.split(' ')] : ['sh', '-c', line];
      else if (type === 'number' || type === 'integer') out[key] = 10000;
      else if (type === 'boolean') out[key] = false;
      else out[key] = /desc/i.test(key) ? 'probe' : line;
    }
    return out;
  };
  const hasToolResult = (raw) =>
    /"role":"tool"|"type":"function_call_output"|"type":"tool_result"/.test(raw);

  const sse = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return (event, data) =>
      res.write(
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
      );
  };

  // ---- OpenAI chat/completions
  const chat = (res, plan, model) => {
    const send = sse(res);
    const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model };
    if (plan.tool) {
      send('', {
        ...head,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) },
                },
              ],
            },
          },
        ],
      });
      send('', { ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send('', {
        ...head,
        choices: [{ index: 0, delta: { role: 'assistant', content: plan.text } }],
      });
      send('', {
        ...head,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }
    send('', '[DONE]');
    res.end();
  };

  // ---- OpenAI responses
  const responses = (res, plan, model) => {
    const send = sse(res);
    const resp = { id: 'resp_1', object: 'response', model, status: 'in_progress', output: [] };
    send('response.created', { type: 'response.created', response: resp });
    let item;
    if (plan.tool) {
      item = {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: plan.tool.name,
        arguments: JSON.stringify(plan.tool.args),
        status: 'completed',
      };
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item,
      });
    } else {
      item = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: plan.text, annotations: [] }],
      };
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      });
      send('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: plan.text,
      });
    }
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
    send('response.completed', {
      type: 'response.completed',
      response: {
        ...resp,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    res.end();
  };

  // ---- Anthropic messages
  const anthropic = (res, plan, model) => {
    const send = sse(res);
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    if (plan.tool) {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: plan.tool.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.tool.args) },
      });
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: plan.text },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: plan.tool ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 2 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = req.url ?? '';
      if (url.startsWith('/__state')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requests, holding }));
        return;
      }
      if (req.method === 'GET' && /\/models/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }],
          }),
        );
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // не JSON — сценарий по пустому телу
      }
      const tools = body.tools ?? [];
      const seen = raw.includes(marker);
      const entry = {
        n: requests.length + 1,
        path: url,
        marker: seen,
        toolResult: hasToolResult(raw),
        tools: tools.map((t) => t.name ?? t.function?.name).slice(0, 40),
      };
      requests.push(entry);
      let plan;
      if (seen) plan = { text: 'STEER_SEEN' };
      else if (!entry.toolResult) {
        const tool = pickTool(tools);
        plan = tool ? { tool: { name: tool.name, args: argsFor(tool.schema) } } : { hold: true };
      } else plan = { hold: true };
      if (plan.hold) {
        holding = true;
        await new Promise((r) => setTimeout(r, holdMs));
        holding = false;
        plan = { text: 'NO_STEER' };
      }
      entry.reply = plan.tool ? `tool:${plan.tool.name}` : plan.text;
      const model = body.model ?? 'stub-model';
      if (/\/responses/.test(url)) responses(res, plan, model);
      else if (/\/messages/.test(url)) anthropic(res, plan, model);
      else chat(res, plan, model);
    });
  });
  return new Promise((done) =>
    server.listen(port, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        isHolding: () => holding,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}
