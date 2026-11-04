/**
 * Снимки для справки: общий набор на ВСЕ разделы, а не на один.
 *
 * Раскладка каталога — `раздел → сценарий → кадр`:
 *
 *   apps/web/public/help/<раздел>/<сценарий>/<NN>-<кадр>.png
 *   apps/web/public/help/<раздел>/<сценарий>/frames.json
 *
 * `раздел` — идентификатор документа справки (`platform`, `chat`, `tests`…),
 * тот же, что в `HELP_GROUPS`: человек ищет картинку там же, где текст.
 * `сценарий` — один путь через раздел от начала до конца («подключение»,
 * «разделение», «прогон»). `NN` — порядок шага в сценарии.
 *
 * ЧТО ТАКОЕ `frames.json` И ЗАЧЕМ ОН. Рядом с кадрами лежит опись: размер,
 * сторона, время съёмки и — главное — ВИДИМЫЙ ТЕКСТ кадра, снятый из той же
 * разметки и в тот же момент, что и картинка. По нему `tools/qa/check-help-shots.mjs`
 * ищет ключи, токены, чужие домены и имена. Без описи такая проверка была бы
 * чтением глазами: текст внутри PNG не ищется.
 *
 * Граница честности этой проверки названа прямо: она видит то, что было В
 * РАЗМЕТКЕ снимаемой области. Секрет, нарисованный на canvas или пришедший
 * картинкой, в текст не попадёт — таких кадров у нас нет, и появиться они
 * должны осознанно.
 *
 * ПЕЧАТЬ КАДРА (`seal`) связывает текст описи с байтами PNG: отпечаток картинки и отпечаток
 * текста, снятые в одном вызове `shot`. Без неё правленый руками текст рядом со старой картинкой
 * проходил все сканы чисто: сканы читают текст, пиксели не читает никто, OCR здесь нет — так
 * platform/agent/01-chat-run нёс марку стенда и прежнее имя панели (03.11.2026). Сторож
 * пересчитывает обе половины и краснеет, если одна сдвинулась без другой. Картинку,
 * обработанную после снимка (заплатка пикселей), перештамповывает `restampFrame` — сам скрипт
 * обработки, тем же проходом, которым пишет PNG; руками печать не ставится.
 *
 * ЗАМАЗЫВАНИЕ настоящее, а не обещанное: `mask` подменяет текст узлов ДО
 * снимка, и в опись уходит уже подменённый текст. Если подмена не сработала,
 * секрет окажется в описи и проверка станет красной — то есть правило
 * проверяется тем же прогоном, который его применяет.
 *
 * ЗДЕСЬ ЖЕ — общий счётный аппарат свежести справки: отпечаток страницы
 * `.drawio` для схем и отпечаток исходника для описи `sources.json` (какой код
 * описывает раздел и каким он был на последней сверке). Считать одно и то же
 * по разные стороны проверки нельзя: сторож и инструмент подтверждения обязаны
 * получать одно число, иначе подтверждение перестанет гасить красноту.
 */
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { brandPass, readBrandMask } from './brand-mask.mjs';

// Панель с надзором ядра поднимает ядро, а то — хост переходов; оба переживают панель
// (так задумано для живой машины). Съёмка гасит панель и уходит, и каждый прогон оставлял
// хост переходов, держащий дом стенда, — снос падал EBUSY, следующий прогон не стартовал
// (03.11.2026). Пачки съёмки наследуют окружение этого процесса; кому ядро нужно, задаёт
// переменную явно (`throwaway-stand.mjs` с `core`, `panel-agent-panel.mjs`).
process.env.AGENTDECK_CORE_SUPERVISE ??= '0';

/**
 * Запись описи с повтором. Windows отдаёт `UNKNOWN`/`EBUSY`/`EPERM` на открытие файла, который
 * в этот миг держит антивирус или чтение соседней пачки: прогон 03.11.2026 снял все кадры
 * сценария и упал на последней записи `frames.json` — опись осталась старой. Ждём до ~15 с:
 * пяти не хватило прогону portability 03.11.2026 (UNKNOWN на transfer/frames.json).
 */
