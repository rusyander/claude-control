import { parseDocument, isMap, isSeq, isScalar, type Document } from 'yaml';
import type { ProviderEnvVar } from '@claude-control/contracts';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { EnvKeyNotEncodableError } from './env-key.ts';
import { stripBom } from './text-form.ts';

/**
 * Round-trip-правка глобального конфига Aider `~/.aider.conf.yml`.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (aider.chat/docs/config/aider_conf.html и
 * .../config/options.html) и потому реализовано:
 *  - сам файл: «Place in your home dir, or at the root of your git repo» —
 *    глобальный вариант это ровно `~/.aider.conf.yml`;
 *  - ключ `set-env` — «Set an environment variable (to control API settings, can
 *    be used multiple times)», значение — строка `КЛЮЧ=значение` либо СПИСОК
 *    таких строк. Это единственный задокументированный глобальный объект Aider,
 *    ложащийся на существующий раздел панели (переменные окружения).
 *
 *  - ключ `read` (AIDER-1) — СПИСОК путей к файлам контекста/инструкций
 *    (`read: [CONVENTIONS.md, anotherfile.txt]`; допустима и форма маркированным
 *    списком, и одиночная строка). Единого «файла инструкций» у Aider нет —
 *    панель управляет именно этим списком ССЫЛОК.
 *
 * ЧЕГО У AIDER НЕТ (и потому панель этого не делает): MCP-серверов — в
 * справочнике опций такой настройки нет вовсе. Форматы не угадываем.
 *
 * ПОЧЕМУ Document API, а не `parse`+`stringify`: конфиг Aider у людей — это
 * большой закомментированный образец из документации. Полная пересборка стёрла
 * бы все комментарии и порядок ключей. Document API правит ДЕРЕВО с сохранением
 * комментариев, якорей и незатронутых ключей; меняется только узел `set-env`.
 *
 * FAIL-CLOSED: файл не разбирается как YAML, корень не отображение, `set-env`
 * имеет неожиданную форму (не строка/не список строк, элемент без `=`), или
 * результат не сходится с намерением при контрольном разборе → НЕ пишем,
 * бросаем `UnrecognizedFormatError` (раздел только для чтения).
 */

// Переэкспорт для доменов/тестов: классы те же самые, `instanceof` цел.
export { UnrecognizedFormatError, EnvKeyNotEncodableError };

/** Задокументированный ключ переменных окружения в `~/.aider.conf.yml`. */
export const AIDER_SET_ENV_KEY = 'set-env';

/**
 * Задокументированный ключ ССЫЛОК на файлы контекста/инструкций (AIDER-1):
 * `read: [CONVENTIONS.md, anotherfile.txt]`. Допустимы обе формы записи списка
 * (inline-массив и маркированный список), а одиночная строка = список из одного
 * элемента. Единого «файла инструкций» у Aider нет — есть вот этот список ссылок.
 */
export const AIDER_READ_KEY = 'read';

/**
 * Ключ переменной непригоден для формы `КЛЮЧ=значение`: пустой, содержит `=`
 * (разделитель) или перевод строки. Такой ключ не отделяется от значения при
 * обратном чтении → запись отклоняется ДО касания файла.
 */
function rejectKey(key: string): never {
  throw new EnvKeyNotEncodableError(
    key,
    '~/.aider.conf.yml',
    'ключ не должен быть пустым и не может содержать «=» или перевод строки.',
  );
}

/**
 * Разобрать конфиг Aider в Document. Пустой файл (или файл из одних
 * комментариев) — валиден: `contents` там пуст, ключи добавим сами. Любая ошибка
 * разбора или корень-не-отображение → fail-closed.
 *
 * BOM снимается перед разбором (Блокнот/PowerShell пишут файлы именно так) —
 * иначе здоровый конфиг уходил бы в read-only. Обратно BOM вернёт `writeTextFile`
 * (он сохраняет форму существующего файла).
 */
export function parseAiderDocument(text: string): Document {
  const doc = parseDocument(stripBom(text));
  if (doc.errors.length > 0) throw new UnrecognizedFormatError();
  if (doc.contents !== null && !isMap(doc.contents)) throw new UnrecognizedFormatError();
  return doc;
}

/** Разбить задокументированную запись `КЛЮЧ=значение`. Без `=` → формат не наш. */
function splitEntry(raw: string): ProviderEnvVar {
  const at = raw.indexOf('=');
  // `at === 0` — пустое имя переменной: тоже не наша форма.
  if (at <= 0) throw new UnrecognizedFormatError();
  return { key: raw.slice(0, at).trim(), value: raw.slice(at + 1) };
}

/**
 * Прочитать `set-env` как список пар. Ключа нет → пусто. Скалярная строка —
 * задокументированная краткая форма одной переменной. Всё прочее (число, карта,
 * список с не-строками) → fail-closed: значение не наше, править нельзя.
 */
export function readAiderSetEnv(text: string): ProviderEnvVar[] {
  const doc = parseAiderDocument(text);
  const node = doc.get(AIDER_SET_ENV_KEY, true);
  if (node === undefined || node === null) return [];

  const items = isSeq(node) ? node.items : [node];
  return items.map((item) => {
    if (!isScalar(item) || typeof item.value !== 'string') throw new UnrecognizedFormatError();
    return splitEntry(item.value);
  });
}

