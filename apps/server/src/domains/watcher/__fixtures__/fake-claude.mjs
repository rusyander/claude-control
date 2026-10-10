// Фальшивый `claude -p --output-format json` для проверок наблюдателя.
// Без `--output-format` — чужой CLI одиночным запуском (X9): задание в argv
// после `-p`, ответ голым текстом. Читает промпт из stdin, пишет свой argv и промпт в `fake-argv.json` рабочего
// каталога, по `fake-config.json` там же спит, падает или отвечает находкой на
// каждый `id:` из промпта. Имена своего окружения — туда же: проверка того,
// что сервер ему НЕ передал. Сеть не трогает, токенов не тратит.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const config = existsSync('fake-config.json')
  ? JSON.parse(readFileSync('fake-config.json', 'utf8'))
  : {};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const foreign = !process.argv.includes('--output-format');
  if (foreign) prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
  // Системный промпт — текстом: временную папку разбор снимает сразу после конца.
  const at = process.argv.indexOf('--append-system-prompt-file');
  const systemPromptFile = at > 0 ? process.argv[at + 1] : undefined;
  // Через временный файл и переименование: тест ждёт ПОЯВЛЕНИЯ файла и сразу
  // его читает, а запись на месте под нагрузкой успевала показать пустой файл
  // («Unexpected end of JSON input»).
  writeFileSync(
    'fake-argv.json.tmp',
    JSON.stringify({
      argv: process.argv.slice(2),
      prompt,
      systemPrompt:
        systemPromptFile && existsSync(systemPromptFile)
          ? readFileSync(systemPromptFile, 'utf8')
          : '',
      pid: process.pid,
      envNames: Object.keys(process.env),
      // Адрес модели — значением: проверка маршрута контура смотрит, КУДА ушёл бы запрос.
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
    }),
  );
  renameSync('fake-argv.json.tmp', 'fake-argv.json');
  setTimeout(() => {
    if (config.fail) {
      process.stderr.write('fake failure');
      process.exit(3);
    }
    const ids = [...prompt.matchAll(/^id: ([0-9a-f]+)$/gm)].map((match) => match[1]);
    const findings = ids.map((id) => ({
      id,
      title: `Находка ${id}`,
      happened: config.happened ?? 'Маршрут упал.',
      context: 'Открыт раздел настроек.',
      verdict: config.verdict ?? 'confirmed',
      location: 'apps/server/src/index.ts:1',
      fix: 'Поймать ошибку.',
      // Второй и дальше id пачки — «та же причина, что первый», если так велено.
      ...(config.mergeIntoFirst && id !== ids[0] ? { sameAs: ids[0] } : {}),
    }));
    // Замечания — как есть из конфига: проверка решает, что модель «заметила».
    const items = [...findings, ...(config.remarks ?? []).map((r) => ({ kind: 'remark', ...r }))];
    const result = '```agentdeck-watch\n' + JSON.stringify(items) + '\n```';
    if (foreign) {
      process.stdout.write(result + '\n');
      return;
    }
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          'claude-haiku-4-5': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 50,
          },
        },
      }) + '\n',
    );
  }, config.sleepMs ?? 0);
});
