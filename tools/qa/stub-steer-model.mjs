// Сценарий заглушки модели, держащий ход занятым (`check-persisted-output-hint.mjs`; прежде —
// сообщение посреди ответа чужого CLI, снято на этапе 10) поверх общей `packages/stub-model`: держит ход занятым, чтобы сообщение пришло ПОСРЕДИ
// него. Протокол (OpenAI chat/completions, OpenAI responses, Anthropic messages) и поток —
// дело пакета. Сценарий на запрос:
//   в теле есть MARKER          → итоговый текст «STEER_SEEN» (сообщение дошло до модели)
//   результата инструмента нет  → один вызов инструмента-оболочки (аргументы — по схеме)
//   иначе                       → держит holdMs, потом «NO_STEER»
// `isHolding()` — идёт ли удержание: проверка знает, когда слать сообщение.
import { startStubModel as startLibraryModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';

const pickTool = (tools) =>
  tools.find((t) =>
    /^(shell|bash|exec_command|run_shell_command|developer__shell|Bash|Shell)$/.test(t.name),
  ) ?? tools.find((t) => /shell|bash|exec|command/i.test(t.name));

// `toolLine` — своя строка для инструмента-оболочки (проверка прав пишет ею файл).
// `fileWrite` — абсолютный путь файла: при инструменте `write_file` модель пишет файл
// им, а не оболочкой. Режим одобрения `auto` у qwen 0.25 спрашивает про оболочку, а
// правку файла пропускает молча — проверка прав без этого его не видела.
export async function startStubModel({
  marker,
  holdMs = 9000,
  port = 0,
  slowTool = false,
  toolLine,
  fileWrite,
} = {}) {
  const requests = [];

  const argsFor = (schema) => {
    const props = schema?.properties ?? {};
    const required = schema?.required ?? Object.keys(props).slice(0, 1);
    const out = {};
    // Медленный инструмент — чтобы сообщение пришло, пока он идёт.
    // Функция — строка на каждый запрос: сценарии одного стенда зовут разные команды.
    const line =
      (typeof toolLine === 'function' ? toolLine() : toolLine) ??
      (slowTool ? (IS_WIN ? 'ping -n 7 127.0.0.1' : 'sleep 6') : 'echo steer-probe');
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

  const plan = ({ request, info }) => {
    const seen = request.raw.includes(marker);
    const entry = {
      n: requests.length + 1,
      path: request.path,
      marker: seen,
      toolResult: info.hasToolResult,
      tools: request.tools.slice(0, 40),
    };
    requests.push(entry);
    let step;
    if (seen) step = { text: 'STEER_SEEN' };
    // `fileWrite` вернул пусто — сценарию нужна оболочка, а не правка файла.
    else if (!entry.toolResult && fileWrite?.() && request.tools.includes('write_file'))
      step = { tool: { name: 'write_file', args: { file_path: fileWrite(), content: 'edited' } } };
    else if (!entry.toolResult) {
      const tool = pickTool(info.tools);
      if (tool) step = { tool: { name: tool.name, args: argsFor(tool.schema ?? {}) } };
    }
    step ??= { text: 'NO_STEER', holdMs };
    entry.reply = step.tool ? `tool:${step.tool.name}` : step.text;
    return step;
  };

  const stub = await startLibraryModel({ port, script: plan });
  return { port: stub.port, requests, isHolding: stub.holding, close: stub.close };
}
