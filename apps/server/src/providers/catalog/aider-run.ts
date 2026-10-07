import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { OneShotRun, ProviderStdoutParser } from '../types/assistant.ts';

/**
 * Одиночный запуск Aider (`aider --message`) — argv, окружение и разбор stdout.
 *
 * Всё ниже снято живыми пробами настоящего aider-chat 0.86.2 (Windows 11, uv,
 * временный HOME, заглушка OpenAI-совместимой модели), а не только справкой.
 *
 * Главное, что показали пробы: у одиночного запуска НЕТ человека, а stdin у
 * процесса закрыт, и КАЖДЫЙ вопрос Aider на конце файла берёт ответ по
 * умолчанию — «да». Голый `--message` поэтому правил файл при выключенных
 * правках, делал коммит в репозитории человека, дописывал `.gitignore`,
 * создавал `git init` в каталоге без репозитория, открывал браузер (заметки о
 * выпуске, предупреждение о модели), включал аналитику и запустил бы команду
 * оболочки, предложенную моделью. Каждый флаг ниже закрывает один такой «да».
 */

/**
 * Флаги на каждый запуск, независимо от переключателя правок.
 *
 * - `--no-auto-commits` / `--no-dirty-commits` — Aider НИКОГДА не коммитит в
 *   репозитории человека: ни свои правки, ни «грязное» дерево перед ними.
 * - `--no-gitignore` — не дописывать `.aider*` в `.gitignore` человека.
 * - `--chat-history-file` / `--input-history-file` в нулевое устройство — панель
 *   хранит переписку сама, а каждый запуск получает её целиком, так что файлы
 *   истории в корне проекта только росли бы копиями.
 * - `--no-pretty` — простой текст без ANSI; `--no-fancy-input` — без
 *   prompt_toolkit (на трубе он печатает «No Windows console found»).
 * - `--no-check-update` (иначе предложит `pip install` и согласится сам),
 *   `--no-show-release-notes` и `--no-show-model-warnings` (обе открывают
 *   браузер), `--no-analytics` (иначе согласится на сбор), `--no-detect-urls`
 *   (иначе скачает упомянутые ссылки).
 * - `--no-suggest-shell-commands` — без человека «Run shell command?» на конце
 *   stdin отвечается «да», и `--dry-run` команду НЕ останавливает.
 */
const ALWAYS = [
  '--no-auto-commits',
  '--no-dirty-commits',
  '--no-gitignore',
  '--chat-history-file',
  devNull,
  '--input-history-file',
  devNull,
  '--no-pretty',
  '--no-fancy-input',
  '--no-check-update',
  '--no-show-release-notes',
  '--no-show-model-warnings',
  '--no-analytics',
  '--no-detect-urls',
  '--no-suggest-shell-commands',
] as const;