/** Все ключи верхнего уровня, кроме указанного, в виде стабильной проекции. */
function otherKeysProjection(doc: Document, exceptKey: string): string {
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete rest[exceptKey];
  // Ключи сортируем: сравниваем СОДЕРЖИМОЕ, а не порядок обхода.
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Записать желаемый набор переменных в `set-env`, СОХРАНИВ всё остальное:
 * комментарии (в том числе комментарий над самим `set-env`), порядок ключей,
 * форматирование незатронутых узлов. Пустой набор — ключ удаляется (дефолт
 * молча не пишем).
 *
 * Возвращает НОВЫЙ текст файла; сама запись — снаружи, через `safe-io`
 * (бэкап + атомарно + сохранение формы файла).
 *
 * Перед возвратом результат ПЕРЕПРОВЕРЯЕТСЯ: он обязан разбираться, давать ровно
 * заданный `set-env` и не менять ни одного другого ключа. Не сошлось —
 * `UnrecognizedFormatError`, файл не трогаем.
 */
export function writeAiderSetEnv(text: string, vars: ProviderEnvVar[]): string {
  for (const { key } of vars) {
    if (!key.trim() || key.includes('=') || /[\r\n]/.test(key)) rejectKey(key);
  }

  // Fail-closed на ВХОДЕ: если существующий `set-env` не читается нашей моделью
  // (карта вместо списка, элемент без `=`), значит форма не наша — перезаписывать
  // её вслепую нельзя, даже если сам YAML валиден.
  readAiderSetEnv(text);

  // Два разбора: один — эталон «как было», второй — рабочее дерево для правки.
  const original = parseAiderDocument(text);
  const draft = parseAiderDocument(text);

  if (vars.length === 0) draft.delete(AIDER_SET_ENV_KEY);
  else
    draft.set(
      AIDER_SET_ENV_KEY,
      vars.map((item) => `${item.key}=${item.value}`),
    );

  // lineWidth: 0 — не переносить длинные строки: значение переменной должно
  // остаться одной строкой, каким бы длинным оно ни было.
  const next = draft.toString({ lineWidth: 0 });

  // Контроль ДО записи: результат разбирается, `set-env` совпал с намерением,
  // прочие ключи байт-в-байт по смыслу те же.
  const check = parseAiderDocument(next);
  const wanted = JSON.stringify(vars);
  const got = JSON.stringify(readAiderSetEnv(next));
  if (wanted !== got) throw new UnrecognizedFormatError();
  if (
    otherKeysProjection(original, AIDER_SET_ENV_KEY) !==
    otherKeysProjection(check, AIDER_SET_ENV_KEY)
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}

// --- Список ссылок на файлы инструкций (`read`, AIDER-1) ---------------------

/**
 * Прочитать `read` как список путей в порядке их следования в файле.
 *
 * Формы, задокументированные Aider и потому поддержанные:
 *  - список (inline `read: [a.md, b.txt]` и маркированный `- a.md`);
 *  - одиночная строка `read: CONVENTIONS.md` → список из одного элемента.
 *
 * Ключа нет → пустой список. Всё прочее (число, карта, список с не-строками,
 * пустая строка) → fail-closed: форма не наша, править её вслепую нельзя.
 */
export function readAiderReadList(text: string): string[] {
  const doc = parseAiderDocument(text);
  const node = doc.get(AIDER_READ_KEY, true);
  if (node === undefined || node === null) return [];

  const items = isSeq(node) ? node.items : [node];
  return items.map((item) => {
    if (!isScalar(item) || typeof item.value !== 'string') throw new UnrecognizedFormatError();
    const value = item.value.trim();
    if (!value) throw new UnrecognizedFormatError();
    return value;
  });
}

/**
 * Записать желаемый список ссылок в `read`, СОХРАНИВ всё остальное: комментарии
 * (в том числе над самим `read`), порядок ключей и любые другие ключи конфига.
 * Пустой список — ключ удаляется (пустой `read: []` молча не пишем).
 *
 * Порядок записей значим (это порядок подключения контекста) и сохраняется как
 * есть — перестановка в панели это просто другой массив.
 *
 * Возвращает НОВЫЙ текст файла; сама запись — снаружи, через `safe-io` (бэкап +
 * атомарно + сохранение формы файла). Перед возвратом результат
 * ПЕРЕПРОВЕРЯЕТСЯ: разбирается, даёт ровно заданный `read` и не меняет ни одного
 * другого ключа. Не сошлось — `UnrecognizedFormatError`, файл не трогаем.
 */
export function writeAiderReadList(text: string, entries: string[]): string {
  for (const entry of entries) {
    if (!entry.trim() || /[\r\n]/.test(entry)) {
      throw new UnrecognizedFormatError();
    }
  }

  // Fail-closed на ВХОДЕ: существующий `read` обязан читаться нашей моделью,
  // иначе перезапись стёрла бы форму, которую мы не понимаем.
  readAiderReadList(text);

  const original = parseAiderDocument(text);
  const draft = parseAiderDocument(text);

  if (entries.length === 0) draft.delete(AIDER_READ_KEY);
  else draft.set(AIDER_READ_KEY, [...entries]);

  // lineWidth: 0 — длинный путь не переносится на следующую строку.
  const next = draft.toString({ lineWidth: 0 });

  const check = parseAiderDocument(next);
  if (JSON.stringify(entries) !== JSON.stringify(readAiderReadList(next))) {
    throw new UnrecognizedFormatError();
  }
  if (
    otherKeysProjection(original, AIDER_READ_KEY) !== otherKeysProjection(check, AIDER_READ_KEY)
  ) {
    throw new UnrecognizedFormatError();
  }

  return next;
}
