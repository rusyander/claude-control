import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ЗАГЛУШКА ВМЕСТО МОДЕЛИ для приёмочной пробы (§9 плана, третий этаж доктрины).
 *
 * Проба обязана поднять НАСТОЯЩИЙ целевой CLI — иначе она мерит не его, — но
 * настоящую модель ей звать нечем и незачем: это чужие деньги, чужой трафик и
 * недетерминированный ответ там, где нужен известный заранее. Поэтому CLI
 * переводится на локальный адрес документированной переменной окружения
 * (`endpointConfig` каталога), а отвечает ему вот этот сервер — по сценарию.
 *
 * ОН ЖЕ И ЕСТЬ ГЛАВНАЯ ПОВЕРХНОСТЬ НАБЛЮДЕНИЯ. Всё, что CLI собрал из
 * перенесённых файлов, он присылает в запросе: системный промпт со скиллами,
 * список инструментов вместе с инструментами MCP-серверов, развёрнутый текст
 * слэш-команды. Проверять это чтением тех же файлов было бы проверкой файла
 * самим файлом; здесь же видно, что ДОЕХАЛО ДО МОДЕЛИ.
 *
 * Сервер слушает только петлю (`127.0.0.1`) и живёт ровно один прогон.
 */

/** Блок ответа заглушки. Больше двух видов сценарию пробы не нужно. */
export type StubBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

/**
 * Сценарий: что заглушка отвечает на N-й запрос. Номер начинается с нуля.
 * Сценарий кончился — заглушка отвечает пустым текстом и останавливает разговор:
 * бесконечный обмен подвесил бы прогон ровно там, где он обязан завершиться.
 */
export type StubScript = (turn: number, body: Record<string, unknown>) => readonly StubBlock[];

/** Поднятая заглушка: адрес, запись всего, что пришло, и остановка. */
export interface ProbeStub {
  /** Базовый адрес без хвостового слэша — он уходит в переменную окружения CLI. */
  readonly baseUrl: string;
  /** Тела всех запросов в порядке поступления — их и разбирает наблюдение. */
  readonly requests: readonly Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * Поднять заглушку на свободном порту петли.
 *
 * Порт выбирает ОС (`listen(0)`): фиксированный номер столкнулся бы с чужим
 * процессом ровно тогда, когда проба идёт не одна, и красный получился бы про
 * порт, а не про перенос.
 */
export async function startProbeStub(script: StubScript): Promise<ProbeStub> {
  const requests: Record<string, unknown>[] = [];

  const server: Server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      // Счёт токенов CLI спрашивает отдельным маршрутом и ответ на него в
      // разговор не входит: считать такой запрос ходом сценария значило бы
      // сдвинуть сценарий на шаг от одной лишь смены версии CLI.
      if (request.url?.includes('count_tokens')) {
        return sendJson(response, { input_tokens: 1 });
      }

      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }

      // ХОД РАЗГОВОРА — только запрос С РЕПЛИКАМИ. Всё остальное, чем CLI
      // трогает свой адрес модели, — проверка доступности (`HEAD /api/hello`),
      // опрос возможностей, телеметрия, — отвечается вежливо и в разговор НЕ
      // записывается.
      //
      // Живой прогон 20.09.2026 (claude 2.1.263) показал, чем стоит обратное:
      // `HEAD /api/hello` встал нулевым ходом, весь сценарий сдвинулся на шаг,
      // настоящая первая реплика получила ответ, заготовленный для второй, — и
      // отчёт показал четыре расхождения и ДВА ЗЕЛЁНЫХ. Зелёные и есть худшее:
      // хук и право признаются сработавшими по отсутствию условленного вывода,
      // а вывода не было потому, что вызовов не делали вовсе.
      //
      // Диалект узнаётся по ИМЕНИ поля с репликами, а не по маршруту: у клиента
      // Anthropic это `messages`, у ручки `/responses` — `input`. Маршрут для
      // этого не годится: CLI зовёт заглушку по адресу, который сам же и
      // составляет, и хвост у него свой.
      const dialect = Array.isArray(body.messages)
        ? 'anthropic'
        : Array.isArray(body.input)
          ? 'responses'
          : null;
      if (!dialect) {
        return sendJson(response, { ok: true });
      }

      const turn = requests.length;
      requests.push(body);
      const blocks = script(turn, body);
      const stopReason = blocks.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn';

      // Ручка `/responses` отвечает ТОЛЬКО потоком: цельного ответа её клиенты
      // не ждут, и `stream` в теле они не присылают вовсе.
      if (dialect === 'responses') sendResponsesStream(response, blocks);
      else if (body.stream === true) sendStream(response, blocks, stopReason);
      else sendJson(response, message(blocks, stopReason));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Ответ целиком — для CLI, который не просил потока. */
function message(blocks: readonly StubBlock[], stopReason: string): Record<string, unknown> {
  return {
    id: 'msg_agentdeck_probe',
    type: 'message',
    role: 'assistant',
    model: 'agentdeck-probe-stub',
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * Тот же ответ потоком событий.
 *
 * Поток здесь не роскошь: клиенты Anthropic просят его сами (`stream: true`), и
 * заглушка, умеющая только цельный ответ, повисла бы на первом же настоящем CLI
 * — то есть проба краснела бы про себя, а не про перенос.
 */
function sendStream(
  response: ServerResponse,
  blocks: readonly StubBlock[],
  stopReason: string,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: { ...message([], stopReason), content: [], stop_reason: null },
  });

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

/**
 * Тот же сценарий на ручке `/responses` — диалекте, на котором сегодня говорит
 * codex и всё, что построено на нём.
 *
 * Событий ровно три вида, и это не экономия: клиент ждёт открытия ответа,
 * готовых элементов вывода и закрытия. Промежуточные дельты текста ему не
 * нужны — заглушка знает свою реплику целиком, и «печатать по буквам» значило
 * бы усложнять то, что проба не измеряет.
 *
 * Вызов инструмента здесь — отдельный ВИД ЭЛЕМЕНТА (`function_call`), а не блок
 * внутри сообщения, и аргументы едут СТРОКОЙ: у этой ручки так, и заглушка,
 * пославшая объект, получила бы разбор чужого клиента вместо вызова.
 */
function sendResponsesStream(response: ServerResponse, blocks: readonly StubBlock[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const id = 'resp_agentdeck_probe';
  send('response.created', { type: 'response.created', response: { id } });

  for (const block of blocks) {
    const item =
      block.type === 'text'
        ? {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text }],
          }
        : {
            type: 'function_call',
            name: block.name,
            arguments: JSON.stringify(block.input),
            call_id: block.id,
          };
    send('response.output_item.done', { type: 'response.output_item.done', item });
  }

  send('response.completed', {
    type: 'response.completed',
    response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  });
  response.end();
}
