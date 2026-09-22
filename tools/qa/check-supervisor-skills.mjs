#!/usr/bin/env node
/**
 * СКИЛЛЫ, КОМАНДЫ И СУБАГЕНТЫ ДЛЯ CLI БЕЗ СВОЕГО МЕХАНИЗМА (П3.4).
 *
 * Здесь проверяется ровно то, что нельзя проверить таблицей: КУДА физически
 * попадает текст, когда панель запускает чужой CLI. Доказательство — файл, в
 * который сам запущенный процесс сбросил свои argv и свой stdin. Собранные руками
 * ожидания доказывали бы таблицу, а вопрос ровно в том, чем именно поедет тело
 * скилла, если его не остановить.
 *
 * Запрет не выдуман: потолок командной строки около 32k, промпт и так режется на
 * 24k (`provider-chat/prompt.ts`), а тело скилла бывает длиннее обоих. Уехав
 * аргументом, оно обрубится МОЛЧА — CLI ответит на половину инструкции и не
 * скажет об этом.
 *
 * Подменяется здесь одна вещь — сам чужой CLI (`spawnImpl`): его на машине
 * проверки нет. Всё между входом и им работает настоящее: врезка скиллов,
 * сборка промпта, `oneShotArgs` провайдера из каталога, служба разговоров и её
 * файл переписки на диске.
 *
 * `--selftest` портит по одной вещи за раз и ждёт красного на каждой.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const SELFTEST = process.argv.includes('--selftest');

const RUN_TS = new URL(
  '../../apps/server/src/domains/provider-chat/ProviderChatRun.ts',
  import.meta.url,
).href;
const SERVICE_TS = new URL(
  '../../apps/server/src/domains/provider-chat/ProviderChatService.ts',
  import.meta.url,
).href;
const STORE_TS = new URL('../../apps/server/src/domains/provider-chat/store.ts', import.meta.url)
  .href;
const CATALOG_TS = new URL('../../apps/server/src/providers/catalog.ts', import.meta.url).href;

/**
 * Маркер внутри тела скилла. Ищется потом ВЕЗДЕ, где тела быть не должно, — и
 * длина тела взята заведомо больше и потолка argv, и предела промпта.
 */
const BODY_MARKER = 'ТЕЛО-СКИЛЛА-МАРКЕР-9F3A';
const BODY_TEXT = `${BODY_MARKER}\n${'наполнение тела скилла. '.repeat(3000)}`;

/** Описание скилла, отброшенного по приоритету: в каталог влезть не должно. */
const DROPPED_MARKER = 'ОТБРОШЕННЫЙ-СКИЛЛ-МАРКЕР-51C7';

/** Тело слэш-команды: человек пишет три слова, модели уезжает это. */
const COMMAND_MARKER = 'ТЕЛО-КОМАНДЫ-МАРКЕР-A24D';

/**
 * Поддельный CLI. Сбрасывает СВОИ argv и СВОЙ stdin — то есть то, что до него
 * действительно доехало, а не то, что панель собиралась отправить.
 */
const DUMPER = `
const fs = require('node:fs');
const out = { argv: process.argv.slice(3), stdin: '' };
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
const finish = () => {
  out.stdin = Buffer.concat(chunks).toString('utf8');
  fs.writeFileSync(process.argv[2], JSON.stringify(out), 'utf8');
  process.stdout.write('готово');
  process.exit(0);
};
process.stdin.on('end', finish);
// stdin могут и не закрыть: одноразовый запуск CLI им не пользуется вовсе.
setTimeout(finish, 300);
`;

/**
 * Водитель: зовёт НАСТОЯЩИЙ `ProviderChatRun` и НАСТОЯЩУЮ службу разговоров.
 *
 * `damage` — порча, которой пользуется только самопроверка:
 *  - `body-in-argv` кладёт тело скилла прямо в реплику, то есть ровно в тот
 *    канал, который здесь запрещён;
 *  - `no-expand` отключает разворачивание команды перед записью реплики.
 */
