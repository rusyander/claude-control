import { describe, expect, it } from 'vitest';
import {
  checkPicture,
  parseDeckAnswer,
  parseDeckBlock,
  scanMediaBlocks,
  DECK_BLOCK_LANG,
  PICTURE_BLOCK_LANG,
  PICTURE_MAX_CHARS,
} from '@agentdeck/contracts/media-block';
import { DECK_MAX_SLIDES } from '@agentdeck/contracts/media-deck';

/**
 * Дорога агента: то, что он сказал блоком, панель либо принимает целиком, либо
 * называет причину.
 *
 * Разбор здесь ОДИН на два места — лента прячет блок ровно тогда, когда сервер
 * его примет, — поэтому проверяется он как общее обещание: непринятый блок
 * остаётся в тексте (слова агента не теряются), а опасное содержимое не
 * сохраняется вовсе, даже если показ его и не исполнил бы.
 */

const fence = (lang: string, body: string): string => ['```' + lang, body, '```'].join('\n');

const DECK = JSON.stringify({
  title: 'Итоги',
  subtitle: '',
  slides: [{ title: 'Раз', bullets: ['первое'], notes: 'вслух' }],
});

describe('checkPicture', () => {
  it('обычный рисунок кодом принимается', () => {
    const svg = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

    expect(checkPicture(svg).svg).toBe(svg);
  });

  it('скрипт внутри рисунка — отказ с названной причиной, а не тихая правка', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api")</script></svg>';

    // Панель НЕ вырезает скрипт молча: почищенный файл выглядел бы как рисунок
    // агента, которым он уже не является. Причина называется, блок остаётся в
    // ленте текстом, и человек видит, что именно отвергнуто.
    expect(checkPicture(svg)).toEqual({ problem: 'active-content' });
  });

  it('обработчик события и javascript: — та же причина', () => {
    expect(checkPicture('<svg onload="x()"><rect/></svg>').problem).toBe('active-content');
    expect(checkPicture('<svg><a href="javascript:x()"/></svg>').problem).toBe('active-content');
    expect(checkPicture('<svg><foreignObject><b/></foreignObject></svg>').problem).toBe(
      'active-content',
    );
  });

  it('ссылка наружу — отказ: файл обязан быть самодостаточным', () => {
    expect(checkPicture('<svg><image href="https://cdn.example/x.png"/></svg>').problem).toBe(
      'remote-ref',
    );
    expect(checkPicture('<svg><style>@import url(x.css)</style></svg>').problem).toBe('remote-ref');
    // Вшитые байты — это и есть самодостаточность, и они разрешены.
    expect(checkPicture('<svg><image href="data:image/png;base64,AA=="/></svg>').svg).toContain(
      'data:image/png',
    );
    // Ссылка внутрь этого же файла тоже разрешена — ею держатся градиенты и `<use>`.
    expect(checkPicture('<svg><use href="#logo"/><rect fill="url(#grad)"/></svg>').svg).toContain(
      '#logo',
    );
  });

  /**
   * Враждебная проверка 13.09.2026: проверка читала СЫРОЙ текст, а браузер читает
   * раскодированный. Каждый из этих файлов панель принимала, сохраняла и отдавала —
   * и он звонил наружу (или исполнял код) в тот момент, когда человек открывал
   * скачанный `.svg` своим браузером, то есть ровно там, где панель уже не защищает.
   */
  it('закодированная ссылка и оживлённый атрибут — тоже отказ', () => {
    const cases: Array<[string, string]> = [
      ['десятичная ссылка на знак', '<svg><image href="&#104;ttps://evil.example/p.png"/></svg>'],
      ['шестнадцатеричная', '<svg><image href="&#x68;ttps://evil.example/p.png"/></svg>'],
      ['схема файла', '<svg><image href="file://evil.example/share/x.png"/></svg>'],
      ['относительный путь', '<svg><image href="../../secret.png"/></svg>'],
      [
        'escape CSS в url()',
        '<svg><style>rect{fill:url("http\\3a //evil.example/x#g")}</style></svg>',
      ],
    ];
    for (const [name, svg] of cases) {
      expect(checkPicture(svg).problem, name).toBe('remote-ref');
    }
  });

  it('исполняемое, спрятанное от буквального поиска, — active-content', () => {
    const cases: Array<[string, string]> = [
      ['ссылка на знак в схеме', '<svg><a xlink:href="java&#115;cript:alert(1)">x</a></svg>'],
      [
        'оживление ссылки анимацией',
        '<svg><a><set attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>',
      ],
      ['скрипт без пробела', '<svg><script/></svg>'],
      [
        'объявление сущности',
        '<svg><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]></svg>',
      ],
    ];
    for (const [name, svg] of cases) {
      expect(checkPicture(svg).problem, name).toBe('active-content');
    }
  });

  it('не SVG и слишком большой — свои причины', () => {
    expect(checkPicture('<html><body/></html>').problem).toBe('not-svg');
    expect(checkPicture('<svg><rect/>').problem).toBe('not-svg');
    expect(checkPicture(`<svg>${'x'.repeat(PICTURE_MAX_CHARS)}</svg>`).problem).toBe('too-big');
  });

  // Аудит MD-08: рисунок без пространства имён браузер рисует ВНУТРИ HTML, а
  // файлом (`<img>` панели, картинка слайда PPTX) — пустым местом. Модель пишет
  // `<svg>` без `xmlns` постоянно: в HTML он не нужен.
  it('рисунок без объявленных пространств имён получает их, остальное не трогается', () => {
    expect(checkPicture('<svg viewBox="0 0 10 10"><rect/></svg>').svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>',
    );
    // `xlink:` без объявления — ошибка разбора XML, то есть тоже пустой файл.
    expect(checkPicture('<svg>\n<use xlink:href="#a"/></svg>').svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">\n' +
        '<use xlink:href="#a"/></svg>',
    );
    // Объявленное не дублируется: второй `xmlns` — такая же ошибка разбора.
    const declared =
      '<?xml version="1.0"?><svg xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'xmlns=\'http://www.w3.org/2000/svg\'><use xlink:href="#a"/></svg>';
    expect(checkPicture(declared).svg).toBe(declared);
  });

  it('пролог XML перед корнем не мешает', () => {
    const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

    expect(checkPicture(svg).svg).toBe(svg);
  });
});

