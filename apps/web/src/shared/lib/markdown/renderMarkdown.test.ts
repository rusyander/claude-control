import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderMarkdownInline } from './renderMarkdown';

/**
 * Разметка ответов модели.
 *
 * Самый хрупкий код фронта: текст пишет не программа, а модель, и разбирается
 * он тремя собственными правилами поверх markdown-it. Каждое из них уже ломалось
 * на живых ответах — отсюда и тесты. Три вещи здесь критичны:
 *
 * 1. Безопасность: `html: false`, иначе ответ протащит в страницу произвольную
 *    разметку — сюда уходит `dangerouslySetInnerHTML`.
 * 2. Пути не должны рваться и не должны появляться там, где их нет: по метке
 *    пользователь ищет, куда смотреть.
 * 3. Обычная разметка (жирный, списки, ссылки, код) обязана продолжать работать —
 *    свои правила не имеют права её задевать.
 */

/** Что помечено как путь — в порядке появления. */
function paths(markdown: string): string[] {
  return [...renderMarkdown(markdown).matchAll(/class="chat-path">([^<]*)</g)].map(
    (match) => match[1] ?? '',
  );
}

describe('renderMarkdown: подсветка путей', () => {
  it('помечает относительный путь с файлом', () => {
    expect(paths('Смотри файл apps/server/src/index.ts — там всё.')).toEqual([
      'apps/server/src/index.ts',
    ]);
  });

  it('помечает путь Windows со скрытой папкой, не теряя разделитель', () => {
    // Регрессия: markdown понимает `\.` как экранированную точку и съедал слеш,
    // из-за чего путь доходил до разметки без разделителя перед `.claude`.
    expect(paths('Путь C:\\Users\\rusyander\\.claude\\settings.json')).toEqual([
      'C:\\Users\\rusyander\\.claude\\settings.json',
    ]);
  });

  it('помечает домашний путь', () => {
    expect(paths('И ~/.claude/hooks/git-guard.mjs тоже')).toEqual([
      '~/.claude/hooks/git-guard.mjs',
    ]);
  });

  it('не режет расширение json на js', () => {
    // Регрессия: в списке расширений `js` стоит раньше `json`, и без запрета
    // на продолжение слова `package.json` разрывался на метку и текст «on».
    expect(paths('Открой package.json')).toEqual(['package.json']);
  });

  it('забирает номер строки в метку', () => {
    expect(paths('Ошибка в index.ts:42 вот тут')).toEqual(['index.ts:42']);
  });

  it('забирает номер строки и столбца', () => {
    expect(paths('Смотри index.ts:42:7 внимательно')).toEqual(['index.ts:42:7']);
  });

  it('помечает адрес эндпоинта', () => {
    expect(paths('Эндпоинт /api/chats/messages работает')).toEqual(['/api/chats/messages']);
  });

  it('помечает путь, который модель уже обрамила кавычками', () => {
    // Для читателя разницы нет: путь есть путь, метка должна быть одинаковой.
    expect(paths('Уже код: `apps/web/vite.config.ts`')).toEqual(['apps/web/vite.config.ts']);
  });

  it('обычный код без пути меткой пути не становится', () => {
    expect(paths('Вызови `useState` в компоненте')).toEqual([]);
  });
});

describe('renderMarkdown: чего подсветка не трогает', () => {
  it('дробь и номер версии путями не считаются', () => {
    // Регрессия: правило абсолютного пути ловило «/50.» из «50/50».
    expect(paths('Обычный текст: и т.д., версия 1.2.3, да/нет, 50/50.')).toEqual([]);
  });

  it('адрес ссылки не метится — иначе разметка ломается', () => {
    const html = renderMarkdown('Ссылка [текст](apps/server/src/index.ts) — не трогаем');
    expect(paths('Ссылка [текст](apps/server/src/index.ts) — не трогаем')).toEqual([]);
    expect(html).toContain('<a href="apps/server/src/index.ts"');
  });

  it('ссылка со схемой остаётся целой и кликабельной', () => {
    // Регрессия: хвост после `https:` выглядел как путь, и метка резала адрес.
    const html = renderMarkdown('Ссылка https://example.com/path/file.ts');
    expect(paths('Ссылка https://example.com/path/file.ts')).toEqual([]);
    expect(html).toContain('<a href="https://example.com/path/file.ts"');
  });

  it('имя файла не уезжает в ссылку на домен', () => {
    // Регрессия: linkify считал `README.md` адресом в зоне .md.
    const html = renderMarkdown('Файл README.md рядом');
    expect(html).not.toContain('<a ');
    expect(paths('Файл README.md рядом')).toEqual(['README.md']);
  });

  it('содержимое блока кода не размечается', () => {
    const html = renderMarkdown('```\nконсоль: apps/server/index.ts\n```');
    expect(html).toContain('<pre>');
    expect(html).not.toContain('chat-path');
  });
});

describe('renderMarkdown: строки выбора', () => {
  const marked = (text: string): boolean => /class="chat-choice"/.test(renderMarkdown(text));

  it('помечает «Вариант N» жирным абзацем', () => {
    expect(marked('**Вариант 1 — открой сам (самое быстрое и надёжное):**')).toBe(true);
  });

  it('помечает «Вариант N» обычным абзацем', () => {
    expect(marked('Вариант 2 — одобри запрос прав, и я:')).toBe(true);
  });

  it('помечает заголовок с вариантом', () => {
    expect(marked('### Вариант 3: через Docker')).toBe(true);
  });

  it('понимает английское Option и русский «Способ»', () => {
    expect(marked('Option 1 — do it yourself')).toBe(true);
    expect(marked('Способ 2 — через панель')).toBe(true);
  });

  it('не помечает текст, где слово «вариант» просто упомянуто', () => {
    expect(marked('Это обычный абзац про варианты решения задачи.')).toBe(false);
    expect(marked('Вариантов много, но выбрать надо один.')).toBe(false);
  });
});

describe('renderMarkdown: безопасность и обычная разметка', () => {
  it('сырой html из ответа модели в страницу не попадает', () => {
    // Ключевая защита: результат уходит в dangerouslySetInnerHTML.
    const html = renderMarkdown('<script>alert(1)</script> и <b>жирный</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('жирный, курсив, ссылка и код продолжают работать', () => {
    const html = renderMarkdown('**жирный**, *курсив*, [ссылка](https://ok.dev), `код`');
    expect(html).toContain('<strong>жирный</strong>');
    expect(html).toContain('<em>курсив</em>');
    expect(html).toContain('<a href="https://ok.dev"');
    expect(html).toContain('<code>код</code>');
  });

  it('внешние ссылки открываются в новой вкладке и без утечки реферера', () => {
    const html = renderMarkdown('[ссылка](https://ok.dev)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('списки и таблицы размечаются', () => {
    expect(renderMarkdown('- один\n- два')).toContain('<ul>');
    expect(renderMarkdown('1. один\n2. два')).toContain('<ol>');
  });

  it('пустой текст даёт пустую строку, а не падение', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdownInline('')).toBe('');
  });

  it('одиночный перенос строки сохраняется', () => {
    // breaks: true — модель разделяет мысли переносами, и они значимы.
    expect(renderMarkdown('первая\nвторая')).toContain('<br>');
  });

  it('незакрытая обратная кавычка не роняет разбор', () => {
    expect(() => renderMarkdown('текст с `незакрытой кавычкой')).not.toThrow();
  });

  it('inline-вариант не оборачивает текст в абзац', () => {
    const html = renderMarkdownInline('просто **текст**');
    expect(html).not.toContain('<p>');
    expect(html).toContain('<strong>текст</strong>');
  });
});