const DRIVER = `
import { readFileSync, writeFileSync } from 'node:fs';
import { ProviderChatRun } from ${JSON.stringify(RUN_TS)};
import { ProviderChatService } from ${JSON.stringify(SERVICE_TS)};
import { createChat, readChat } from ${JSON.stringify(STORE_TS)};
import { CATALOG_PROVIDERS } from ${JSON.stringify(CATALOG_TS)};
import { spawn as nodeSpawn } from 'node:child_process';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const provider = CATALOG_PROVIDERS.find((candidate) => candidate.id === job.providerId);
if (!provider) throw new Error('в каталоге нет цели ' + job.providerId);

const chat = createChat(job.appDataDir, job.providerId, { id: 'skills-1' });
if (!chat) throw new Error('разговор не заведён');

const service = new ProviderChatService(() => new ProviderChatRun());

const outcome = service.send(
  job.appDataDir,
  job.providerId,
  chat.id,
  { text: job.text },
  {
    provider,
    detect: () => true,
    // Подменён ТОЛЬКО чужой CLI: вместо него запускается сборщик, получающий те
    // же самые аргументы. Всё, что выше по дороге, — настоящее.
    spawnImpl: (command, args, options) =>
      nodeSpawn(process.execPath, [job.dumperPath, job.dumpPath, command, ...args], options),
    ...(job.damage === 'no-expand' ? {} : { commands: job.commands }),
    skills: {
      entries: job.entries,
      budgetChars: job.budgetChars,
      readBody: (name) => (name === job.bodySkill ? { text: job.bodyText, filePath: job.bodyPath } : undefined),
    },
  },
);
if (!outcome.ok) throw new Error('служба отказала: ' + outcome.reason);

await new Promise((resolve) => setTimeout(resolve, 3000));

// Переписка с диска — это ровно то, что видит человек в панели.
const stored = readChat(job.appDataDir, job.providerId, chat.id);
writeFileSync(
  process.argv[3],
  JSON.stringify({ messages: (stored?.messages ?? []).map((message) => message.content) }),
  'utf8',
);
`;

/**
 * Каталог с поддельным исполняемым файлом цели, который кладётся в начало PATH.
 *
 * Без него проверка зависела бы от того, что стоит на ЭТОЙ машине: найдя рядом
 * `codex.cmd`, панель законно отказывается запускать многострочный запрос через
 * `cmd.exe` (Windows обрезает команду на первом переводе строки), и до вопроса
 * «чем поехало тело скилла» дело не доходит вовсе. Этот отказ — отдельное,
 * уже записанное ограничение платформы, и подменять им предмет проверки нельзя.
 *
 * Файл — копия самого `node.exe`: запускать его никто не будет (`spawnImpl`
 * подменён), а искать настоящий исполняемый файл панель будет по-настоящему.
 */
function fakeCliDir(dir, command) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(
    process.execPath,
    join(binDir, `${command}${process.platform === 'win32' ? '.exe' : ''}`),
  );
  return binDir;
}

function runDriver(dir, driverPath, job, label) {
  const jobPath = join(dir, `job-${label}.json`);
  const outPath = join(dir, `chat-${label}.json`);
  writeFileSync(jobPath, JSON.stringify(job), 'utf8');
  const binDir = fakeCliDir(dir, job.cliCommand);

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', driverPath, jobPath, outPath],
      {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`водитель вышел с кодом ${code}: ${stderr.slice(-900)}`));
        return;
      }
      resolve(JSON.parse(readFileSync(outPath, 'utf8')));
    });
  });
}

