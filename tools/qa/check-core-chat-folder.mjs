/**
 * Чат панели в папке без git — через ядро, как прежде без ядра (этап 10 — паритет).
 *
 * Прежняя панель вела чат в любой папке; ядро требовало репозиторий и отказывало оценке «not a
 * git repository». Теперь чат на месте в папке без git идёт в ней же: копии, ветки и MR у такого
 * чата нет (их не у чего брать), разговор — тот же. Отказ оценки по иной причине доходит до
 * человека с причиной ядра, а не общим «код estimate-refused, причина в журнале» (журнала у
 * задачи, которой нет, не откроешь).
 *
 * Настоящее всё, кроме модели: панель, ядро, его хост сеансов и настоящий `claude` — модель у
 * него заглушка `packages/stub-model` по адресу из личного `settings.json` стенда (вход CLI).
 *
 * Строки:
 *  - папка без git: ответ модели в потоке, ошибки нет; задача ядра одна, сеанс в самой папке;
 *    второй ход — ответ в той же задаче; `.git` в папке не появился;
 *  - git без единого коммита: ход не отправлен, код `core-chat-estimate-refused`, причина ядра
 *    (база не найдена) — в тексте;
 *  - папки нет: панель ведёт новый чат в своей песочнице (тоже без git) — ответ модели там.
 *
 * Запуск: node tools/qa/check-core-chat-folder.mjs   (нужен `claude` в PATH)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { NotChecked, runOnStand } from './throwaway-stand.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
  encoding: 'utf8',
});
const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';

const said = [];
const lastBodies = [];
const stub = await startStubModel({
  script: (ctx) => {
    // Ход — последнее сообщение человека с «ход-N»: CLI дописывает после него свои напоминания.
    const messages = ctx.request.body?.messages ?? [];
    const turn = [...messages]
      .reverse()
      .map((m) =>
        m?.role === 'user' ? /ход-(\d+)/.exec(JSON.stringify(m.content))?.[1] : undefined,
      )
      .find(Boolean);
    said.push(turn ?? '-');
    lastBodies.push(JSON.stringify(messages.at(-1) ?? '').slice(0, 700));
    return { text: turn ? `ответ из папки на ход-${turn}` : 'stub side reply' };
  },
});
const stubEnv = { ANTHROPIC_BASE_URL: stub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const same = (a, b) =>
  resolve(a)
    .replace(/[\\/]+$/, '')
    .toLowerCase() ===
  resolve(b)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

let plain = '';
let unborn = '';
let missing = '';

try {
  await runOnStand(
    {
      label: 'core-chat-folder',
      // Проверка идёт через API панели (её точка входа `/api/chat/send`): фронт не нужен.
      web: false,
      extraPath: claudeAt ? [dirname(claudeAt)] : [],
      env: stubEnv,
      core: true,
      seed: ({ root, cfg }) => {
        plain = join(root, 'plain');
        mkdirSync(plain, { recursive: true });
        writeFileSync(join(plain, 'notes.txt'), 'папка без git\n');
        unborn = join(root, 'unborn');
        mkdirSync(unborn, { recursive: true });
        git(unborn, ['init', '-q', '-b', 'main']);
        missing = join(root, 'no-such-folder');
        // Вход claude стенда — адрес и ключ заглушки в личном settings.json, как у человека со
        // своим адресом модели: окружение стенда до CLI ядра не доходит, личный слой — доходит.
        const settingsPath = join(cfg, 'settings.json');
        const settings = existsSync(settingsPath)
          ? JSON.parse(readFileSync(settingsPath, 'utf8'))
          : {};
        writeFileSync(
          settingsPath,
          `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
        );
      },
    },
    async (stand, check) => {
      if (!claudeAt) throw new NotChecked('claude не найден в PATH');
      const tasks = () => {
        const dir = join(stand.coreHome, 'tasks');
        return existsSync(dir) ? readdirSync(dir) : [];
      };
      const journalOf = (taskId) => {
        const dir = join(stand.coreHome, 'tasks', taskId);
        const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
        return readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      };
      const send = async (chatId, prompt, projectPath, sessionId) => {
        const sent = await stand.api('/chat/send', {
          method: 'POST',
          body: { chatId, prompt, projectPath, ...(sessionId ? { sessionId } : {}) },
        });
        const events = String(sent.text)
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data: '))
          .map((line) => {
            try {
              return JSON.parse(line.slice(6));
            } catch {
              return {};
            }
          });
        return {
          status: sent.status,
          events,
          text: events
            .filter((e) => e.kind === 'text')
            .map((e) => e.text)
            .join(''),
          error: events.find((e) => e.kind === 'error'),
          raw: String(sent.text).slice(0, 600),
        };
      };
      const tail = (taskId) =>
        taskId
          ? journalOf(taskId)
              .slice(-8)
              .map((l) => `${l.kind} ${JSON.stringify(l.data ?? {}).slice(0, 200)}`)
              .join('\n      ')
          : 'задачи нет';

      // ---------------------------------------------------------------- папка без git
      console.log(`папка без git: ${plain}`);
      const chatId = randomUUID();
      const before = tasks();
      const first = await send(chatId, 'ход-1: привет из папки без git', plain);
      const fresh = tasks().filter((t) => !before.includes(t));
      check(
        'папка без git: ход не отказан',
        first.error === undefined,
        JSON.stringify(first.error ?? null),
      );
      check(
        'папка без git: ответ модели в потоке',
        first.text.includes('ответ из папки на ход-1'),
        `${first.status} ${first.raw}\n    модель видела: ${said.join(',')} ${lastBodies.at(-1) ?? ''}\n    журнал: ${tail(fresh[0])}`,
      );
      check(`папка без git: одна задача ядра (${fresh.join(',') || 'нет'})`, fresh.length === 1);
      const started = fresh[0]
        ? journalOf(fresh[0]).find((l) => l.kind === 'session.started')?.data
        : undefined;
      check(
        'папка без git: сеанс claude в самой папке',
        started?.adapter === 'claude' &&
          typeof started?.cwd === 'string' &&
          same(started.cwd, plain),
        JSON.stringify(started ?? null).slice(0, 400),
      );
      const sessionId = first.events.find((e) => e.kind === 'session')?.sessionId;
      const second = await send(chatId, 'ход-2: и ещё раз', plain, sessionId);
      const after2 = tasks().filter((t) => !before.includes(t));
      check(
        'папка без git: второй ход — ответ в той же задаче',
        second.text.includes('ответ из папки на ход-2') && after2.length === 1,
        `${JSON.stringify(second.error ?? null)} задач: ${after2.length} ${second.raw}`,
      );
      check('папка без git: .git в папке не появился', !existsSync(join(plain, '.git')));

      // ---------------------------------------------------------------- git без коммита
      console.log(`git без коммита: ${unborn}`);
      const refused = await send(randomUUID(), 'ход-3: тут нет базы', unborn);
      check(
        'git без коммита: ход отказан кодом оценки',
        refused.error?.code === 'core-chat-estimate-refused',
        JSON.stringify(refused.error ?? null) + ` ${refused.raw}`,
      );
      check(
        'git без коммита: причина ядра в тексте и в параметрах',
        /not found/.test(String(refused.error?.params?.reason ?? '')) &&
          /not found/.test(String(refused.error?.message ?? '')),
        JSON.stringify(refused.error ?? null),
      );

      // ---------------------------------------------------------------- папки нет
      // Несуществующую папку панель ядру не передаёт: новый чат без годной папки идёт в её
      // песочницу, как шёл всегда (`validTargetCwd` → `resolveWorkspace`). Песочница — тоже папка
      // без git, и ход в ней теперь доходит до модели.
      console.log(`папки нет: ${missing}`);
      const beforeNone = tasks();
      const none = await send(randomUUID(), 'ход-4: папки нет', missing);
      const noneTask = tasks().filter((t) => !beforeNone.includes(t))[0];
      const noneCwd = noneTask
        ? journalOf(noneTask).find((l) => l.kind === 'session.started')?.data?.cwd
        : undefined;
      check(
        'папки нет: ход идёт в песочнице панели, ответ модели в потоке',
        none.error === undefined &&
          none.text.includes('ответ из папки на ход-4') &&
          typeof noneCwd === 'string' &&
          !same(noneCwd, missing) &&
          existsSync(noneCwd) &&
          !existsSync(join(noneCwd, '.git')),
        `${none.status} cwd=${noneCwd} ${JSON.stringify(none.error ?? null)} ${none.raw}`,
      );
      check('папки нет: папка не создана', !existsSync(missing));
    },
  );
} finally {
  await stub.close();
}