/** Лежит ли каталог внутри рабочего дерева git (`.git` — каталог или файл worktree). */
export function insideGitTree(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * argv одиночного запуска. Промпт — ОТДЕЛЬНЫМ элементом после `--message`.
 *
 * Правки: `--yes-always` только при явном «Разрешить правки», иначе `--dry-run`
 * (правки показываются, файлы не пишутся). Не задано (ассистент формы, разговор
 * старше переключателя) — тоже `--dry-run`: спросить человека одиночный запуск
 * не может, а «да» по умолчанию тут дал бы сам Aider.
 *
 * Git: каталог вне репозитория → `--no-git`. Без него Aider на вопрос «создать
 * репозиторий?» сам отвечает «да» и делает `git init` в каталоге человека (а
 * ассистент формы и вовсе запускается в пустой временной папке). Каталог не
 * передан — CLI стартует в каталоге сервера панели, и чужой репозиторий там
 * трогать тем более незачем.
 */
export function aiderOneShotArgs(
  prompt: string,
  run?: OneShotRun,
  isGitTree: (dir: string) => boolean = insideGitTree,
): string[] {
  return [
    '--message',
    prompt,
    run?.allowEdits === true ? '--yes-always' : '--dry-run',
    ...(run?.workdir && isGitTree(run.workdir) ? [] : ['--no-git']),
    ...ALWAYS,
  ];
}

/**
 * Окружение запуска. Python на Windows пишет в трубу кодировкой локали (cp1251):
 * русский ответ приходил «������» — `PYTHONUTF8`/`PYTHONIOENCODING` переводят
 * stdout в UTF-8, который ждёт панель. `COLUMNS` — служебные строки Aider печатает
 * через rich, а тот без терминала режет их по 80 колонкам (путь к репозиторию
 * переносился посреди строки, и разбор ниже его бы не узнал).
 */
export function aiderOneShotEnv(): Record<string, string> {
  return { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', COLUMNS: '4000' };
}

/** Вопрос Aider, напечатанный без человека: `… (Y)es/(N)o… [Yes]: `, ответ — на той же строке. */
const QUESTION = /^.*?\(Y\)es\/\(N\)o[^\n]*?\[[^\]\n]*\]: ?/;
/** Строка расхода токенов — граница ответа модели. */
const USAGE = /^Tokens: .*\bsent\b/;
/** Что после ответа остаётся человеку: исход правок. Прочее после расхода — служебное. */
const OUTCOME =
  /^(Applied edit to |Did not apply edit to |Skipping edits to |The LLM did not conform)/;

type Phase = 'head' | 'lead' | 'body' | 'tail';

/**
 * Разбор stdout `aider --message … --no-pretty` (фикстуры —
 * `__fixtures__/aider-0.86.2-*.txt`, сняты живым прогоном). Форма вывода:
 *
 *  1. заставка: возможные предупреждения, `Aider v…`, `Model: …`, `Git repo: …`,
 *     `Repo-map: …` (есть всегда), строки о файлах — и ПУСТАЯ строка;
 *  2. вопросы о файлах, упомянутых в сообщении: пустая строка, имя файла и
 *     (без `--yes-always`) вопрос, после которого ответ модели идёт той же строкой;
 *  3. ответ модели — потоком, как есть;
 *  4. `Tokens: … sent, … received.` (+ `Cost: …`), затем исход правок.
 *
 * Отдаётся только 3 и строки исхода правок из 4. Ограничение эвристики: ответ,
 * который САМ начинается с пустой строки, потерял бы первую строку (её не
 * отличить от имени файла в п. 2) — модели так не отвечают. Не нашлась строка
 * `Repo-map:` (Aider упал раньше заставки) — отдаётся весь вывод: лучше
 * служебный текст, чем пустой ответ без причины.
 */
export function createAiderStdoutParser(): ProviderStdoutParser {
  let phase: Phase = 'head';
  let sawRepoMap = false;
  let expectSubject = false;
  let afterSubject = false;
  let raw = '';
  let pending = '';
  let emitted = 0;
  // Ответ кончился пустой строкой — исходу правок отдельная не нужна.
  let blankLast = false;
  // Повторная попытка Aider («reflection») печатает тот же исход ещё раз.
  const outcomes = new Set<string>();

  const clean = (text: string): string => text.replace(/\r/g, '');

  /** Строка тела целиком: граница ответа или очередная строка ответа. */
  const bodyLine = (line: string): string => {
    if (emitted === 0 && USAGE.test(line)) {
      phase = 'tail';
      return '';
    }
    blankLast = emitted === 0 && line === '';
    return `${line.slice(emitted)}\n`;
  };

  const tailLine = (line: string): string => {
    const text = line.replace(QUESTION, '');
    if (!OUTCOME.test(text) || outcomes.has(text)) return '';
    const lead = outcomes.size === 0 && !blankLast ? '\n' : '';
    outcomes.add(text);
    return `${lead}${text}\n`;
  };

  /** Полная строка (без перевода строки) — текст, который пора показать. */
  const completeLine = (line: string): string => {
    if (phase === 'head') {
      if (line.startsWith('Repo-map:')) sawRepoMap = true;
      else if (sawRepoMap && line.trim() === '') phase = 'lead';
      return '';
    }
    if (phase === 'lead') {
      if (line.trim() === '') {
        expectSubject = true;
        return '';
      }
      if (USAGE.test(line)) {
        phase = 'tail';
        return '';
      }
      const question = line.match(QUESTION);
      if (question) {
        const rest = line.slice(question[0].length);
        // Вопрос, сразу за ним перевод строки — это пустая строка следующего вопроса.
        if (rest === '') {
          expectSubject = true;
          return '';
        }
        phase = 'body';
        return `${rest}\n`;
      }
      if (expectSubject) {
        expectSubject = false;
        afterSubject = true;
        return '';
      }
      phase = 'body';
      return `${line}\n`;
    }
    if (phase === 'body') return bodyLine(line);
    return tailLine(line);
  };

  /** Незаконченная строка: в теле показываем сразу, если это не начало `Tokens:`. */
  const partialLine = (): string => {
    if (phase === 'lead') {
      const question = pending.match(QUESTION);
      if (question && pending.length > question[0].length) {
        phase = 'body';
        pending = pending.slice(question[0].length);
        emitted = 0;
      } else if (!question && !expectSubject && !afterSubject && clean(pending) !== '') {
        // Сразу за заставкой, без вопросов о файлах, — это уже ответ модели.
        phase = 'body';
      } else {
        // После имени файла строка может оказаться и вопросом, и ответом —
        // ждём её конца (или «]: » вопроса).
        return '';
      }
    }
    if (phase !== 'body') return '';
    // `emitted` считается по очищенному тексту — так же режет `bodyLine`.
    const visible = clean(pending);
    if (emitted === 0 && ('Tokens: '.startsWith(visible) || visible.startsWith('Tokens: '))) {
      return '';
    }
    const fresh = visible.slice(emitted);
    emitted = visible.length;
    if (fresh) blankLast = false;
    return fresh;
  };

  return {
    push(chunk) {
      raw += chunk;
      pending += chunk;
      let out = '';
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = clean(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        // Часть строки уже ушла кусками — `bodyLine` отрезает её по `emitted`.
        out += completeLine(line);
        emitted = 0;
        newline = pending.indexOf('\n');
      }
      return out + partialLine();
    },
    end() {
      if (phase === 'head') return clean(raw);
      const rest = clean(pending);
      pending = '';
      if (rest === '') return '';
      if (phase === 'tail') return tailLine(rest);
      if (phase === 'lead') {
        const question = rest.match(QUESTION);
        return question ? rest.slice(question[0].length) : rest;
      }
      return rest.slice(emitted);
    },
  };
}
