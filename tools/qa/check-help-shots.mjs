/**
 * Каталог снимков справки: опись, ссылки и — главное — утечки.
 *
 * Требование задачи звучит так: «ни на одном снимке нет ключа, токена, чужого
 * домена и чужого имени — проверено прогоном, а не глазами». Глазами это и
 * нельзя проверить: текст внутри PNG не ищется, а кадров уже под два десятка и
 * будет больше. Поэтому съёмка (`tools/help-shots/kit.mjs`) кладёт рядом с
 * картинками опись `frames.json` с ВИДИМЫМ текстом кадра, снятым из той же
 * разметки и в тот же момент, а этот прогон ищет секреты в описи.
 *
 * Что проверяется:
 *
 *  1. Опись и диск сходятся: у каждой записи есть файл, у каждого файла запись.
 *  2. Каждый `<HelpShot>` в документах справки указывает на существующий кадр.
 *  3. Каждый кадр каталога кем-то показан. Кадр, на который никто не ссылается,
 *     — это мегабайты в git, которых человек никогда не увидит.
 *  4. В тексте кадра нет ключа, токена, почты, чужого домена и ни одного
 *     значения из `~/.agentdeck/*.env`. Значения читаются, но НИКОГДА не
 *     печатаются: в отчёте стоит имя переменной.
 *  5. У каждого кадра есть подпись в русском словаре справки.
 *  6. Схема не отстала от своего `.drawio`: рядом с картинками лежит опись
 *     `diagrams.json` с отпечатком страницы-исходника, и он считается заново.
 *     Правка в генераторе без пересъёмки — самая тихая порча справки: файл на
 *     месте, ссылка живая, подпись есть, а на картинке вчерашние цифры.
 *  7. Документ не отстал от КОДА, который описывает. То же рассуждение этажом
 *     выше: в `apps/web/public/help/sources.json` у раздела перечислены модули,
 *     несущие описанное поведение, и отпечаток каждого на момент последней
 *     сверки. Код изменился — сторож краснеет и называет раздел, файлы и
 *     команду. Гасится только руками: `node tools/help-shots/sources.mjs
 *     <раздел>` — это заявление человека, что он документ перечитал, и машине
 *     его не выдать.
 *
 * Граница честности названа прямо: проверка видит то, что было в РАЗМЕТКЕ
 * снимаемой области. Секрет, нарисованный на canvas или пришедший картинкой, в
 * опись не попадёт. Таких кадров у нас нет, и появиться они должны осознанно.
 *
 * Все образцы «секретов» в самопроверке ВЫМЫШЛЕНЫ и подобраны так, чтобы
 * подходить под выражение и при этом не быть ничьим настоящим ключом.
 *
 * Стенд не нужен: всё читается с диска.
 *
 * Запуск: `node tools/qa/check-help-shots.mjs` (`--selftest` — прогон самого
 * сторожа: он обязан краснеть на подложенной утечке).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SHOTS_ROOT,
  SECRET_PATTERNS,
  DIAGRAMS_MANIFEST,
  SOURCES_MANIFEST,
  diagramPages,
  fingerprint,
  readSourceManifest,
  sourceStates,
  sourceFingerprint,
} from '../help-shots/kit.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const TOPICS_DIR = join(ROOT, 'apps/web/src/pages/Help/topics');
const TOPICS_REGISTRY = join(ROOT, 'apps/web/src/pages/Help/model/topics.ts');
const RU_DICT_DIR = join(ROOT, 'apps/web/src/shared/config/i18n/help/ru/topics');
const SECRETS_DIR = join(homedir(), '.agentdeck');

/** Команда, которой человек гасит красноту раздела. Одна на весь файл. */
const confirmCommand = (topic) => `node tools/help-shots/sources.mjs ${topic}`;

/**
 * Чужой домен. Список доменов первого уровня узкий и нарочно: широкое правило
 * («что-то через точку») краснело бы на `host.docker.internal`, `api.localhost`
 * и `CLAUDE.md`, которые в кадрах законны. А ловить надо ровно одно — кадр,
 * переснятый не на локальном стенде, а на настоящем контуре заказчика.
 */