describe('parseDeckBlock', () => {
  it('колода без заголовка или без слайдов не колода', () => {
    expect(parseDeckBlock('{"slides":[{"title":"Раз"}]}').deck).toBeUndefined();
    expect(parseDeckBlock('{"title":"Итоги","slides":[]}').deck).toBeUndefined();
    expect(parseDeckBlock('не json').deck).toBeUndefined();
  });

  it('лишний забор вокруг JSON разворачивается — модели заворачивают дважды', () => {
    expect(parseDeckBlock('```json\n' + DECK + '\n```').deck?.title).toBe('Итоги');
  });

  // Живой прогон по проводу: модель контура, которой правила приехали системным
  // сообщением, ответила НАШИМ языком блока. Двоеточие в языке забора не
  // разворачивалось, и панель говорила «ответила не колодой» о колоде.
  it('забор с нашим собственным языком блока — тоже забор', () => {
    expect(parseDeckBlock('```agentdeck:deck\n' + DECK + '\n```').deck?.title).toBe('Итоги');
  });

  // Аудит MD-07: каждая из этих форм была отказом, хотя структура в ответе есть.
  it('проза вокруг колоды и размышления перед ней колоду не прячут', () => {
    const shapes: [string, string][] = [
      ['проза перед забором', 'Вот структура презентации:\n```json\n' + DECK + '\n```'],
      ['проза после забора', '```json\n' + DECK + '\n```\nНадеюсь, это поможет.'],
      ['размышления перед JSON', '<think>планирую слайды</think>\n' + DECK],
      ['вводная фраза без забора', 'Конечно! ' + DECK + ' Готово.'],
      ['тильды и наш язык', 'Держите:\n~~~agentdeck:deck\n' + DECK + '\n~~~'],
    ];
    for (const [name, body] of shapes) {
      expect(parseDeckAnswer(body).deck?.title, name).toBe('Итоги');
    }
  });

  it('из прозы берётся только колода: чужой объект и черновик в размышлениях — не она', () => {
    // Первый попавшийся объект — не обязательно колода: модель могла сначала
    // процитировать настройки. А черновик внутри размышлений — не ответ.
    const body =
      '<think>' +
      JSON.stringify({ title: 'Черновик', slides: [{ title: 'x' }] }) +
      '</think>\nНастройки: {"accent":"blue"}\nИтог: ' +
      DECK;
    expect(parseDeckAnswer(body).deck?.title).toBe('Итоги');
    expect(parseDeckAnswer('Настройки: {"accent":"blue"} и больше ничего').deck).toBeUndefined();
    // Оборванные размышления — это не ответ, даже если внутри колода.
    expect(parseDeckAnswer('<think>вот так: ' + DECK).deck).toBeUndefined();
    // Забор другого языка — цитата, то же правило, что у сканера ответа агента.
    expect(parseDeckAnswer('Пример формата:\n```markdown\n' + DECK + '\n```').deck).toBeUndefined();
  });

  it('пустые пункты выбрасываются, а слайд без заголовка и без пунктов не берётся', () => {
    const parsed = parseDeckBlock(
      JSON.stringify({
        title: 'Итоги',
        slides: [
          { title: 'Раз', bullets: ['первое', '', '   '] },
          { title: '', bullets: [] },
        ],
      }),
    );

    expect(parsed.deck?.slides).toEqual([{ title: 'Раз', bullets: ['первое'], notes: '' }]);
  });

  it('богатый слайд разбирается целиком, а чужие значения выбрасываются', () => {
    const parsed = parseDeckBlock(
      JSON.stringify({
        title: 'Контур',
        accent: 'фиолетовый в крапинку',
        preset: 'deep',
        slides: [
          {
            title: 'Числа',
            layout: 'stats',
            bullets: [],
            stats: [
              { value: '2×', label: 'быстрее' },
              { value: '', label: 'без числа' },
            ],
            columns: [{ title: 'одна', bullets: ['и всё'] }],
            illustration: 'схема шлюза',
            pictureId: 'не идентификатор',
            sources: [{ title: 'Док', url: 'javascript:alert(1)' }],
          },
        ],
      }),
    );

    const slide = parsed.deck?.slides[0];
    expect(parsed.deck?.accent).toBeUndefined();
    expect(parsed.deck?.preset).toBe('deep');
    expect(slide?.layout).toBe('stats');
    // Число без подписи — загадка на слайде; одна колонка — не сравнение.
    expect(slide?.stats).toEqual([{ value: '2×', label: 'быстрее' }]);
    expect(slide?.columns).toBeUndefined();
    expect(slide?.illustration).toBe('схема шлюза');
    expect(slide?.pictureId).toBeUndefined();
    // Адрес остаётся текстом, но не любой: показанный адрес человек копирует.
    expect(slide?.sources).toEqual([{ title: 'Док', url: '' }]);
  });

  it('схема со скриптом внутри выбрасывается, а слайд остаётся слайдом', () => {
    const parsed = parseDeckBlock(
      JSON.stringify({
        title: 'Схемы',
        slides: [
          { title: 'Живая', bullets: ['текст'], figure: '<svg><script>x()</script></svg>' },
          { title: 'Мёртвая', bullets: [], figure: '<svg><rect/></svg>' },
        ],
      }),
    );

    expect(parsed.deck?.slides[0]?.figure).toBeUndefined();
    expect(parsed.deck?.slides[0]?.title).toBe('Живая');
    expect(parsed.deck?.slides[1]?.figure).toContain('<rect/>');
  });

  /**
   * Молчаливое обрезание — то же, что молчаливый отказ: агент, надиктовавший
   * пятьдесят слайдов, выглядел бы небрежным, а обрезала панель.
   */
  it('обрезание по потолку названо признаком', () => {
    const many = parseDeckBlock(
      JSON.stringify({
        title: 'Много',
        slides: Array.from({ length: DECK_MAX_SLIDES + 5 }, (_unused, index) => ({
          title: `Слайд ${index}`,
          bullets: [],
        })),
      }),
    );

    expect(many.deck?.slides).toHaveLength(DECK_MAX_SLIDES);
    expect(many.truncated).toBe(true);
    expect(parseDeckBlock(DECK).truncated).toBe(false);
  });

  /**
   * Знаки, запрещённые в XML: настоящий PowerPoint открывал файл и МОЛЧА обрезал
   * пункт на этом месте, а строгий разбор отказывался от части целиком.
   */
  it('знаки, недопустимые в XML, убираются на границе', () => {
    // Задаются кодами: в исходнике теста такой знак невидим, а в файле он
    // ломал бы и сам тест — читать его глазами стало бы нельзя.
    const NUL = '\u0000';
    const BELL = '\u0007';
    const NONCHAR = '\uFFFE';
    const parsed = parseDeckBlock(
      JSON.stringify({
        title: `Итоги${NUL} года`,
        slides: [{ title: 'Раз', bullets: [`рост${BELL}2×`], notes: `вслух${NONCHAR}` }],
      }),
    );

    expect(parsed.deck?.title).toBe('Итоги  года');
    expect(parsed.deck?.slides[0]?.bullets[0]).toBe('рост 2×');
    expect(parsed.deck?.slides[0]?.notes).toBe('вслух');
    // Эмодзи — обычный знак из пары половин, и он остаётся на месте.
    expect(parseDeckBlock('{"title":"Итоги 🎯","slides":[{"title":"Раз"}]}').deck?.title).toBe(
      'Итоги 🎯',
    );
  });
});