/** Один прогон целиком: запуск, сброс процесса и переписка с диска. */
async function probe(dir, label, damage) {
  const problems = [];
  const dumperPath = join(dir, `dumper-${label}.cjs`);
  const dumpPath = join(dir, `dump-${label}.json`);
  const driverPath = join(dir, `driver-${label}.mts`);
  const appDataDir = join(dir, `appdata-${label}`);
  const bodyPath = join(dir, `skills-${label}`, 'deep-review', 'SKILL.md');
  writeFileSync(dumperPath, DUMPER, 'utf8');
  writeFileSync(driverPath, DRIVER, 'utf8');

  const entries = [
    { name: 'deep-review', description: 'глубокий разбор изменений', priority: 10 },
    { name: 'tiny-note', description: DROPPED_MARKER, priority: 1 },
  ];

  // Бюджет ровно под первую запись: вторая обязана быть отброшена по приоритету,
  // а не по месту в списке.
  const budgetChars = `- ${entries[0].name}: ${entries[0].description}`.length;

  const text =
    damage === 'body-in-argv'
      ? // Порча: тело кладётся прямо в реплику человека, то есть уезжает argv.
        `/разбор ${BODY_TEXT}`
      : '/разбор посмотри на deep-review внимательно';

  let chat;
  try {
    chat = await runDriver(
      dir,
      driverPath,
      {
        providerId: 'codex',
        // Голое имя: на Windows панель ищет `codex.exe` рядом с обёрткой
        // `codex.cmd`, то есть по этому имени с расширением.
        cliCommand: 'codex',
        appDataDir,
        dumperPath,
        dumpPath,
        text,
        entries,
        budgetChars,
        bodySkill: 'deep-review',
        bodyText: BODY_TEXT,
        bodyPath,
        commands: [{ name: 'разбор', body: `${COMMAND_MARKER} разбери изменения` }],
        damage: damage ?? '',
      },
      label,
    );
  } catch (error) {
    problems.push(`прогон не состоялся: ${error.message}`);
    return problems;
  }

  let dump;
  try {
    dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  } catch (error) {
    // Переписка здесь — единственный свидетель: если процесс не поднялся, в ней
    // лежит причина, и молчать о ней значило бы прятать настоящую поломку.
    problems.push(
      `запущенный процесс не оставил сброса: ${error.message}; переписка: ${JSON.stringify(chat.messages ?? []).slice(0, 600)}`,
    );
    return problems;
  }

  const argv = dump.argv ?? [];
  const argvText = argv.join('\n');

  // ГЛАВНЫЙ ЗАПРЕТ: тела скилла нет ни в одном аргументе и нет в stdin.
  if (argvText.includes(BODY_MARKER)) {
    problems.push(`тело скилла уехало аргументом (${argvText.length} символов в argv)`);
  }
  if ((dump.stdin ?? '').includes(BODY_MARKER)) {
    problems.push('тело скилла уехало через stdin, а договорено файлом');
  }

  // Путь до файла, наоборот, доехать ОБЯЗАН: иначе цели нечего читать, и
  // «тела нет в argv» стало бы правдой просто потому, что скилл не приехал вовсе.
  if (!argvText.includes('deep-review')) {
    problems.push('имя скилла не доехало до цели вовсе — читать ей нечего');
  }
  if (!argvText.includes(bodyPath)) {
    problems.push('путь до файла скилла не доехал: цель не сможет прочитать тело');
  }

  // Бюджет каталога: отброшенная по приоритету запись до цели не доезжает.
  if (argvText.includes(DROPPED_MARKER)) {
    problems.push('отброшенный по приоритету скилл всё-таки уехал в каталоге');
  }

  // Потолок argv: суммарная длина командной строки остаётся в безопасном пределе.
  const argvChars = argv.reduce((sum, item) => sum + item.length, 0);
  if (argvChars > 32_000) {
    problems.push(`командная строка выросла до ${argvChars} символов — это за потолком argv`);
  }

  // Развёрнутая команда видна в переписке И совпадает с тем, что уехало модели.
  const messages = chat.messages ?? [];
  const seenByHuman = messages.some((message) => message.includes(COMMAND_MARKER));
  if (!seenByHuman) {
    problems.push('развёрнутая команда не попала в переписку — человек не видит, что ушло модели');
  }
  if (!argvText.includes(COMMAND_MARKER)) {
    problems.push('развёрнутая команда не доехала до цели');
  }

  return problems;
}

const dir = mkdtempSync(join(tmpdir(), 'supervisor-skills-'));

try {
  if (SELFTEST) {
    // У каждой порчи СВОЙ след. «Хоть что-нибудь покраснело» засчитывало бы
    // порчу соседней проверке, а та, ради которой её вносят, молчала бы.
    const cases = [
      ['body-in-argv', 'тело скилла отправлено аргументом', 'тело скилла уехало аргументом'],
      ['no-expand', 'команда не развёрнута до записи реплики', 'не попала в переписку'],
    ];
    let missed = 0;
    for (const [damage, title, trace] of cases) {
      const problems = await probe(dir, damage, damage);
      const hit = problems.filter((problem) => problem.includes(trace));
      if (hit.length === 0) {
        console.error(
          `Самопроверка: «${title}» не поймана по следу «${trace}» (покраснело ${problems.length}).`,
        );
        missed += 1;
      } else {
        console.log(`Самопроверка: «${title}» замечена по следу «${trace}» (${hit.length}).`);
        for (const problem of problems) console.log(`    · ${problem}`);
      }
    }
    process.exit(missed > 0 ? 1 : 0);
  }

  const problems = await probe(dir, 'clean', null);
  if (problems.length > 0) {
    console.error('Скиллы и команды доезжают до цели неверно:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    'Тело скилла до argv и stdin не доехало — доехал путь до файла; отброшенный по приоритету скилл в каталоге не уехал; развёрнутая команда видна в переписке и совпадает с тем, что ушло цели.',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