const FOREIGN_HOST = /\b[a-z0-9-]+\.(ai|com|ru|io|net|org|dev|cloud|app)\b/gi;

/**
 * Хосты вендора. Они приходят не с машины съёмки, а из СОБСТВЕННЫХ текстов
 * панели: каталог встроенных команд описывает `/design-login` словами «через
 * аккаунт claude.ai», и этот текст виден на любом стенде. Правило выше их
 * ловить не должно — иначе единственный способ снять список команд состоит в
 * том, чтобы замазать в нём кусок настоящего описания.
 *
 * Список закрытый, и взгляд назад обязателен: `my-claude.ai` — уже чужой хост,
 * и он по-прежнему краснеет.
 */
const VENDOR_HOST = /(?<![\w.-])(?:claude\.ai|anthropic\.com)\b/gi;

/** Выражения, по которым ищутся утечки в тексте кадра. Имя → выражение. */
const LEAK_PATTERNS = {
  'ключ контура': SECRET_PATTERNS.key,
  'хвост ключа': SECRET_PATTERNS.keyTail,
  почта: SECRET_PATTERNS.email,
  'заголовок с токеном': SECRET_PATTERNS.bearer,
};

/**
 * Значения из личного хранилища. Читаются, чтобы искать их в кадрах, и не
 * попадают ни в вывод, ни в исключение. Адреса пропускаются: `http://…` —
 * это не секрет, а то, что на снимке как раз должно быть видно.
 */
function readSecrets(dir = SECRETS_DIR) {
  const secrets = [];
  if (!existsSync(dir)) return secrets;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.env')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      // Короткое значение совпало бы со случайным словом кадра.
      if (value.length < 8 || /^https?:\/\//.test(value)) continue;
      secrets.push({ name: `${name}:${match[1]}`, value });
    }
  }
  return secrets;
}

/**
 * Подписи кадров ищутся текстом по словарю справки, а он разрезан по разделам:
 * `help/ru/topics/<раздел>.ts`. Склейка, а не один файл, — иначе кадр раздела,
 * чей модуль просто не прочитали, краснел бы как «без подписи».
 */
function readDictionary(dir = RU_DICT_DIR) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

/**
 * Папка схем внутри раздела. Сценарием не является: у схем нет описи с текстом
 * — их рисует генератор, а не браузер, и подглядеть в них секрет неоткуда.
 */
const DIAGRAMS = 'diagrams';

/** Прочитать каталог: `раздел → сценарий → опись + файлы`. */
function readCatalog(root = SHOTS_ROOT) {
  const scenarios = [];
  if (!existsSync(root)) return scenarios;
  for (const topic of readdirSync(root)) {
    const topicDir = join(root, topic);
    if (!statSync(topicDir).isDirectory()) continue;
    for (const scenario of readdirSync(topicDir)) {
      if (scenario === DIAGRAMS) continue;
      const dir = join(topicDir, scenario);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, 'frames.json');
      scenarios.push({
        topic,
        scenario,
        dir,
        manifest: existsSync(manifestPath)
          ? JSON.parse(readFileSync(manifestPath, 'utf8'))
          : undefined,
        files: readdirSync(dir).filter((name) => name.endsWith('.png')),
      });
    }
  }
  return scenarios;
}

/** Файлы схем: `<раздел>/diagrams/<имя>.png`. */
function readDiagrams(root = SHOTS_ROOT) {
  const diagrams = [];
  if (!existsSync(root)) return diagrams;
  for (const topic of readdirSync(root)) {
    const dir = join(root, topic, DIAGRAMS);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file === DIAGRAMS_MANIFEST) continue;
      diagrams.push({ topic, file, name: file.replace(/\.[^.]+$/, ''), ok: file.endsWith('.png') });
    }
  }
  return diagrams;
}

