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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

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

/** Выражения по умолчанию: закрываются на каждом кадре любой стороны. */
export const DEFAULT_MASKS = [
  SECRET_PATTERNS.key,
  SECRET_PATTERNS.keyTail,
  SECRET_PATTERNS.email,
  SECRET_PATTERNS.bearer,
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
export async function applyShotLanguage(panel, lang = shotLanguage()) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: lang }),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings language: ${response.status}`);
  console.log(`язык съёмки: ${lang}`);
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
export function openScenario(topic, scenario, lang = shotLanguage()) {
  const dir = join(SHOTS_ROOT, topic, scenario);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'frames.json');

  const previous = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { topic, scenario, frames: [] };
  const frames = new Map(previous.frames.map((frame) => [frame.id, frame]));

  /** Что сняла ИМЕННО эта съёмка: по этому списку чистится своя сторона. */
  const thisRun = { side: '', ids: new Set() };

  /** Имя файла кадра: русский — как раньше, английский — с суффиксом. */
  const fileOf = (id) => (lang === 'en' ? `${id}.en.png` : `${id}.png`);

  return {
    dir,

    /**
     * Снять кадр.
     *
     * @param page      страница Playwright
     * @param id        идентификатор кадра: `NN-слаг`, он же имя файла
     * @param options   side  — чья это сторона: `enterprise-platform` | `panel`
     *                  mask  — селекторы, текст которых закрывается ДО снимка
     *                  maskText — выражения, закрываемые в ЛЮБОМ тексте кадра
     *                  clip  — селектор области; без него снимается окно
     *                  padding — поля вокруг области, по умолчанию 16
     */
    async shot(page, id, options = {}) {
      const { side = 'panel', mask = [], maskText = DEFAULT_MASKS, clip, padding = 16 } = options;

      // Селекторы закрывают то, что известно по месту; выражения — то, что
      // известно по виду (ключ, почта). Второе надёжнее: разметка чужого
      // приложения меняется между версиями, а вид ключа — нет.
      const maskedCount = await page.evaluate(
        ([selectors, patterns, maskValue]) => {
          let count = 0;
          for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
              if (node instanceof HTMLInputElement) node.value = maskValue;
              else node.textContent = maskValue;
              count += 1;
            }
          }
          for (const source of patterns) {
            const regex = new RegExp(source, 'g');
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const hits = [];
            while (walker.nextNode()) {
              if (regex.test(walker.currentNode.textContent ?? '')) hits.push(walker.currentNode);
              regex.lastIndex = 0;
            }
            for (const node of hits) {
              node.textContent = (node.textContent ?? '').replace(regex, maskValue);
              count += 1;
            }
            for (const input of document.querySelectorAll('input')) {
              if (regex.test(input.value)) {
                input.value = input.value.replace(regex, maskValue);
                count += 1;
              }
              regex.lastIndex = 0;
            }
          }
          return count;
        },
        [mask, maskText, MASK],
      );

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
      if (side === 'panel') {
        const pageLang = await page.evaluate(() => document.documentElement.lang || '(пусто)');
        if (!pageLang.startsWith(lang)) {
          throw new Error(
            `кадр ${id}: съёмка идёт как «${lang}», а интерфейс на странице «${pageLang}» — ` +
              'позовите applyShotLanguage(PANEL) после подъёма панели',
          );
        }
      }

      const file = fileOf(id);
      await page.screenshot({ path: join(dir, file), clip: area });

      // Текст снимаемой области — из той же разметки и после замазывания.
      const text = clip
        ? await page.locator(clip).first().innerText()
        : await page.locator('body').innerText();

      const taken = {
        file,
        masked: maskedCount,
        width: Math.round(area?.width ?? page.viewportSize()?.width ?? 0),
        height: Math.round(area?.height ?? page.viewportSize()?.height ?? 0),
        shotAt: new Date().toISOString(),
        text: text.replace(/\s+/g, ' ').trim(),
      };

      thisRun.side = side;
      thisRun.ids.add(id);
      const previousFrame = frames.get(id);
      // Английский прогон дописывает СВОЙ отпечаток в существующую запись и не
      // трогает русские поля: снимают их разные прогоны, и второй не обязан
      // знать, чем закончился первый. Русский прогон так же бережёт `en`.
      frames.set(
        id,
        lang === 'en'
          ? { ...previousFrame, id, side, en: taken }
          : { ...previousFrame, id, side, ...taken },
      );
      console.log(
        `  кадр ${id} [${lang}]${maskedCount ? ` (замазано узлов: ${maskedCount})` : ''}`,
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
     */
    finish() {
      for (const [id, frame] of [...frames]) {
        if (frame.side !== thisRun.side || thisRun.ids.has(id)) continue;
        // Английский прогон снимает с учёта только английский близнец: русский
        // кадр снят не им, и удалять чужую работу он права не имеет.
        if (lang === 'en') {
          if (!frame.en) continue;
          rmSync(join(dir, frame.en.file), { force: true });
          frames.set(id, { ...frame, en: undefined });
          console.log(`  снят с учёта устаревший английский кадр ${id}`);
          continue;
        }
        frames.delete(id);
        rmSync(join(dir, frame.file), { force: true });
        // Шага больше нет — английского его снимка тоже быть не должно.
        if (frame.en) rmSync(join(dir, frame.en.file), { force: true });
        console.log(`  снят с учёта устаревший кадр ${id}`);
      }
      const list = [...frames.values()].sort((a, b) => a.id.localeCompare(b.id));
      // Файл, которого нет НИ В ОДНОЙ записи, — сирота: опись здесь главная.
      const known = new Set(list.flatMap((frame) => [frame.file, frame.en?.file]).filter(Boolean));
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.png') || known.has(name)) continue;
        rmSync(join(dir, name), { force: true });
        console.log(`  удалён кадр-сирота ${name}`);
      }
      writeFileSync(
        manifestPath,
        JSON.stringify({ topic, scenario, frames: list }, null, 2) + '\n',
        'utf8',
      );
      const files = readdirSync(dir).filter((name) => name.endsWith('.png'));
      const english = list.filter((frame) => frame.en).length;
      console.log(
        `\nОпись: ${list.length} кадров (английских ${english}), файлов на диске ${files.length}`,
      );
      return list;
    },
  };
}