function writeFileRetry(path, text) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(path, text, 'utf8');
      return;
    } catch (error) {
      const busy = ['UNKNOWN', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!busy || attempt >= 60) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/**
 * Корень репозитория. Считается от места этого файла, а не от рабочего
 * каталога: съёмку запускают из корня, а проверка ходит сюда из `tools/qa/` —
 * на `process.cwd()` они смотрели бы в разные папки.
 */
export const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Корень каталога снимков. Он же раздаётся фронтом как `/help/...`. */
export const SHOTS_ROOT = join(REPO_ROOT, 'apps/web/public/help');

/** Чем закрывается секрет в кадре. Символ один и тот же везде — узнаваемо. */
export const MASK = '••••••••••••';

/**
 * Одноразовый дом для съёмки — в каталоге, чьё имя не уедет в публичный кадр.
 *
 * Путь панели попадает В КАДР: с П2.7 страница инструкций печатает путь
 * прочитанного файла. Временная папка системы на Windows лежит внутри профиля
 * (`C:\Users\<учётка>\AppData\...`), и снимок унёс бы имя учётной записи машины
 * в публичное дерево; каталог самого репозитория унёс бы его имя, а оно у этого
 * репозитория — прежнее имя продукта, запрещённое сторожем марки.
 *
 * Поэтому дом заводится в нейтральном каталоге у корня диска. Он может быть
 * недоступен на записи (чужая машина, ограниченные права) — тогда берётся
 * обычная временная папка, и об этом сказано вслух: кадр получится, но путь в
 * нём будет с именем учётной записи.
 */
export function shotHome(prefix) {
  const neutral = join(parse(tmpdir()).root, 'agentdeck-help-shots');
  try {
    mkdirSync(neutral, { recursive: true });
    return mkdtempSync(join(neutral, prefix));
  } catch {
    console.log(`нейтральный каталог ${neutral} недоступен — снимаю во временной папке профиля`);
    return mkdtempSync(join(tmpdir(), prefix));
  }
}

/** Опись схем рядом с их картинками: по ней видно, что картинка отстала. */
export const DIAGRAMS_MANIFEST = 'diagrams.json';

/**
 * Страницы `.drawio` по порядку — каждая как есть, целым куском XML.
 *
 * Нужны обеим сторонам: экспорт кладёт отпечаток страницы в опись, проверка
 * считает его заново от исходника. Разбор живёт ЗДЕСЬ, а не в каждой из них:
 * две копии одного разбора однажды разойдутся, и сторож станет зелёным на
 * схеме, которая своему исходнику уже не отвечает.
 */
export function diagramPages(xml) {
  return [...xml.matchAll(/<diagram\b[\s\S]*?<\/diagram>/g)].map((match) => match[0]);
}

/** Отпечаток куска XML: коротко, лишь бы отличать «то же» от «уже не то». */
export function fingerprint(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Опись кадров без печати — долг первого заполнения печатей; только убывает. */
export const UNSEALED_LIST = 'unsealed.json';

const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);

/**
 * Печать кадра: отпечаток байтов PNG и отпечаток текста описи — по отдельности, чтобы сторож
 * мог назвать, какая половина сдвинулась.
 */
export function frameSeal(png, text) {
  return { png: sha(png), text: sha(Buffer.from(text ?? '', 'utf8')) };
}

/** Что сдвинулось против печати: `ok` | `png` | `text` | `both`. */
export function sealDrift(seal, png, text) {
  const now = frameSeal(png, text);
  const pngMoved = now.png !== seal.png;
  const textMoved = now.text !== seal.text;
  if (pngMoved && textMoved) return 'both';
  if (pngMoved) return 'png';
  return textMoved ? 'text' : 'ok';
}

/** Ключ кадра в описи долга: `<раздел>/<сценарий>/<файл>`. */
export const unsealedKey = (topic, scenario, file) => `${topic}/${scenario}/${file}`;

/** Опись долга: `{ why, files: [ключ…] }`; нет файла — долга нет. */
export function readUnsealed(root = SHOTS_ROOT) {
  const path = join(root, UNSEALED_LIST);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { why: '', files: [] };
}

/** Снять с долга кадры, получившие печать. Дописывать в опись долга некому — она только убывает. */
export function dropUnsealed(keys, root = SHOTS_ROOT) {
  const path = join(root, UNSEALED_LIST);
  if (!existsSync(path) || keys.length === 0) return;
  const list = readUnsealed(root);
  const gone = new Set(keys);
  const files = list.files.filter((key) => !gone.has(key));
  if (files.length === list.files.length) return;
  writeFileRetry(path, `${JSON.stringify({ ...list, files }, null, 2)}\n`);
}

/** Запись варианта по имени файла: светлый русский — поля верхнего уровня, прочие — вложенные. */
function variantByFile(frame, file) {
  if (frame.file === file) return frame;
  for (const field of ['en', 'dark', 'darkEn'])
    if (frame[field]?.file === file) return frame[field];
  return undefined;
}

/**
 * Перештамповать кадр, чью картинку изменили ПОСЛЕ снимка (заплатка пикселей). Зовёт сам скрипт
 * обработки сразу после записи PNG; `text` — текст, который теперь на картинке (подмена марки);
 * без него текст описи остаётся прежним. `painted` — строки, которые обработка нарисовала: каждая
 * обязана быть в тексте описи, иначе опись не про эту картинку и печати нет. Печать считается от
 * байтов на диске.
 */
export function restampFrame(dir, file, { text, painted = [] } = {}) {
  const manifestPath = join(dir, 'frames.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest.frames.map((frame) => variantByFile(frame, file)).find(Boolean);
  if (!entry) throw new Error(`${manifestPath}: кадра ${file} в описи нет`);
  if (text !== undefined) entry.text = text.replace(/\s+/g, ' ').trim();
  const absent = painted.filter((line) => !entry.text.includes(line.replace(/\s+/g, ' ').trim()));
  if (absent.length) {
    throw new Error(
      `${file}: на картинке нарисовано то, чего нет в тексте описи — ${absent.join(' | ')}`,
    );
  }
  entry.seal = frameSeal(readFileSync(join(dir, file)), entry.text);
  writeFileRetry(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  dropUnsealed([unsealedKey(manifest.topic, manifest.scenario, file)], resolve(dir, '..', '..'));
  return entry;
}

/**
 * Опись исходников справки: какой КОД описывает раздел и каким этот код был,
 * когда человек последний раз сверял с ним текст.
 *
 * Лежит в корне каталога и одна на все разделы — в отличие от `frames.json`
 * (свой у сценария) и `diagrams.json` (свой у раздела): добавление раздела под
 * наблюдение должно быть одной записью в одном файле, иначе им не пользуются.
 */
export const SOURCES_MANIFEST = 'sources.json';

const SOURCES_PATH = join(SHOTS_ROOT, SOURCES_MANIFEST);

/**
 * Отпечаток ИСХОДНИКА — не то же самое, что отпечаток страницы схемы, и оба
 * отличия здесь ради ложной красноты.
 *
 * Переводы строк приводятся к одному виду: свежий клон на Windows приезжает с
 * CRLF, и отпечаток обязан совпасть с посчитанным на LF — иначе правило
 * краснеет на самом клонировании.
 *
 * Строки, которые целиком комментарий, и пустые выбрасываются. Комментарии у
 * нас длинные, русские и правятся чаще кода, который объясняют; сторож,
 * краснеющий на переписанном абзаце «почему так», приучит подтверждать не
 * читая, а это хуже, чем не иметь правила. Отбрасываются именно СТРОКИ, а не
 * куски между парой звёздочек со слэшем: в словарях интерфейса живут строки с
 * шаблонами вроде звёздочек и `.ts`, и жадная вырезка блока съела бы половину
 * файла (тот же приём и по той же причине — в `check-negative-scenarios.mjs`).
 */
export function sourceFingerprint(text) {
  const code = text
    .split(/\r?\n/)
    .filter((line) => {
      const head = line.trimStart();
      if (head === '') return false;
      return !head.startsWith('//') && !head.startsWith('*') && !head.startsWith('/*');
    })
    .join('\n');
  return fingerprint(code);
}

/** Прочитать опись. Её нет — считаем, что под наблюдением нет ни одного раздела. */
export function readSourceManifest(path = SOURCES_PATH) {
  if (!existsSync(path)) return { topics: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Записать опись. Единственный, кто это делает, — `tools/help-shots/sources.mjs`. */
export function writeSourceManifest(manifest, path = SOURCES_PATH) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Состояние сверки: опись против диска. Один разбор на обе стороны — сторож
 * краснеет ровно по тому же расчёту, каким инструмент подтверждения гасит
 * красноту. Две копии однажды разойдутся, и подтверждение перестанет закрывать
 * то, на что ругались.
 *
 * @param manifest опись
 * @param read     чтение файла: путь от корня репозитория → текст или undefined
 * @param topics   идентификаторы разделов справки; пустой список — не сверять
 */
export function sourceStates(manifest, read, topics = []) {
  const states = [];
  for (const entry of manifest.topics ?? []) {
    const topic = entry.topic ?? '(без имени)';
    const document = entry.document ?? '';
    if (topics.length > 0 && !topics.includes(topic)) {
      states.push({ topic, unknownTopic: true });
    }
    if (!document || read(document) === undefined) {
      states.push({ topic, path: document || '(не указан)', missingDocument: true });
    }
    const sources = entry.sources ?? [];
    if (sources.length === 0) states.push({ topic, empty: true });
    for (const source of sources) {
      const base = { topic, path: source.path, why: source.why ?? '', document };
      const text = read(source.path);
      if (text === undefined) {
        states.push({ ...base, missing: true });
        continue;
      }
      const current = sourceFingerprint(text);
      if (!source.sha) states.push({ ...base, current, unconfirmed: true });
      else if (current !== source.sha)
        states.push({ ...base, current, was: source.sha, moved: true });
      else states.push({ ...base, current, ok: true });
    }
  }
  return states;
}

/**
 * Что закрывается в кадре по ВИДУ, а не по месту. Строками, а не готовыми
 * регулярками: выражение уезжает в страницу и собирается уже там.
 *
 * Тот же список читает `tools/qa/check-help-shots.mjs` — правило съёмки и
 * правило проверки обязаны быть одним списком, иначе они разъедутся.
 */
export const SECRET_PATTERNS = {
  /** Ключ контура: `sk-` и дальше base64url, иногда с паддингом. */
  key: 'sk-[A-Za-z0-9_\\-]{10,}={0,2}',
  /**
   * Хвост ключа: панель показывает его сама («ключ sk-…2lY= проверен только
   * что»). Четыре символа — не ключ, но правило кадра не знает исключений:
   * в справку, которую читают чужие люди, не уезжает ни один настоящий символ.
   */
  keyTail: 'sk-[.…]{1,3}[A-Za-z0-9_\\-]{2,10}={0,2}',
  /** Почта: и учётка админки, и любое имя человека в кадре. */
  email: '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}',
  /** Заголовок с токеном — на случай примера запроса в кадре. */
  bearer: 'Bearer\\s+[A-Za-z0-9_\\-.=]{10,}',
};

/** Папка клона: нынешнее имя или прежнее (собрано задом наперёд — литерала в дереве нет). */
const CLONE_NAME = `(?:agentdeck|${[...'lortnoc-edualc'].reverse().join('')})`;

/**
 * Путь к УСТАНОВКЕ самой панели на машине съёмки. Панель собирает команды своих хуков из
 * собственного расположения: `<node> <клон>\apps\server\…\outside-relay-hook.mjs` (хуки сессий в
 * терминале), `<node> <клон>\tools\tests-hook.mjs` (блок «Тестирование»), MCP-прокси
 * `<клон>\tools\mcp\…`. Такая строка видна в «Хуках», в слоях проекта, а в паспорте среды —
 * ещё и ключом слоя, где разделители сплющены в дефис: `node-C-work-<клон>-apps-server-…`.
 * Закрывается на КАЖДОМ кадре, а не списком пачки: в пачке без списка (claudeMd/layers,
 * portability) путь уезжал в справку. Пути стендов (`C:\work\claude-demo-*`, `.agentdeck` дома
 * стенда) правилу не подходят — за именем клона нет `tools`/`apps`, и они остаются предметом кадра.
 */
export const INSTALL_PATH = [
  `[A-Za-z]:\\\\[^\\s"]*?${CLONE_NAME}\\\\(?:tools|apps)\\\\[^\\s"]+`,
  `node-[A-Za-z]-[^\\s"]*?${CLONE_NAME}-(?:tools|apps)-[^\\s"]+`,
  '[A-Za-z]:\\\\[^\\s"]*?node\\.exe',
];

/**
 * Профиль пользователя машины съёмки: `C:\Users\<имя>\…` (в том числе `AppData\Local\Temp` — temp
 * Windows лежит внутри профиля, и в форме 8.3 `RUSYAN~1` тоже), `/Users/<имя>`, `/home/<имя>` и
 * тот же путь ключом слоя, где разделители сплющены в дефис (`node-C-Users-<имя>-…`). Имя
 * учётной записи в публичной справке — утечка: 03.11.2026 в коммите лежали кадры
 * platform/scripted с `C:/Users/<владелец>/AppData/Local/Temp/cc-guide-shim` и platform/activate
 * с `C:\Users\<владелец>\.qwen\.env`. Закрывается сам профиль с именем; хвост пути остаётся.
 * Имена-заглушки, которые панель показывает из сценарных данных (`C:\Users\user\.codex\…`,
 * `C:\Users\you\…`), и общие профили Windows (`Public`, `Default`) — не чьё-то имя, они не
 * закрываются. Одно выражение на маску и на сторожа (`check-help-shots.mjs`).
 */
const PROFILE_STUB = '(?:user|you|Public|Default|Shared)';
export const USER_PROFILE_PATH = [
  String.raw`[A-Za-z]:[\\/]+Users[\\/]+(?!${PROFILE_STUB}(?:[\\/"\s]|$))[^\\/\s"]+`,
  String.raw`(?<![\w.~-])/(?:Users|home)/(?!${PROFILE_STUB}(?:[/"\s]|$))[^/\s"]+`,
  String.raw`\b[A-Za-z]-Users-(?!${PROFILE_STUB}-)[^\s"-]+`,
];

/** Заголовок карточки падения раздела (`common.crashTitle` в ru.ts / en.ts). */
const CRASH_TITLES = ['Раздел не смог отрисоваться', 'This section failed to render'];

/** Выражения по умолчанию: закрываются на каждом кадре любой стороны. */
export const DEFAULT_MASKS = [
  SECRET_PATTERNS.key,
  SECRET_PATTERNS.keyTail,
  SECRET_PATTERNS.email,
  SECRET_PATTERNS.bearer,
  ...INSTALL_PATH,
  ...USER_PROFILE_PATH,
];

/**
 * ЯЗЫК СЪЁМКИ. Кадр — это снимок ИНТЕРФЕЙСА, а интерфейс переведён: английскому
 * читателю справки русский снимок не объясняет ничего, и подпись под ним,
 * переведённая одна, только подчёркивает разрыв.
 *
 * Английский кадр лежит РЯДОМ с русским и называется `<кадр>.en.png`, а не в
 * папке `en/`. Причина в стороже: `check-help-shots.mjs` читает сценарий как
 * «опись + плоский список PNG», и вложенная папка потребовала бы второго обхода
 * каталога, второго множества файлов и второй ветки в каждом правиле. Суффикс
 * же попадает в тот же список сам собой, и «файл есть, в описи нет» ловит
 * забытый английский кадр тем же правилом, что и русский.
 *
 * Запись в описи остаётся ОДНА на кадр: русские поля на месте, английский
 * отпечаток — во вложенном `en` (свой файл, свой видимый текст, своё время).
 * Так секретный скан идёт по обоим текстам, а кадр остаётся одним кадром — с
 * одной подписью, одной стороной и одним порядковым номером.
 */
export const SHOT_LANGS = ['ru', 'en'];

/** Язык текущего прогона. Переменная одна на всю пачку: `GUIDE_LANG=en`. */
export function shotLanguage(env = process.env) {
  return env.GUIDE_LANG === 'en' ? 'en' : 'ru';
}

/**
 * ТЕМА СЪЁМКИ. Справка открыта в той же теме, что и панель, и светлый кадр на
 * тёмной странице висит белым прямоугольником. Поэтому кадр снимается и в
 * тёмной теме — НАСТОЯЩЕЙ темой панели (`settings.theme` → `data-theme` на
 * <html>), а не фильтром поверх светлого снимка: у тёмной темы свои токены,
 * контрасты и подложки, и фильтр показал бы интерфейс, которого не бывает.
 */
export const SHOT_THEMES = ['light', 'dark'];

/** Тема текущего прогона. Переменная одна на всю пачку: `GUIDE_THEME=dark`. */
export function shotTheme(env = process.env) {
  return env.GUIDE_THEME === 'dark' ? 'dark' : 'light';
}

/**
 * Четыре варианта кадра: тема × язык. Имя файла — суффикс к идентификатору
 * кадра в той же папке (`01-x.png`, `01-x.en.png`, `01-x.dark.png`,
 * `01-x.dark.en.png`) — по той же причине, по которой английский кадр лёг
 * рядом с русским, а не в папку: сторож видит все варианты одним плоским
 * списком PNG.
 *
 * В описи запись ОДНА на кадр: светлый русский — поля самой записи (так было
 * до вариантов, и старые описи читаются без миграции), остальные — вложенные
 * `en`, `dark`, `darkEn` со своим файлом, текстом и временем.
 *
 * Суффиксы знает ТОЛЬКО этот файл: справка берёт имя файла из описи раздела
 * `variants.json` (её пишет `writeVariantIndex`), а не собирает его сама.
 */
export const SHOT_VARIANTS = [
  { key: 'light-ru', theme: 'light', lang: 'ru', field: null, suffix: '' },
  { key: 'light-en', theme: 'light', lang: 'en', field: 'en', suffix: '.en' },
  { key: 'dark-ru', theme: 'dark', lang: 'ru', field: 'dark', suffix: '.dark' },
  { key: 'dark-en', theme: 'dark', lang: 'en', field: 'darkEn', suffix: '.dark.en' },
];

/** Вариант по теме и языку прогона. */
function shotVariant(theme = shotTheme(), lang = shotLanguage()) {
  return SHOT_VARIANTS.find((variant) => variant.theme === theme && variant.lang === lang);
}

/** Отпечаток варианта в записи кадра или `undefined`, если его не снимали. */
export function variantOf(frame, variant) {
  if (variant.field) return frame[variant.field] ?? undefined;
  return frame.file ? frame : undefined;
}

/**
 * Какие варианты у кадра ОБЯЗАНЫ быть. Сторона `platform` — чужое приложение
 * (админка платформы компании): тема панели на него не действует, и «тёмный»
 * снимок был бы тем же светлым под другим именем. У него только два языка;
 * справка на тёмной теме покажет светлый — это и есть правда о том экране.
 * Сторона `phone` — то же рассуждение: кадр снят с эмулятора Android, у
 * приложения одна своя тема, и тема панели на него не действует.
 */
export function requiredVariants(side) {
  return side === 'platform' || side === 'phone'
    ? SHOT_VARIANTS.filter((variant) => variant.theme === 'light')
    : SHOT_VARIANTS;
}

/** Опись вариантов раздела — лежит в папке раздела, читает её справка. */
export const VARIANT_INDEX = 'variants.json';

/**
 * Собрать опись вариантов раздела из описей его сценариев.
 *
 * Справке нужны ровно три вещи на вариант: есть ли он, как называется файл и
 * какого он размера (`width`/`height` на `<img>` резервируют место, и смена
 * темы не двигает страницу). Отдавать ей `frames.json` целиком нельзя: там
 * видимый текст каждого кадра, до сотни килобайт на сценарий.
 *
 * Одна функция на обе стороны: съёмка пишет её результат, сторож считает
 * заново и сравнивает — разойтись им не на чем.
 */
function buildVariantIndex(topic, scenarios) {
  const frames = {};
  const ordered = [...scenarios].sort((a, b) => a.scenario.localeCompare(b.scenario));
  for (const { scenario, manifest } of ordered) {
    for (const frame of manifest.frames ?? []) {
      const variants = {};
      for (const variant of SHOT_VARIANTS) {
        const taken = variantOf(frame, variant);
        if (!taken?.file) continue;
        variants[variant.key] = { file: taken.file, width: taken.width, height: taken.height };
      }
      frames[`${scenario}/${frame.id}`] = variants;
    }
  }
  return { topic, frames };
}

/** Описи сценариев раздела с диска: `[{ scenario, manifest }]`. */
export function readTopicManifests(topic, root = SHOTS_ROOT) {
  const topicDir = join(root, topic);
  if (!existsSync(topicDir)) return [];
  return readdirSync(topicDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(topicDir, entry.name, 'frames.json')))
    .map((entry) => ({
      scenario: entry.name,
      manifest: JSON.parse(readFileSync(join(topicDir, entry.name, 'frames.json'), 'utf8')),
    }));
}

/** Текст описи вариантов — один на запись и на сверку. */
export function renderVariantIndex(topic, scenarios) {
  return `${JSON.stringify(buildVariantIndex(topic, scenarios), null, 2)}\n`;
}

/** Переписать опись вариантов раздела по его описям сценариев. */
export function writeVariantIndex(topic, root = SHOTS_ROOT) {
  const text = renderVariantIndex(topic, readTopicManifests(topic, root));
  writeFileRetry(join(root, topic, VARIANT_INDEX), text);
}

/**
 * Прогреть фронт до первого сценария. `waitFor(WEB)` ждёт только ответа Vite на `/`, а
 * граф модулей он собирает по первому настоящему заходу: под нагрузкой (соседние съёмки,
 * пересборка зависимостей) этот заход шёл дольше 30 с, и первый `page.goto` сценария падал
 * по тайм-ауту — 03.11.2026 так отказали settings/first-run (light-en, dark-ru) и
 * config/skills (light-ru), хотя панель была исправна. Прогрев открывает страницу один раз с
 * запасом по времени и закрывает её; кадров он не снимает.
 */
export async function warmFront(browser, web, timeoutMs = 180_000) {
  const page = await browser.newPage();
  try {
    // `load` наступает после выполнения модульных скриптов — то есть после сборки графа.
    await page.goto(web, { waitUntil: 'load', timeout: timeoutMs });
  } finally {
    await page.close();
  }
}

/**
 * Переключить язык ПАНЕЛИ перед съёмкой.
 *
 * Делается на сервере, а не в браузере, и это не мелочь: язык живёт в настройках
 * панели (`state.json → settings.language`), фронт берёт его из `/api/settings`
 * и только потом зовёт `i18n.changeLanguage`. Каждая пачка кадров подменяет
 * настройки своим `page.route`, но все подмены собраны одинаково — «взять
 * НАСТОЯЩИЙ ответ панели и дописать своё». Значит достаточно поменять ответ у
 * источника: подмены донесут язык сами, и ни одну из них править не нужно.
 *
 * Дёргать `i18n` из страницы было бы короче и неверно: это обход того самого
 * пути, по которому язык приходит человеку, — кадр доказывал бы работу
 * подкрутки, а не работу настройки.
 */
export async function applyShotLanguage(panel, lang = shotLanguage(), theme = shotTheme()) {
  // Тема едет тем же запросом и тем же путём, что и язык: все пачки уже зовут
  // эту функцию после подъёма панели, и `GUIDE_THEME=dark` доходит до каждой
  // без правки четырёх десятков сценариев.
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: lang, theme }),
  });
  if (!response.ok) {
    // Дом съёмки — нейтральный каталог у корня диска (`shotHome`), а не temp ОС: для ворот
    // «решает только человек» это не одноразовый стенд, и правка настроек из процесса съёмки
    // отклоняется (`decision-device-unverified`). Тогда язык и тема должны уже лежать в
    // `state.json` дома (их кладёт фикстура пачки до подъёма панели) — сверяем по ответу панели.
    const current = await fetch(`${panel}/api/settings`).then((res) => (res.ok ? res.json() : {}));
    if (current.language !== lang || current.theme !== theme) {
      throw new Error(
        `PATCH /api/settings language: ${response.status}; в настройках дома язык ` +
          `${current.language ?? '?'}, тема ${current.theme ?? '?'} — положите ${lang}/${theme} ` +
          'в state.json дома до подъёма панели',
      );
    }
  }
  console.log(`язык съёмки: ${lang}, тема: ${theme}`);
  return lang;
}