/**
 * Свежесть схем: отпечаток страницы исходника из описи против самого исходника.
 *
 * Это единственная проверка каталога, которая смотрит НЕ на картинку, а на её
 * происхождение. Всё остальное про схему (файл есть, ссылка живая, подпись
 * нашлась) остаётся зелёным и у экспорта недельной давности — а расходится
 * справка с кодом именно так.
 */
function readDiagramFreshness(root = SHOTS_ROOT, repo = ROOT) {
  const states = [];
  if (!existsSync(root)) return states;
  for (const topic of readdirSync(root)) {
    const manifestPath = join(root, topic, DIAGRAMS, DIAGRAMS_MANIFEST);
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const sourcePath = join(repo, manifest.source ?? '');
    if (!manifest.source || !existsSync(sourcePath)) {
      states.push({ topic, name: manifest.source ?? '(не указан)', missingSource: true });
      continue;
    }
    const pages = diagramPages(readFileSync(sourcePath, 'utf8'));
    for (const page of manifest.pages ?? []) {
      const current = fingerprint(pages[page.page - 1] ?? '');
      states.push({ topic, name: page.name, stale: current !== page.source });
    }
  }
  return states;
}

/** Чтение файла репозитория по пути из описи; папка и отсутствие — одинаково «нет». */
function readRepoFile(path, repo = ROOT) {
  const full = join(repo, path);
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return readFileSync(full, 'utf8');
}

/**
 * Идентификаторы разделов справки — из самого реестра, как в `check-help.mjs`.
 * Нужны, чтобы опись не пережила раздел: запись про документ, которого больше
 * нет в `HELP_GROUPS`, — это наблюдение за пустотой, и заметить его иначе
 * нечем.
 */
function readHelpTopics(path = TOPICS_REGISTRY) {
  if (!existsSync(path)) return [];
  const registry = readFileSync(path, 'utf8');
  return [...new Set([...registry.matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1]))];
}

/**
 * Свежесть документов: код против описи.
 *
 * Сообщение обязано нести три вещи, иначе его не выполнят: КАКОЙ раздел, КАКИЕ
 * файлы уехали (и чем они в документе отзываются) и ЧЕМ это гасится. Команда
 * печатается один раз на раздел, после списка файлов, — она одна на все его
 * расхождения.
 */
function sourceProblems(states) {
  const problems = [];
  const drifted = new Map();
  for (const state of states) {
    if (state.unknownTopic) {
      problems.push(
        `${SOURCES_MANIFEST}: раздела «${state.topic}» нет в pages/Help/model/topics.ts — ` +
          'опись пережила документ',
      );
    } else if (state.missingDocument) {
      problems.push(`${state.topic}: документ ${state.path} не найден — опись указывает в никуда`);
    } else if (state.empty) {
      problems.push(
        `${state.topic}: в описи нет ни одного исходника — раздел числится под наблюдением, ` +
          'а наблюдать не за чем',
      );
    } else if (state.missing) {
      drifted.set(state.topic, state.document);
      problems.push(
        `${state.topic} · ${state.path}: файла из описи нет — он переехал или поведение исчезло, ` +
          `а справка про него ещё рассказывает (${state.why})`,
      );
    } else if (state.unconfirmed) {
      drifted.set(state.topic, state.document);
      problems.push(
        `${state.topic} · ${state.path}: отпечатка в описи нет — с этим файлом справка ни разу ` +
          'не сверялась',
      );
    } else if (state.moved) {
      drifted.set(state.topic, state.document);
      problems.push(`${state.topic} · ${state.path}: код ушёл вперёд справки (${state.why})`);
    }
  }
  for (const [topic, document] of drifted) {
    problems.push(
      `${topic}: перечитайте ${document} рядом с этими файлами, поправьте текст и подтвердите — ` +
        confirmCommand(topic),
    );
  }
  return problems;
}

