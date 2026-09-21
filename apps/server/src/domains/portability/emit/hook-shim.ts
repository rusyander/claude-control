import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_NAME, BRAND_SLUG } from '../../../lib/brand.mjs';
import { hookContentId } from '../../../lib/hook-id.ts';
import { readTextFile, writeTextFile } from '../../../lib/safe-io.ts';
import {
  SUPERVISOR_COMMON_FIELDS,
  SUPERVISOR_EVENTS,
  payloadFieldsOfEvent,
  type SupervisorEvent,
} from '../supervisor/payload.ts';

/**
 * ПЕРЕХОДНИК НАГРУЗКИ ДЛЯ РОДНЫХ ХУКОВ (П3.3).
 *
 * У `qwen` и `kimi` механизм хуков СВОЙ, поэтому событие отыгрывает сам CLI, а
 * не надзиратель панели (`hookEventOwner` → `native`). Но скрипт, снятый с
 * Claude, ждёт на stdin нагрузку в форме Claude — и получает форму хозяина.
 * Переходник встаёт между ними: читает нагрузку хозяина, переписывает известные
 * поля именами Claude и зовёт исходный скрипт ПО ЕГО СОБСТВЕННОМУ ПУТИ.
 *
 * Пользовательский скрипт не правится и не копируется: копия разошлась бы с
 * оригиналом первой же правкой, а правка чужого файла — не то, на что переносу
 * давали разрешение.
 *
 * Имена полей нагрузки Claude живут в ОДНОМ месте — `supervisor/payload.ts`, —
 * и набор полей события переходник берёт оттуда же (`payloadFieldsOfEvent`).
 * Второй таблицы имён не существует: разойдись они, скрипт получал бы у одной
 * половины панели поле, которого у другой не бывает.
 *
 * Приём отработан на `prompt-gate/gate-core.mjs`: сгенерированный скрипт живёт
 * своей жизнью, переживает остановку панели и ни от чего внутри неё не зависит —
 * поэтому у него нет импортов панели, а вся конфигурация вписана одним блоком.
 */

/** Метка сгенерированного переходника — по ней он узнаётся в файле. */
export const HOOK_SHIM_MARKER = `${BRAND_SLUG}:hook-shim`;

/**
 * Чужие написания полей СВЕРХ механических.
 *
 * Механическое написание переходник выводит сам (`hook_event_name` →
 * `hookEventName`): `qwen` — форк на TypeScript, и camelCase там ожидаемая
 * вторая форма того же поля. Здесь перечислено лишь то, что чужой CLI называет
 * СВОИМ словом: `event` — поле правила хуков Kimi (`lib/kimi-hook.ts`),
 * `user_prompt` — документированное имя текста человека у самого Claude
 * (запасным его читает и `prompt-gate/script.ts`).
 *
 * Выдумывать здесь нельзя: нагрузку stdin ни `qwen`, ни `kimi` не документируют,
 * и гарантий по их полям панель не даёт (в матрице верности это `×`). Поле, ни
 * одно написание которого в нагрузке не встретилось, из неё просто ИСЧЕЗАЕТ.
 */
const HOST_EXTRA_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  hook_event_name: ['event'],
  prompt: ['user_prompt'],
};

/** `hook_event_name` → `hookEventName`. */
function camelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Все написания одного поля, в порядке поиска: сперва имя Claude (нагрузка
 * хозяина может уже совпадать), затем его camelCase, затем чужие слова.
 */
export function hostSpellingsOf(field: string): readonly string[] {
  const names = [field, ...(HOST_EXTRA_SPELLINGS[field] ?? [])];
  return [...new Set(names.flatMap((name) => [name, camelCase(name)]))];
}

/** Одно поле нагрузки Claude и написания, под которыми его искать у хозяина. */
export interface HookShimField {
  /** Имя поля в нагрузке Claude — из `supervisor/payload.ts`. */
  readonly name: string;
  readonly from: readonly string[];
}

