// Заглушка модели для живой проверки агента тестов на чужом CLI
// (`check-tests-agent-foreign.mjs`). По сценарию: каждый запрос берёт СЛЕДУЮЩИЙ
// шаг, а шаг строит функция проверки — она видит тела прошлых запросов (так шаг
// узнаёт id прогона из задания и текущее содержимое файла группы).
//
// Шаг: { tool: { name, args } } — вызов функции; { custom: { name, input } } —
// свободный инструмент responses (apply_patch у Codex); { text } — итоговый
// текст. Сценарий кончился — итог «DONE». Говорит двумя протоколами, оба потоком
// (SSE): OpenAI chat/completions (Qwen Code) и OpenAI responses (Codex). Каждое
// тело запроса сохраняется: по ним проверка судит, что дошло до модели (причина
// отказа, значение секрета), — рассуждения модели здесь доказательством не служат.
import { createServer } from 'node:http';

const USAGE_RESPONSES = {
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: 12,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};
const USAGE_CHAT = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

/**
 * `script(index, bodies)` → шаг для запроса номер `index` (с нуля); `bodies` —
 * сырые тела всех запросов, включая текущий. Может быть асинхронным: проверка
 * успевает сделать своё (например, уронить приёмник) до ответа модели.
 */
export function startScriptedModel(script) {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const url = req.url ?? '';
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      bodies.push(raw);
      let plan;
      try {
        plan = (await script(bodies.length - 1, bodies)) ?? { text: 'DONE' };
      } catch (error) {
        plan = { text: `STUB SCRIPT FAILED: ${error?.message ?? error}` };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) =>
        res.write(
          `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
        );
      const n = bodies.length;
      if (/\/responses/.test(url)) {
        const response = {
          id: `resp_${n}`,
          object: 'response',
          model: 'stub-model',
          status: 'in_progress',
          output: [],
        };
        send('response.created', { type: 'response.created', response });
        const item = plan.tool
          ? {
              type: 'function_call',
              id: `fc_${n}`,
              call_id: `call_${n}`,
              name: plan.tool.name,
              arguments: JSON.stringify(plan.tool.args),
              status: 'completed',
            }
          : plan.custom
            ? {
                type: 'custom_tool_call',
                id: `ctc_${n}`,
                call_id: `call_${n}`,
                name: plan.custom.name,
                input: plan.custom.input,
                status: 'completed',
              }
            : {
                type: 'message',
                id: `msg_${n}`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: plan.text, annotations: [] }],
              };
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item,
        });
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item,
        });
        send('response.completed', {
          type: 'response.completed',
          response: { ...response, status: 'completed', output: [item], usage: USAGE_RESPONSES },
        });
        res.end();
        return;
      }
      const head = {
        id: `c${n}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'stub-model',
      };
      if (plan.tool) {
        const call = {
          index: 0,
          id: `call_${n}`,
          type: 'function',
          function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) },
        };
        send('', {
          ...head,
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] } }],
        });
        send('', {
          ...head,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: USAGE_CHAT,
        });
      } else {
        send('', {
          ...head,
          choices: [{ index: 0, delta: { role: 'assistant', content: plan.text ?? 'DONE' } }],
        });
        send('', {
          ...head,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: USAGE_CHAT,
        });
      }
      send('', '[DONE]');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}`,
        bodies,
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      }),
    ),
  );
}