/** Где `<HelpShot>` и `<HelpDiagram>` стоят в документах справки. */
function readUsages(dir = TOPICS_DIR) {
  const shots = [];
  const diagrams = [];
  if (!existsSync(dir)) return { shots, diagrams };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tsx')) continue;
    const source = readFileSync(join(dir, name), 'utf8');
    const read = (props, prop) => props.match(new RegExp(`${prop}="([^"]+)"`))?.[1];
    for (const match of source.matchAll(/<HelpShot\b([^>]*?)\/>/gs)) {
      shots.push({
        file: name,
        topic: read(match[1], 'topic'),
        scenario: read(match[1], 'scenario'),
        frame: read(match[1], 'frame'),
        side: read(match[1], 'side'),
      });
    }
    for (const match of source.matchAll(/<HelpDiagram\b([^>]*?)\/>/gs)) {
      diagrams.push({
        file: name,
        topic: read(match[1], 'topic'),
        name: read(match[1], 'name'),
      });
    }
  }
  return { shots, diagrams };
}

/**
 * Ядро проверки: что утекло в ОДНОМ тексте. Отдельной функцией потому, что
 * самопроверка гоняет именно её — на подложенных строках, а не на настоящих
 * кадрах, где утечки (надеюсь) нет и красноты не увидеть.
 */
function auditText(text, secrets) {
  const leaks = [];
  for (const [label, source] of Object.entries(LEAK_PATTERNS)) {
    const hits = text.match(new RegExp(source, 'g'));
    if (hits) leaks.push(`${label} (${hits.length})`);
  }
  const hosts = [...new Set(text.replace(VENDOR_HOST, '').match(FOREIGN_HOST) ?? [])];
  if (hosts.length) leaks.push(`чужой домен: ${hosts.join(', ')}`);
  for (const secret of secrets) {
    // Значение не печатается никогда — только имя переменной, из которой оно.
    if (text.includes(secret.value)) leaks.push(`значение ${secret.name}`);
  }
  return leaks;
}

