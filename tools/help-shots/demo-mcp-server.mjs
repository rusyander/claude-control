/**
 * Выдуманный MCP-сервер для кадров справки — настоящий, а не подменённый ответ.
 *
 * Раздел «MCP-серверы» про одно: подключается ли сервер и что он умеет. Кадр,
 * на котором «подключён: 5 инструментов» нарисован подменой ответа, доказывал бы
 * разметку карточки и ничего больше — а человек читает справку как раз затем,
 * чтобы понять, что значит эта плашка. Поэтому панель во время съёмки ведёт
 * НАСТОЯЩЕЕ рукопожатие MCP с этим процессом: её проба — официальный клиент SDK
 * (`domains/mcp-client.ts`), и обмануть его нечем, кроме как заговорив на
 * протоколе.
 *
 * Протокол здесь написан руками, без зависимости: `@modelcontextprotocol/sdk`
 * лежит в `apps/server/node_modules`, а этот файл живёт в `tools/` — Node ищет
 * пакеты от места файла, и импорт отсюда не разрешился бы. Нужного для проверки
 * связи ровно три сообщения (`initialize`, уведомление `initialized`,
 * `tools/list`), и все три — обычный JSON-RPC построчно поверх stdin/stdout.
 *
 * Версия протокола не назначается своя, а возвращается ТА, которую запросил
 * клиент: SDK отвергает рукопожатие с незнакомой версией, и жёсткая строка
 * здесь ломала бы съёмку при каждом обновлении пакета.
 *
 * Второй режим — `--unauthorized <порт>`: обычный HTTP-сервер, который на всё
 * отвечает 401. Он нужен кадру «требуется авторизация OAuth»: эту причину
 * панель выводит из настоящего отказа сетевого сервера, а не из настройки.
 *
 * Запуск (обычно его запускает не человек, а сама панель по записи в конфиге):
 *   node tools/help-shots/demo-mcp-server.mjs
 *   node tools/help-shots/demo-mcp-server.mjs --unauthorized 5195
 */
import { createServer } from 'node:http';

/**
 * Инструменты выдуманного сервера заказов. Описания попадают в окно «Инструменты»
 * и в кадр, поэтому написаны так, как их пишет нормальный сервер: одной фразой и
 * по делу. Имена — часть прав `mcp__orders__<инструмент>`, и по ним же в разделе
 * «Права» видно, что разрешено читать, а что запрещено выполнять.
 */
const TOOLS = [
  {
    name: 'list_orders',
    description: 'Список заказов за период: номер, дата, сумма и статус.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Начало периода, ГГГГ-ММ-ДД' },
        to: { type: 'string', description: 'Конец периода, ГГГГ-ММ-ДД' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'order_details',
    description: 'Карточка одного заказа: позиции, оплаты и доставка.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Номер заказа' } },
      required: ['id'],
    },
  },
  {
    name: 'export_orders',
    description: 'Выгрузка заказов в CSV: колонки те же, что в таблице.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'refund_order',
    description: 'Возврат по заказу. Необратимо: деньги уходят покупателю.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'sync_stock',
    description: 'Сверка остатков со складом и отчёт о расхождениях.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const unauthorizedAt = process.argv.indexOf('--unauthorized');
if (unauthorizedAt >= 0) {
  const port = Number(process.argv[unauthorizedAt + 1] ?? 5195);
  // Заголовок WWW-Authenticate — то, по чему клиент SDK понимает, что перед ним
  // сервер с OAuth, а не просто закрытая дверь.
  createServer((request, response) => {
    response.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="orders"',
    });
    response.end(JSON.stringify({ error: 'unauthorized' }));
  }).listen(port, '127.0.0.1');
} else {
  runStdio();
}

function runStdio() {
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    // Кадры разделяются переводом строки; последний кусок может быть неполным.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (text) handle(text);
    }
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Уведомление ответа не ждёт: `id` у него нет, и отвечать на него — ошибка
  // протокола, за которую SDK рвёт соединение.
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'orders', version: '1.2.0' },
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }

  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Метод ${String(message.method)} не поддерживается` },
  });
}