/** Конфигурация переходника — она же вписана в сам скрипт одним блоком. */
export interface HookShimConfig {
  /** Событие ЦЕЛИ, на которое панель зарегистрировала хук. */
  readonly event: string;
  /** Команда пользовательского скрипта — дословно, как её исполнил бы сам CLI. */
  readonly command: string;
  readonly fields: readonly HookShimField[];
  /**
   * Пропускать ли НЕИЗВЕСТНЫЕ поля хозяина под их собственными именами.
   *
   * Да — у событий, которых нет в таблице `supervisor/payload.ts` (события
   * инструментов — П4): их поля канон пока не называет, и выбросить их значило
   * бы отнять у скрипта единственные данные события. Нет — у событий, чей набор
   * полей объявлен: скрипт обязан увидеть ровно ту форму, что у Claude.
   */
  readonly passthrough: boolean;
}

function isSupervisorEvent(event: string): event is SupervisorEvent {
  return (SUPERVISOR_EVENTS as readonly string[]).includes(event);
}

/**
 * Набор полей события — объявлением из `supervisor/payload.ts`, а не догадкой.
 *
 * Событие вне таблицы (`PreToolUse`, `TodoCreated`, …) получает общие четыре
 * поля и пропуск остального: его состав принадлежит П4, и выдумывать имена за
 * канон переходник не вправе.
 */
export function hookShimFieldsOf(event: string): readonly HookShimField[] {
  const names = isSupervisorEvent(event) ? payloadFieldsOfEvent(event) : SUPERVISOR_COMMON_FIELDS;
  return names.map((name) => ({ name, from: hostSpellingsOf(name) }));
}

export function hookShimConfig(params: { event: string; command: string }): HookShimConfig {
  return {
    event: params.event,
    command: params.command,
    fields: hookShimFieldsOf(params.event),
    passthrough: !isSupervisorEvent(params.event),
  };
}

/**
 * Идентификатор переходника — от события и команды, тем же счётом, каким панель
 * различает хуки (`hookContentId`). Двоеточие в имени файла Windows не
 * допускает, поэтому в имени оно становится дефисом; второго способа считать
 * тождество хука при этом не появляется.
 */
export function hookShimId(config: Pick<HookShimConfig, 'event' | 'command'>): string {
  return hookContentId(config.event, undefined, config.command).replace(':', '-');
}

export function hookShimFileName(config: Pick<HookShimConfig, 'event' | 'command'>): string {
  return `${BRAND_SLUG}-hook-shim-${hookShimId(config)}.mjs`;
}

/** Переходник ложится РЯДОМ с конфигом цели — туда же, куда пишется сам хук. */
export function hookShimPath(
  dir: string,
  config: Pick<HookShimConfig, 'event' | 'command'>,
): string {
  return join(dir, hookShimFileName(config));
}

/**
 * Команда, которая встанет в конфиг цели вместо пользовательской.
 *
 * Разделитель `/` даже на Windows и кавычки вокруг пути — по той же причине, что
 * в `hook-command.ts`: обратная косая в строке команды для всякой оболочки
 * семейства sh есть экранирование, а не разделитель. Метка в команду НЕ
 * дописывается: `#` — комментарий для sh, но не для `cmd.exe`, и хук с таким
 * хвостом на Windows не запустился бы вовсе. Узнаётся переходник по метке ВНУТРИ
 * файла.
 */
export function hookShimCommand(path: string): string {
  return `node "${path.split('\\').join('/')}"`;
}

/**
 * Текст переходника.
 *
 * Скрипт самодостаточен: ни импортов панели, ни чтения её файлов. Хук исполняет
 * чужой CLI, и ссылка внутрь панели сломалась бы от переезда папки, а обращение
 * к её API — от того, что панель не запущена.
 */