function verify(catalog, usages, dictionary, secrets, diagrams = [], freshness = []) {
  const problems = [];
  const ok = [];
  const known = new Map();
  /** Раздел → сколько у него кадров и у скольких есть английский близнец. */
  const coverage = new Map();

  for (const entry of catalog) {
    const where = `${entry.topic}/${entry.scenario}`;
    if (!entry.manifest) {
      problems.push(`${where}: нет описи frames.json, а файлов ${entry.files.length}`);
      continue;
    }

    const counted = coverage.get(entry.topic) ?? { frames: 0, english: 0 };
    coverage.set(entry.topic, counted);

    const listed = new Set();
    for (const frame of entry.manifest.frames) {
      listed.add(frame.file);
      known.set(`${where}/${frame.id}`, { ...frame, topic: entry.topic, scenario: entry.scenario });
      counted.frames += 1;

      // Английский кадр — не отдельная запись, а вложенный `en` у русской:
      // кадр остаётся одним кадром с одной подписью и одним номером шага.
      // Поэтому запись БЕЗ русских полей — не «ещё не переснято», а поломка
      // съёмки: английский прогон дописал отпечаток туда, где дописывать не к
      // чему, и на странице такой кадр не покажется никому.
      if (!frame.file) {
        problems.push(
          `${where}/${frame.id}: записан только по-английски — русского оригинала в описи нет`,
        );
        continue;
      }

      if (frame.en) {
        counted.english += 1;
        listed.add(frame.en.file);
        if (!entry.files.includes(frame.en.file)) {
          problems.push(`${where}/${frame.id}: английский кадр в описи есть, файла нет`);
          continue;
        }
        // Секретный скан идёт по ОБОИМ текстам. Английский кадр снят вторым
        // прогоном, с другой обстановкой и другими подменами: утечка в нём
        // ничем не связана с русским и ловится только собственным осмотром.
        const englishLeaks = auditText(frame.en.text ?? '', secrets);
        if (englishLeaks.length) {
          problems.push(`${where}/${frame.id} [en]: УТЕЧКА — ${englishLeaks.join('; ')}`);
          continue;
        }
      }

      if (!entry.files.includes(frame.file)) {
        problems.push(`${where}/${frame.id}: в описи есть, файла нет`);
        continue;
      }

      const leaks = auditText(frame.text ?? '', secrets);
      if (leaks.length) {
        problems.push(`${where}/${frame.id}: УТЕЧКА — ${leaks.join('; ')}`);
        continue;
      }

      // Ключ подписи ищется буквально: словарь — обычный объект TS, и `tsc`
      // проверяет его полноту, а не места вызова. Живой прогон
      // `check-help.mjs` увидит непереведённый ключ на самой странице; здесь
      // он ловится раньше и без стенда.
      if (!dictionary.includes(`'${frame.id}':`)) {
        const key = `help.shots.${entry.topic}.${entry.scenario}.${frame.id}`;
        problems.push(`${where}/${frame.id}: нет подписи ${key} в ru.ts`);
        continue;
      }

      ok.push(`${where}/${frame.id}`);
    }

    for (const file of entry.files) {
      if (!listed.has(file)) problems.push(`${where}/${file}: файл есть, в описи нет`);
    }
  }

  const referenced = new Set();
  for (const usage of usages.shots) {
    if (!usage.topic || !usage.scenario || !usage.frame || !usage.side) {
      problems.push(`${usage.file}: у <HelpShot> не хватает topic/scenario/frame/side`);
      continue;
    }
    const key = `${usage.topic}/${usage.scenario}/${usage.frame}`;
    const frame = known.get(key);
    if (!frame) {
      problems.push(`${usage.file}: <HelpShot> ссылается на ${key}, такого кадра в каталоге нет`);
      continue;
    }
    // Сторона в документе и сторона в описи должны совпадать: подпись кадра
    // начинается со стороны, и перепутанная сторона — уже неправда в тексте,
    // а не опечатка в разметке.
    if (frame.side !== usage.side) {
      problems.push(
        `${usage.file}: ${key} снят стороной «${frame.side}», показан как «${usage.side}»`,
      );
    }
    referenced.add(key);
  }

  for (const key of known.keys()) {
    if (!referenced.has(key)) problems.push(`${key}: кадр в каталоге, но его никто не показывает`);
  }

  // Схемы: те же три множества — файлы, ссылки, подписи.
  const shown = new Set();
  for (const usage of usages.diagrams) {
    if (!usage.topic || !usage.name) {
      problems.push(`${usage.file}: у <HelpDiagram> не хватает topic/name`);
      continue;
    }
    const key = `${usage.topic}/${usage.name}`;
    if (!diagrams.some((d) => d.topic === usage.topic && d.name === usage.name && d.ok)) {
      problems.push(`${usage.file}: <HelpDiagram> ссылается на ${key}, файла схемы нет`);
      continue;
    }
    if (!dictionary.includes(`'${usage.name}':`)) {
      problems.push(`${key}: нет подписи help.diagrams.${usage.topic}.${usage.name} в ru.ts`);
      continue;
    }
    shown.add(key);
    ok.push(`${key} (схема)`);
  }
  for (const diagram of diagrams) {
    const key = `${diagram.topic}/${diagram.name}`;
    if (!diagram.ok) {
      // SVG вместо PNG — не мелочь: подписи схемы собраны разметкой, а её
      // браузер внутри <img> не рисует, и схема приехала бы без текста.
      problems.push(`${diagram.topic}/${diagram.file}: не PNG — схема приедет без подписей`);
    } else if (!shown.has(key)) {
      problems.push(`${key}: схема в каталоге, но её никто не показывает`);
    }
  }

  for (const state of freshness) {
    if (state.missingSource) {
      problems.push(
        `${state.topic}/diagrams: исходник ${state.name} не найден — схему нечем сверить`,
      );
    } else if (state.stale) {
      problems.push(
        `${state.topic}/${state.name}: схема отстала от исходника — ` +
          'перегенерируйте `node docs/diagrams/<набор>/generate.mjs` и `node tools/help-shots/diagrams.mjs`',
      );
    }
  }

  return { problems, ok, coverage };
}