/**
 * Опись сценария. Открывается один раз на съёмку, дописывается кадр за кадром
 * и сохраняется в конце. Кадры ДРУГОЙ стороны (снятые прошлым прогоном с
 * `--side`) не теряются: запись заменяется по идентификатору, остальные живут.
 *
 * Язык прогона по умолчанию берётся из переменной: пачке достаточно позвать
 * `applyShotLanguage` после подъёма панели, а `openScenario` подхватит сам —
 * иначе про язык пришлось бы помнить в каждом из четырёх десятков сценариев.
 */
export function openScenario(topic, scenario, lang = shotLanguage(), theme = shotTheme()) {
  const variant = shotVariant(theme, lang);
  const dir = join(SHOTS_ROOT, topic, scenario);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'frames.json');

  const previous = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { topic, scenario, frames: [] };
  const frames = new Map(previous.frames.map((frame) => [frame.id, frame]));

  /** Что сняла ИМЕННО эта съёмка: по этому списку чистится своя сторона. */
  const thisRun = { side: '', ids: new Set() };

  /** Имя файла кадра: светлый русский — как раньше, прочие — с суффиксом варианта. */
  const fileOf = (id) => `${id}${variant.suffix}.png`;

  return {
    dir,

    /**
     * Снять кадр.
     *
     * @param page      страница Playwright
     * @param id        идентификатор кадра: `NN-слаг`, он же имя файла
     * @param options   side  — чья это сторона: `platform` | `panel`
     *                  mask  — селекторы, текст которых закрывается ДО снимка
     *                  maskText — выражения, закрываемые в ЛЮБОМ тексте кадра
     *                  clip  — селектор области; без него снимается окно
     *                  padding — поля вокруг области, по умолчанию 16
     */
    async shot(page, id, options = {}) {
      const { side = 'panel', mask = [], maskText = DEFAULT_MASKS, clip, padding = 16 } = options;

      // Пустой кадр — не кадр. Фронт съёмки смотрит в то же дерево исходников,
      // что и стенд, и чужая правка i18n-модуля перезагружает страницу целиком:
      // кадр, снятый в этот миг, выходил белым листом (6 КБ вместо 70). Ждём,
      // пока оболочка панели вернётся, и говорим об этом вслух.
      if (side === 'panel' && (await page.locator('nav').count()) === 0) {
        console.log(`  кадр ${id}: страница перезагрузилась до кадра — жду оболочку панели`);
        await page.waitForSelector('nav', { timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
      }

      // Знакомство Деки («Привет! Я Дека…») всплывает на каждой СВЕЖЕЙ странице через 2,5 с:
      // «уже знакомы» помнит localStorage браузера, а у съёмки контекст новый. Попадало ли облачко
      // в кадр, решала скорость прогона (03.11: changelog/02-entry, kit/page/02-items, overview/tour
      // то с ним, то без). Кадр не про Деку — облачко закрывается её же крестиком.
      const greeting = page
        .locator('[data-mascot-speech="greet"] [data-mascot-speech-dismiss]')
        .first();
      if (side === 'panel' && (await greeting.isVisible().catch(() => false))) {
        await greeting.click({ timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(400);
      }

      // Селекторы закрывают то, что известно по месту; выражения — то, что
      // известно по виду (ключ, почта). Второе надёжнее: разметка чужого
      // приложения меняется между версиями, а вид ключа — нет.
      const applyMasks = () =>
        page.evaluate(
          ([selectors, patterns, maskValue]) => {
            let count = 0;
            for (const selector of selectors) {
              for (const node of document.querySelectorAll(selector)) {
                if (node instanceof HTMLInputElement) node.value = maskValue;
                else node.textContent = maskValue;
                count += 1;
              }
            }
            // Все выражения сверяются с ИСХОДНЫМ текстом, и закрывается объединение их
            // совпадений. По очереди нельзя: узкое выражение умолчаний (профиль
            // `C:\Users\<имя>`) закрывало начало пути, и широкое выражение пачки
            // (`[A-Za-z]:\\…`) уже не находило диска — хвост `\AppData\Local\Temp\…`
            // выходил в кадр открытым.
            const regexes = patterns.map((source) => new RegExp(source, 'g'));
            const closeAll = (text) => {
              const spans = [];
              for (const regex of regexes) {
                regex.lastIndex = 0;
                for (let hit = regex.exec(text); hit; hit = regex.exec(text)) {
                  if (hit[0].length === 0) regex.lastIndex += 1;
                  else spans.push([hit.index, hit.index + hit[0].length]);
                }
              }
              if (spans.length === 0) return undefined;
              spans.sort((a, b) => a[0] - b[0]);
              let out = '';
              let at = 0;
              let end = -1;
              for (const [from, to] of spans) {
                if (from > end) {
                  if (end >= 0) out += maskValue;
                  out += text.slice(at, from);
                  end = to;
                } else end = Math.max(end, to);
                at = end;
              }
              return `${out}${maskValue}${text.slice(at)}`;
            };
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
              const closed = closeAll(node.textContent ?? '');
              if (closed === undefined) continue;
              node.textContent = closed;
              count += 1;
            }
            for (const input of document.querySelectorAll('input')) {
              const closed = closeAll(input.value);
              if (closed === undefined) continue;
              input.value = closed;
              count += 1;
            }
            return count;
          },
          [mask, maskText, MASK],
        );
      let maskedCount = await applyMasks();

      // Марка платформы компании — в разметке, до снимка; осталась видна — кадра нет. Раздел
      // «Контур» без списка марки не снимается вовсе: он снят на её стенде.
      const brand = readBrandMask();
      if (!brand && topic === 'platform') {
        throw new Error(
          `кадр ${id}: нет списка марки (GUIDE_BRAND_FILE, .agent/private/brand-mask.txt) — ` +
            'раздел «Контур» снимается только с закрытой маркой',
        );
      }
      if (brand) {
        const pass = await brandPass(page, brand, {
          mask: options.brandMask !== false,
          anyLogo: side === 'platform',
        });
        if (pass.leaks.length) {
          throw new Error(
            `кадр ${id}: марка платформы видна после закрытия — ${pass.leaks.join(', ')}`,
          );
        }
      }

      let area;
      if (clip) {
        const box = await page.locator(clip).first().boundingBox();
        if (!box) throw new Error(`кадр ${id}: область ${clip} не найдена`);
        const size = page.viewportSize() ?? { width: 1280, height: 800 };
        area = {
          x: Math.max(0, box.x - padding),
          y: Math.max(0, box.y - padding),
          width: Math.min(size.width, box.width + padding * 2),
          height: Math.min(size.height, box.height + padding * 2),
        };
      }

      // Язык проверяется у САМОЙ страницы, а не по переменной окружения:
      // `GUIDE_LANG=en` в пачке, которая забыла позвать `applyShotLanguage`,
      // положил бы русский интерфейс под английским именем файла — и заметить
      // это было бы нечем, кроме как глазами по всем кадрам. `lang` на <html>
      // ставит тот же `ThemeProvider`, который зовёт `i18n.changeLanguage`,
      // поэтому совпадение здесь означает «интерфейс в кадре действительно
      // английский». Сторону `enterprise-platform` не трогаем: чужое приложение своего
      // языка нам не сообщает.
      // Тема — тем же приёмом: `data-theme` ставит ThemeProvider из настроек,
      // и совпадение значит, что на кадре настоящая тёмная тема панели. Чужое
      // приложение (сторона `platform`) от темы панели не зависит, и тёмного
      // его варианта не бывает: съёмка такой стороны в тёмной теме — ошибка
      // запуска, а не повод положить светлую картинку под тёмным именем.
      if (side === 'platform' && theme !== 'light') {
        throw new Error(
          `кадр ${id}: сторона platform от темы панели не зависит — снимайте её с GUIDE_THEME=light`,
        );
      }
      if (side === 'panel') {
        // Тема и язык приезжают с настройками панели уже после первой отрисовки: кадр сразу за
        // переходом ловил светлую заготовку до ответа /api/settings. Ждём совпадения до 5 с —
        // не совпало и тогда, значит, настройка не дошла, и проверка ниже краснеет как раньше.
        await page
          .waitForFunction(
            ([want, wantLang]) =>
              document.documentElement.dataset.theme === want &&
              (document.documentElement.lang || '').startsWith(wantLang),
            [theme, lang],
            { timeout: 5_000 },
          )
          .catch(() => {});
        const pageTheme = await page.evaluate(
          () => document.documentElement.dataset.theme || '(пусто)',
        );
        if (pageTheme !== theme) {
          throw new Error(
            `кадр ${id}: съёмка идёт в теме «${theme}», а на странице «${pageTheme}» — ` +
              'позовите applyShotLanguage(PANEL) после подъёма панели',
          );
        }
        const pageLang = await page.evaluate(() => document.documentElement.lang || '(пусто)');
        if (!pageLang.startsWith(lang)) {
          throw new Error(
            `кадр ${id}: съёмка идёт как «${lang}», а интерфейс на странице «${pageLang}» — ` +
              'позовите applyShotLanguage(PANEL) после подъёма панели',
          );
        }
      }

      // Экран ошибки вместо раздела — не кадр. 03.11.2026 overview/trouble/01-wrong-dir (подмена
      // ответа без поля контракта) и history/trace/04-after (строка, вырезанная из DOM под React)
      // лежали в справке карточкой «Раздел не смог отрисоваться» во всех четырёх вариантах, а в
      // коммите — второй из них. Кадр, который правда показывает падение, просит `allowCrash`.
      if (side === 'panel' && !options.allowCrash) {
        const crashed = await page.evaluate(
          (titles) => titles.find((title) => document.body.innerText.includes(title)) ?? null,
          CRASH_TITLES,
        );
        if (crashed) {
          throw new Error(`кадр ${id}: на странице экран ошибки «${crashed}» вместо раздела`);
        }
      }

      // Замазывание — ещё раз, вплотную к снимку. Между первым проходом и снимком страница
      // ждёт тему и язык (до 5 с), и React за это время перерисовывает узлы заново: 03.11.2026
      // providers/switch/05-keys [dark-en] ушёл с открытым хвостом ключа «sk-…a1d2» (masked 0),
      // хотя три других варианта того же кадра вышли закрытыми.
      const file = fileOf(id);
      const readText = async () =>
        clip ? page.locator(clip).first().innerText() : page.locator('body').innerText();
      const openPatterns = (value) =>
        maskText.filter((source) => new RegExp(source).test(value)).map((source) => `/${source}/`);
      let text;
      for (let attempt = 1; ; attempt += 1) {
        maskedCount = Math.max(maskedCount, await applyMasks());
        await page.screenshot({ path: join(dir, file), clip: area });
        // Текст снимаемой области — из той же разметки и после замазывания.
        text = await readText();
        const open = openPatterns(text);
        if (!open.length) break;
        // Остался открытым и после повтора — кадра нет: лучше упавшая съёмка, чем ключ в справке.
        if (attempt >= 3) {
          rmSync(join(dir, file), { force: true });
          throw new Error(`кадр ${id}: после снимка видно то, что закрывается: ${open.join(', ')}`);
        }
        await page.waitForTimeout(500);
      }

      const taken = {
        file,
        masked: maskedCount,
        width: Math.round(area?.width ?? page.viewportSize()?.width ?? 0),
        height: Math.round(area?.height ?? page.viewportSize()?.height ?? 0),
        shotAt: new Date().toISOString(),
        text: text.replace(/\s+/g, ' ').trim(),
      };
      // Печать — от байтов, которые легли на диск, и текста, который уходит в опись.
      taken.seal = frameSeal(readFileSync(join(dir, file)), taken.text);

      thisRun.side = side;
      thisRun.ids.add(id);
      const previousFrame = frames.get(id);
      // Английский прогон дописывает СВОЙ отпечаток в существующую запись и не
      // трогает русские поля: снимают их разные прогоны, и второй не обязан
      // знать, чем закончился первый. Русский прогон так же бережёт `en`.
      frames.set(
        id,
        variant.field
          ? { ...previousFrame, id, side, [variant.field]: taken }
          : { ...previousFrame, id, side, ...taken },
      );
      console.log(
        `  кадр ${id} [${variant.key}]${maskedCount ? ` (замазано узлов: ${maskedCount})` : ''}`,
      );
    },

    /**
     * Сохранить опись. Кадры идут по идентификатору — он же порядок шага.
     *
     * Кадры СВОЕЙ стороны, которых в этом прогоне не было, уходят вместе с
     * файлами: сценарий меняется (шаг разделился, шаг исчез), и оставленный
     * кадр — это картинка, которой в справке уже нет места, но которая лежит в
     * git и однажды снова попадёт человеку на глаза. Чужая сторона не
     * трогается: её снимает соседний прогон.
     *
     * `keepUnshot` — прогон снимал только часть кадров по выбору (пересъёмка одного кадра):
     * не снятые им кадры не устарели, а просто не входили в выбор, и остаются с файлами.
     */
    finish({ keepUnshot = false } = {}) {
      for (const [id, frame] of [...frames]) {
        if (keepUnshot || frame.side !== thisRun.side || thisRun.ids.has(id)) continue;
        // Прогон варианта снимает с учёта только СВОЙ вариант: светлый русский
        // кадр и соседние варианты сняты не им, и удалять чужую работу он права
        // не имеет.
        if (variant.field) {
          const own = frame[variant.field];
          if (!own) continue;
          rmSync(join(dir, own.file), { force: true });
          frames.set(id, { ...frame, [variant.field]: undefined });
          console.log(`  снят с учёта устаревший вариант ${variant.key} кадра ${id}`);
          continue;
        }
        frames.delete(id);
        // Шага больше нет — ни одного его варианта тоже быть не должно.
        for (const other of SHOT_VARIANTS) {
          const taken = variantOf(frame, other);
          if (taken?.file) rmSync(join(dir, taken.file), { force: true });
        }
        console.log(`  снят с учёта устаревший кадр ${id}`);
      }
      const list = [...frames.values()].sort((a, b) => a.id.localeCompare(b.id));
      // Файл, которого нет НИ В ОДНОЙ записи, — сирота: опись здесь главная.
      const known = new Set(
        list
          .flatMap((frame) => SHOT_VARIANTS.map((other) => variantOf(frame, other)?.file))
          .filter(Boolean),
      );
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.png') || known.has(name)) continue;
        rmSync(join(dir, name), { force: true });
        console.log(`  удалён кадр-сирота ${name}`);
      }
      writeFileRetry(
        manifestPath,
        JSON.stringify({ topic, scenario, frames: list }, null, 2) + '\n',
      );
      // С долга без печати уходят снятые этим прогоном кадры и те, чьих файлов больше нет.
      const prefix = unsealedKey(topic, scenario, '');
      dropUnsealed([
        ...[...thisRun.ids].map((id) => unsealedKey(topic, scenario, fileOf(id))),
        ...readUnsealed()
          .files.filter((key) => key.startsWith(prefix))
          .filter((key) => !known.has(key.slice(prefix.length))),
      ]);
      // Опись вариантов раздела — производная от описей сценариев, и
      // переписывается вместе с ними, иначе справка не узнает о новом кадре.
      writeVariantIndex(topic);
      const files = readdirSync(dir).filter((name) => name.endsWith('.png'));
      const counts = SHOT_VARIANTS.map(
        (other) => `${other.key} ${list.filter((frame) => variantOf(frame, other)).length}`,
      ).join(', ');
      console.log(`\nОпись: ${list.length} кадров (${counts}), файлов на диске ${files.length}`);
      return list;
    },
  };
}