export function buildHookShimSource(config: HookShimConfig): string {
  return `// Переходник нагрузки хука — сгенерирован ${BRAND_NAME}.
// ${HOOK_SHIM_MARKER}:${hookShimId(config)}
//
// У этого CLI событие «${config.event}» своё, а скрипт ниже написан под Claude и
// ждёт на stdin нагрузку в форме Claude. Переходник переписывает известные поля
// нагрузки хозяина именами Claude и зовёт скрипт ПО ЕГО СОБСТВЕННОМУ ПУТИ: файл
// скрипта не правится и не копируется.
//
// Поля, которого в нагрузке хозяина НЕТ, в нагрузке скрипта тоже нет. Пустая
// строка вместо него сделала бы «данных нет» неотличимым от «данные пустые», а
// отличать их — работа скрипта, не переходника.
//
// Файл можно править руками: панель заметит расхождение и не перезапишет его без
// явной переустановки.

import { spawn } from 'node:child_process';
import { stdin } from 'node:process';

const CONFIG = ${JSON.stringify(config, null, 2)};

let raw = '';
for await (const chunk of stdin) raw += chunk;

/** Нагрузка хозяина. Не объект — значит формы нет, и толковать её нечем. */
function hostPayload() {
  if (raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Все чужие написания, которые переходник переписывает сам. */
function knownSpellings() {
  const names = new Set();
  for (const field of CONFIG.fields) for (const alias of field.from) names.add(alias);
  return names;
}

/**
 * Нагрузка в форме Claude. Поле берётся по ПЕРВОМУ написанию, которое в нагрузке
 * хозяина ЕСТЬ; \`null\`, пустая строка и \`false\` — это данные, они доезжают.
 */
function claudePayload(host) {
  const payload = {};
  for (const field of CONFIG.fields) {
    for (const alias of field.from) {
      if (!Object.hasOwn(host, alias)) continue;
      payload[field.name] = host[alias];
      break;
    }
  }

  // Имя события — из регистрации хука: панель сама записала этот хук на это
  // событие, и это знание, а не догадка. Больше ничего отсутствующее в нагрузке
  // хозяина здесь не появляется.
  if (!Object.hasOwn(payload, 'hook_event_name')) payload.hook_event_name = CONFIG.event;

  if (CONFIG.passthrough) {
    const known = knownSpellings();
    for (const [key, value] of Object.entries(host)) {
      if (!known.has(key) && !Object.hasOwn(payload, key)) payload[key] = value;
    }
  }
  return JSON.stringify(payload);
}

const host = hostPayload();
if (host === undefined && raw !== '') {
  // Молчать нельзя: скрипт получит байты хозяина нетронутыми, и человек должен
  // знать, что приведения формы не было. Ломать прогон из-за этого — нельзя тоже.
  process.stderr.write(
    '${BRAND_NAME}: нагрузку хука разобрать не удалось — скрипт получил её как есть.\\n',
  );
}
const input = host === undefined ? raw : claudePayload(host);

// Скрипт зовётся той же командой, какой его позвал бы сам CLI, — через оболочку:
// в команде бывают аргументы. Нагрузка уходит ТОЛЬКО через stdin: на Windows
// цепочка cmd.exe → .cmd → .exe уничтожает текст с кавычками, а JSON нагрузки
// состоит из кавычек целиком.
const child = spawn(CONFIG.command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });

child.on('error', (error) => {
  process.stderr.write('${BRAND_NAME}: скрипт хука не запустился: ' + error.message + '\\n');
  process.exit(1);
});

// Скрипт вправе не читать stdin вовсе. Без этого обработчика закрытая труба
// (EPIPE) роняла бы САМ переходник, и хозяин видел бы его код вместо кода скрипта.
child.stdin.on('error', () => {});

child.on('exit', (code) => {
  // Код возврата — единственный способ хука что-то решить (2 блокирует), поэтому
  // он уходит хозяину нетронутым. Убитый сигналом скрипт кода не оставил: 1 —
  // «хук ошибся», а не «блокировать».
  process.exit(typeof code === 'number' ? code : 1);
});

child.stdin.end(input);
`;
}

/** Что лежит на месте переходника. */
export type HookShimState = 'absent' | 'ours' | 'customized';

/**
 * Свой ли это файл.
 *
 * Конфигурация вписана в скрипт одним блоком JSON: разбираем её и собираем текст
 * заново — совпал, значит файл панели (пусть и собранный с другой командой), и
 * его можно переписать. Не совпал — человек правил его руками, и трогать нельзя
 * (тот же счёт, что у `prompt-gate.ts`).
 *
 * Переводы строк и BOM при сравнении не считаются: редактор человека мог
 * сохранить файл в CRLF, ничего в нём не изменив, — объявить это «правкой»
 * значило бы заморозить переходник на первом же открытии в Блокноте.
 */