/**
 * Английские кадры: строка отчёта, а НЕ краснота.
 *
 * Разделов двадцать пять, переснимают их по одному, и правило, краснеющее на
 * первом же непереснятом разделе, пришлось бы вводить выключенным — то есть
 * никогда. Поэтому здесь считают: сколько разделов переснято целиком, сколько
 * начато и скольких кадров каждому из начатых не хватает. Названный пробел
 * заставляет двигаться не хуже красноты, а ход работы виден по одной строке.
 *
 * Молчания тоже быть не должно: раздел без единого английского кадра назван
 * своим именем, иначе «25 из 25» и «0 из 25» читались бы одинаково пусто.
 */
function englishReport(coverage) {
  const lines = [];
  const topics = [...coverage].sort(([a], [b]) => a.localeCompare(b));
  const full = topics.filter(([, c]) => c.english === c.frames && c.frames > 0);
  const partial = topics.filter(([, c]) => c.english > 0 && c.english < c.frames);
  const none = topics.filter(([, c]) => c.english === 0);

  lines.push(`Разделов с английскими кадрами: ${full.length} из ${topics.length}`);
  for (const [topic, c] of partial) {
    lines.push(
      `  ${topic}: английских кадров ${c.english} из ${c.frames} — раздел переснят не весь`,
    );
  }
  if (none.length) {
    lines.push(`  без английских кадров (${none.length}): ${none.map(([t]) => t).join(', ')}`);
  }
  return lines;
}

/** Сторож обязан уметь краснеть. Все образцы ниже вымышлены. */
function selftest() {
  const secrets = [{ name: 'вымышленный:KEY', value: 'абсолютно-секретное-значение' }];
  const cases = [
    ['ключ контура', 'Ключ sk-example000000000000 проверен', true],
    ['хвост ключа', 'ключ sk-…0000= проверен только что', true],
    ['почта', 'вошли как admin@instance.local', true],
    ['токен в заголовке', 'Authorization: Bearer example0000000000000', true],
    ['чужой домен', 'контур tenant.example.com отвечает', true],
    ['похожий на вендора', 'контур my-claude.ai отвечает', true],
    ['хост вендора в тексте панели', 'Выдать доступ через аккаунт claude.ai', false],
    ['значение из хранилища', 'пароль абсолютно-секретное-значение в поле', true],
    ['чистый кадр', 'Контур «Платформа компании · стенд» · шлюз 127.0.0.1:5179 · qwen2.5:0.5b', false],
  ];

  let failed = 0;
  for (const [name, text, mustFail] of cases) {
    const red = auditText(text, secrets).length > 0;
    const good = red === mustFail;
    console.log(`${good ? 'ок   ' : 'ПЛОХО'} ${mustFail ? 'краснеет' : 'пропускает'}: ${name}`);
    if (!good) failed += 1;
  }

  // Вторая половина самопроверки — не про текст, а про опись: сторож обязан
  // заметить кадр без файла, файл без записи и ссылку в никуда.
  const broken = [
    {
      topic: 'вымысел',
      scenario: 'проверка',
      dir: '',
      manifest: {
        frames: [{ id: '01-нет-файла', file: '01-нет-файла.png', side: 'panel', text: '' }],
      },
      files: ['99-сирота.png'],
    },
    // Английская половина: у кадра есть близнец, и он ломается СВОИМИ
    // способами — файла нет, в тексте утечка, запись без русского оригинала.
    {
      topic: 'перевод',
      scenario: 'проверка',
      dir: '',
      manifest: {
        frames: [
          {
            id: '01-без-английского-файла',
            file: '01-без-английского-файла.png',
            side: 'panel',
            text: '',
            en: { file: '01-без-английского-файла.en.png', text: '' },
          },
          {
            id: '02-утечка-по-английски',
            file: '02-утечка-по-английски.png',
            side: 'panel',
            text: '',
            en: {
              file: '02-утечка-по-английски.en.png',
              text: 'signed in as admin@instance.local',
            },
          },
          {
            id: '03-только-английский',
            side: 'panel',
            en: { file: '03-только-английский.en.png', text: '' },
          },
        ],
      },
      files: [
        '01-без-английского-файла.png',
        '02-утечка-по-английски.png',
        '02-утечка-по-английски.en.png',
      ],
    },
  ];
  const usages = {
    shots: [
      {
        file: 'X.tsx',
        topic: 'вымысел',
        scenario: 'проверка',
        frame: '02-нет-кадра',
        side: 'panel',
      },
    ],
    diagrams: [{ file: 'X.tsx', topic: 'вымысел', name: 'нет-такой-схемы' }],
  };
  const structural = verify(
    broken,
    usages,
    '',
    [],
    [{ topic: 'вымысел', file: 'лишняя.svg', name: 'лишняя', ok: false }],
    [
      { topic: 'вымысел', name: 'позавчерашняя', stale: true },
      { topic: 'вымысел', name: 'без-исходника', missingSource: true },
    ],
  );
  const expected = [
    'в описи есть, файла нет',
    'английский кадр в описи есть, файла нет',
    '[en]: УТЕЧКА',
    'русского оригинала в описи нет',
    'файл есть, в описи нет',
    'такого кадра в каталоге нет',
    'файла схемы нет',
    'не PNG',
    'отстала от исходника',
    'нечем сверить',
  ];
  for (const fragment of expected) {
    const found = structural.problems.some((problem) => problem.includes(fragment));
    console.log(`${found ? 'ок   ' : 'ПЛОХО'} краснеет: ${fragment}`);
    if (!found) failed += 1;
  }

  failed += selftestEnglish();
  failed += selftestSources();

  console.log(
    failed === 0
      ? '\nСамопроверка пройдена: сторож краснеет на каждой подложенной поломке.'
      : `\nСамопроверка провалена: молча проходит поломок — ${failed}`,
  );
  return failed === 0 ? 0 : 1;
}