describe('scanMediaBlocks', () => {
  it('принятый блок уходит из показа, а текст вокруг остаётся', () => {
    const scan = scanMediaBlocks(`Готово.\n${fence(DECK_BLOCK_LANG, DECK)}\nСмотри карточку.`);

    expect(scan.decks).toHaveLength(1);
    expect(scan.text).toBe('Готово.\nСмотри карточку.');
    expect(scan.rejected).toBe(0);
  });

  it('непонятый блок остаётся в ленте как есть и считается отвергнутым', () => {
    const scan = scanMediaBlocks(fence(DECK_BLOCK_LANG, '{"title":"без слайдов"}'));

    expect(scan.decks).toHaveLength(0);
    expect(scan.rejected).toBe(1);
    // Слова агента не теряются: спрятать непонятое — значит потерять ответ без следа.
    expect(scan.text).toContain('без слайдов');
  });

  it('блок ещё печатается — ни его, ни хвоста в ленте нет', () => {
    const scan = scanMediaBlocks('Собираю…\n```' + DECK_BLOCK_LANG + '\n{"title":"Ит', {
      streaming: true,
    });

    expect(scan.text).toBe('Собираю…');
    expect(scan.decks).toHaveLength(0);
    // Недописанный блок — не отказ: он просто ещё не кончился.
    expect(scan.rejected).toBe(0);
  });

  /**
   * Тот же незакрытый забор в ДОПИСАННОМ ответе. Прежний разбор съедал блок и всё
   * после него с `rejected: 0` — агент надиктовал колоду и три абзаца, а человек
   * видел два слова и ни слова о том, почему (враждебная проверка 13.09.2026).
   */
  it('незакрытый блок в готовом ответе остаётся текстом и назван отвергнутым', () => {
    const source = `Вот колода:\n\`\`\`${DECK_BLOCK_LANG}\n${DECK}\nА ещё три абзаца пояснений.`;
    const scan = scanMediaBlocks(source);

    expect(scan.decks).toHaveLength(0);
    expect(scan.rejected).toBe(1);
    expect(scan.text).toContain('три абзаца пояснений');
  });

  it('рисунок и колода в одном ответе разбираются оба', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const scan = scanMediaBlocks(
      [fence(DECK_BLOCK_LANG, DECK), 'и рисунок:', fence(PICTURE_BLOCK_LANG, svg)].join('\n'),
    );

    expect(scan.decks).toHaveLength(1);
    expect(scan.pictures).toEqual([svg]);
    expect(scan.text).toBe('и рисунок:');
  });

  it('чужой блок кода не трогается', () => {
    const source = fence('ts', 'const a = 1;');
    const scan = scanMediaBlocks(source);

    expect(scan.text).toBe(source.trim());
    expect(scan.rejected).toBe(0);
  });

  /**
   * Блок, ЗАКАВЫЧЕННЫЙ внутри чужого забора, — пример, а не предложение собрать
   * файл: ровно то правило, которое панель уже держит в шлюзе (12.09.2026,
   * настоящий `claude.exe` записал файл из блока с пометкой «это пример»).
   */
  it('наш блок внутри чужого забора — цитата: карточки нет, но молчания тоже', () => {
    const quoted = ['````md', fence(DECK_BLOCK_LANG, DECK), '````'].join('\n');
    const scan = scanMediaBlocks(`Формат такой:\n${quoted}`);

    expect(scan.decks).toHaveLength(0);
    expect(scan.rejected).toBe(1);
    // Цитата остаётся в ленте целиком — вместе с заборами, как её и написали.
    expect(scan.text).toContain(DECK_BLOCK_LANG);
    expect(scan.text).toContain('"title":"Итоги"');
  });

  it('четыре кавычки, тильды и заглавные буквы — тот же блок', () => {
    const four = scanMediaBlocks(['````' + DECK_BLOCK_LANG, DECK, '````'].join('\n'));
    const tildes = scanMediaBlocks(['~~~' + DECK_BLOCK_LANG, DECK, '~~~'].join('\n'));
    const upper = scanMediaBlocks(fence('AgentDeck:Deck', DECK));

    expect(four.decks).toHaveLength(1);
    expect(tildes.decks).toHaveLength(1);
    expect(upper.decks).toHaveLength(1);
  });

  it('обрезанная колода из блока названа обрезанной', () => {
    const scan = scanMediaBlocks(
      fence(
        DECK_BLOCK_LANG,
        JSON.stringify({
          title: 'Много',
          slides: Array.from({ length: DECK_MAX_SLIDES + 1 }, () => ({ title: 'Слайд' })),
        }),
      ),
    );

    expect(scan.decks).toHaveLength(1);
    expect(scan.truncated).toBe(true);
  });
});
