// Заглушка модели для проверки сессии CLI между ходами (`check-foreign-session.mjs`):
// отвечает сразу, без инструментов, тремя протоколами потоком (SSE) — OpenAI
// chat/completions, OpenAI responses, Anthropic messages. На каждый запрос
// записывает, есть ли секрет где-нибудь в теле (контекст CLI), и тексты всех
// реплик человека: проверка сама найдёт среди них реплику своего хода — CLI
// добавляют рядом свои (напоминания, подсказки, запрос заголовка).
import { createServer } from 'node:http';

/** Тексты реплик человека в теле запроса любого из трёх протоколов. */
function userTexts(body) {
  if (typeof body.input === 'string') return [body.input];
  const items = body.messages ?? (Array.isArray(body.input) ? body.input : []);
  return items
    .filter((item) => item?.role === 'user')
    .map(({ content }) =>
      Array.isArray(content)
        ? content.map((part) => part?.text ?? (typeof part === 'string' ? part : '')).join('\n')
        : String(content ?? ''),
    );
}

export function startSessionModel({ secret, port = 0 } = {}) {
  const requests = [];

  const sse = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return (event, data) =>
      res.write(
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
      );
  };

  const chat = (res, text, model) => {
    const send = sse(res);
    const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model };
    send('', { ...head, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] });
    send('', {
      ...head,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    send('', '[DONE]');
    res.end();
  };

  const responses = (res, text, model) => {
    const send = sse(res);
    const resp = { id: 'resp_1', object: 'response', model, status: 'in_progress', output: [] };
    const item = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    send('response.created', { type: 'response.created', response: resp });
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
      delta: text,
    });
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

  const anthropic = (res, text, model) => {
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
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
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
        // не JSON — разбираем пустое тело
      }
      const entry = {
        n: requests.length + 1,
        path: url,
        inBody: raw.includes(secret),
        users: userTexts(body),
      };
      requests.push(entry);
      // Ответ называет, видела ли модель секрет: проверка читает его в переписке.
      const text = entry.inBody ? `REPLY_${entry.n}_SEEN` : `REPLY_${entry.n}_BLIND`;
      const model = body.model ?? 'stub-model';
      if (/\/responses/.test(url)) responses(res, text, model);
      else if (/\/messages/.test(url)) anthropic(res, text, model);
      else chat(res, text, model);
    });
  });
  return new Promise((done) =>
    server.listen(port, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      }),
    ),
  );
}