/**
 * Счёт английских кадров проверяется отдельно — и не на красноту, а на ТЕКСТ.
 *
 * Это единственная часть отчёта, которая обязана оставаться зелёной при пустом
 * результате: раздел без английских кадров — пробел, а не поломка. Проверять
 * тут нечего, кроме того, что пробел НАЗВАН: сторож, который молча печатает
 * «0 из 25», ничем не отличается от сторожа, который не считает вовсе.
 */
function selftestEnglish() {
  const report = englishReport(
    new Map([
      ['целиком', { frames: 3, english: 3 }],
      ['наполовину', { frames: 4, english: 1 }],
      ['нетронутый', { frames: 5, english: 0 }],
    ]),
  ).join('\n');

  const cases = [
    ['переснятые разделы сосчитаны', 'Разделов с английскими кадрами: 1 из 3'],
    ['начатый раздел назван с остатком', 'наполовину: английских кадров 1 из 4'],
    ['нетронутый раздел назван по имени', 'без английских кадров (1): нетронутый'],
  ];

  let failed = 0;
  for (const [name, fragment] of cases) {
    const found = report.includes(fragment);
    console.log(`${found ? 'ок   ' : 'ПЛОХО'} называет: ${name}`);
    if (!found) failed += 1;
  }
  return failed;
}

/**
 * Четвёртая часть самопроверки — сверка документа с кодом.
 *
 * Здесь подкладывается не готовое состояние, а ВЫМЫШЛЕННОЕ дерево файлов:
 * отпечаток считается по-настоящему, поэтому проверяется не формулировка
 * сообщения, а сам расчёт. Два зелёных случая важны не меньше красных: сторож,
 * краснеющий на переписанном комментарии, будет подтверждаться не глядя.
 */