/**
 * Команда ЧЕЛОВЕКА, спрятанная за переходником, — или `undefined`, если команда
 * ведёт не на переходник.
 *
 * Нужна обратному чтению канона. Без неё круг замыкался бы неверно: у цели в
 * конфиге стоит команда переходника, и повторный импорт записал бы в канон
 * сгенерированный посредник вместо скрипта человека — то есть перенос подменил
 * бы людям их же хуки, молча и в одну сторону.
 *
 * Читается ФАЙЛ, а не команда: метка живёт внутри него (в команду её дописать
 * нельзя — `#` для `cmd.exe` не комментарий). Файла нет, метки нет, форма не
 * разбирается — команда считается человеческой и остаётся как есть: выдумывать
 * за неё панель не имеет права.
 */
export function readHookShimCommand(command: string): string | undefined {
  const match = /^node\s+"([^"]+)"\s*$/.exec(command.trim());
  const path = match?.[1];
  if (!path) return undefined;
  if (!existsSync(path)) return undefined;

  let source: string;
  try {
    source = readTextFile(path);
  } catch {
    return undefined;
  }
  if (!source.includes(`${HOOK_SHIM_MARKER}:`)) return undefined;

  const config = /^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(normalizeForm(source));
  if (!config?.[1]) return undefined;
  try {
    const parsed = JSON.parse(config[1]) as Partial<HookShimConfig>;
    return typeof parsed.command === 'string' ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

export function hookShimState(source: string): HookShimState {
  const text = normalizeForm(source);
  if (!text.includes(`${HOOK_SHIM_MARKER}:`)) return 'customized';

  const match = /^const CONFIG = (\{[\s\S]*?\n\});$/m.exec(text);
  if (!match?.[1]) return 'customized';

  let expected: string;
  try {
    expected = buildHookShimSource(JSON.parse(match[1]) as HookShimConfig);
  } catch {
    return 'customized';
  }
  return normalizeForm(expected) === text ? 'ours' : 'customized';
}

function normalizeForm(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .join('\n');
}

export interface InstallHookShimParams {
  /** Каталог, куда лёг бы переходник, — рядом с конфигом цели. */
  readonly dir: string;
  readonly event: string;
  /** Команда пользовательского скрипта — она уедет внутрь переходника. */
  readonly command: string;
  readonly backupDir?: string;
  /**
   * Переписать файл, правленный руками. Отдельное ЯВНОЕ действие: молча вернуть
   * своё поверх чужой правки — ровно то, чего критерий приёмки запрещает.
   */
  readonly force?: boolean;
}

export interface InstalledHookShim {
  readonly path: string;
  /** Команда для конфига цели: она зовёт переходник, а не скрипт человека. */
  readonly command: string;
  readonly state: HookShimState;
  /** Файл действительно записан. Нет — либо он уже такой, либо это чужая правка. */
  readonly written: boolean;
  /** Файл на месте правлен руками (и оставлен как есть, если не `force`). */
  readonly customized: boolean;
}

/**
 * Положить переходник рядом с конфигом цели.
 *
 * Идемпотентно: тот же самый текст второй раз не пишется (инвариант 10 — повтор
 * плана не создаёт правки). Правленный руками файл остаётся на месте, и это
 * видно ответом, а не молчанием.
 */
export function installHookShim(params: InstallHookShimParams): InstalledHookShim {
  const config = hookShimConfig({ event: params.event, command: params.command });
  const path = hookShimPath(params.dir, config);
  const wanted = buildHookShimSource(config);

  const current = existsSync(path) ? readTextFile(path) : undefined;
  const state: HookShimState = current === undefined ? 'absent' : hookShimState(current);
  const customized = state === 'customized';

  const keep = customized && params.force !== true;
  const same = current !== undefined && normalizeForm(current) === normalizeForm(wanted);
  const written = !keep && !same;
  if (written) writeTextFile(path, wanted, { backupDir: params.backupDir });

  return { path, command: hookShimCommand(path), state, written, customized };
}