function selftestSources() {
  const code = 'export function pay() {\n  return 1;\n}\n';
  const files = {
    'doc.tsx': 'документ',
    'a.ts': code,
    'b.ts': code,
  };
  const read = (path) => files[path];
  const sha = (text) => sourceFingerprint(text);

  const entry = (sources, extra = {}) => ({
    topics: [{ topic: 'вымысел', document: 'doc.tsx', sources, ...extra }],
  });
  const problemsOf = (manifest, topics = ['вымысел']) =>
    sourceProblems(sourceStates(manifest, read, topics));

  const same = entry([{ path: 'a.ts', why: 'оплата', sha: sha(code) }]);

  // У каждого красного случая проверяется ещё и ФРАГМЕНТ сообщения: сторож,
  // который только ругается, заставляет идти за инструкцией. Расхождение кода
  // гасится подтверждением, а сломанная опись — правкой самой описи, поэтому
  // команда стоит не во всех случаях, и ожидание у каждого своё.
  const cases = [
    ['код не менялся — молчит', problemsOf(same), ''],
    [
      'переписан только комментарий — молчит',
      problemsOf(
        entry([
          { path: 'a.ts', why: 'оплата', sha: sha('// другой текст\n' + code + '\n// и ещё\n') },
        ]),
      ),
      '',
    ],
    [
      'код ушёл вперёд справки',
      problemsOf(entry([{ path: 'a.ts', why: 'оплата', sha: sha('return 2;') }])),
      confirmCommand('вымысел'),
    ],
    [
      'файл из описи исчез',
      problemsOf(entry([{ path: 'нет.ts', why: 'оплата', sha: 'ffffffffffffffff' }])),
      confirmCommand('вымысел'),
    ],
    [
      'отпечатка нет — не сверялись ни разу',
      problemsOf(entry([{ path: 'a.ts', why: 'оплата', sha: '' }])),
      'ни разу',
    ],
    ['список исходников пуст', problemsOf(entry([])), 'наблюдать не за чем'],
    ['раздела нет в реестре справки', problemsOf(same, ['другой']), 'опись пережила документ'],
    [
      'документ раздела исчез',
      problemsOf(entry([{ path: 'a.ts', why: 'оплата', sha: sha(code) }], { document: 'нет.tsx' })),
      'указывает в никуда',
    ],
  ];

  let failed = 0;
  for (const [name, problems, expect] of cases) {
    const mustFail = expect !== '';
    const good =
      problems.length > 0 === mustFail &&
      (!mustFail || problems.some((problem) => problem.includes(expect)));
    console.log(
      `${good ? 'ок   ' : 'ПЛОХО'} ${mustFail ? 'краснеет' : 'пропускает'}: ${name}` +
        (good || !mustFail ? '' : ` — ждали «${expect}», получили: ${problems.join(' / ')}`),
    );
    if (!good) failed += 1;
  }
  return failed;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const catalog = readCatalog();
  if (catalog.length === 0) {
    console.log('Каталог снимков пуст — проверять нечего.');
    return 0;
  }

  const secrets = readSecrets();
  const dictionary = readDictionary();
  const { problems, ok, coverage } = verify(
    catalog,
    readUsages(),
    dictionary,
    secrets,
    readDiagrams(),
    readDiagramFreshness(),
  );

  // Свежесть документов — отдельная нога прогона: у неё свой источник (опись
  // исходников), свой счёт и своя команда гашения.
  const manifest = readSourceManifest();
  const watched = manifest.topics ?? [];
  const states = sourceStates(manifest, (path) => readRepoFile(path), readHelpTopics());
  problems.push(...sourceProblems(states));

  console.log(
    `Кадров проверено: ${ok.length}; значений из хранилища в поиске: ${secrets.length}` +
      (secrets.length === 0 ? ' (файлов .env нет — эта часть проверки не выполнялась)' : ''),
  );
  // Сколько разделов под наблюдением — видно всегда: непокрытый раздел не
  // краснеет (иначе правило нельзя было бы вводить по одному), и единственное,
  // что о нём говорит, — эта строка.
  console.log(
    `Разделов сверено с кодом: ${watched.length} из ${readHelpTopics().length}` +
      ` (исходников ${states.filter((state) => state.ok).length} сходится)`,
  );
  for (const line of englishReport(coverage)) console.log(line);
  for (const problem of problems) console.log(`  ${problem}`);

  console.log(
    problems.length === 0
      ? 'Каталог снимков чист: опись сходится с диском, ссылки живые, утечек нет, ' +
          'сверенные разделы описывают сегодняшний код.'
      : `\nПроблем: ${problems.length}`,
  );
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
