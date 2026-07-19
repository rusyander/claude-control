import MarkdownIt from 'markdown-it';

/**
 * Разметка ответов и markdown-артефактов.
 *
 * Текст приходит от модели, а не от нас, поэтому html в исходнике отключён:
 * иначе ответ мог бы протащить в страницу произвольную разметку. Ссылки
 * открываются в новой вкладке — уводить пользователя из чата незачем.
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Ссылками считаем только явные — с протоколом. Иначе linkify принимает за
// адрес имя файла: `README.md` уезжало в ссылку на домен .md, а `package.json`
// приходилось спасать от подобного разбора.
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

/**
 * Пути к файлам в ответе модели.
 *
 * Ответ почти всегда содержит путь — куда смотреть, что править, где лежит
 * файл, — и в сплошном тексте он теряется. Помечаем такие места сами:
 * модель обрамляет их обратными кавычками не всегда, а искать их глазами
 * в абзаце неудобно.
 *
 * Расширения перечислены списком намеренно: без него под правило попадали бы
 * сокращения вроде «т.д.» и номера версий.
 */
const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonc|scss|sass|css|md|mdx|py|sh|bash|zsh|ps1|bat|cmd|yml|yaml|toml|ini|lock|env|html|xml|svg|sql|go|rs|java|kt|rb|php|cs|cpp|hpp|vue|svelte|txt|log|csv';

/**
 * Хвост `(?![\w])` обязателен: без него `js` из списка совпадает раньше
 * `json`, и `package.json` разрывался на метку `package.js` и текст `on`.
 */
const PATH_PATTERN = new RegExp(
  '(?:' +
    [
      // Путь с буквой диска: C:\work\… или C:/work/…
      String.raw`[A-Za-z]:[\\/][\w.@+-]+(?:[\\/][\w.@+-]+)*`,
      // Домашний и относительный: ~/…, ./…, ../…
      String.raw`(?:~|\.{1,2})[\\/][\w.@+-]+(?:[\\/][\w.@+-]+)*`,
      // Абсолютный unix. Сегментов минимум два, и первый начинается с буквы —
      // иначе под правило попадала дробь вроде «50/50».
      String.raw`/[A-Za-z_][\w.@+-]*(?:/[\w.@+-]+)+`,
      // Относительный путь с файлом известного типа: apps/web/src/index.ts
      String.raw`[\w.@+-]+(?:[\\/][\w.@+-]+)+\.(?:${FILE_EXT})(?![\w])`,
      // Одиночное имя файла: package.json, SKILL.md
      String.raw`[\w@+-]+\.(?:${FILE_EXT})(?![\w])`,
    ].join('|') +
    ')' +
    // Ссылка на строку и столбец — часть метки, а не текст рядом с ней.
    String.raw`(?::\d+(?::\d+)?)?`,
  'g',
);

/** Адрес со схемой — https://…, file://… и подобные. */
const URL_PATTERN = /[a-z][a-z\d+.-]*:\/\/\S+/gi;

/**
 * Шаг первый: обернуть пути обратными кавычками до разбора строки.
 *
 * Именно до: markdown понимает `\.` как экранированную точку и съедает слеш,
 * так что `C:\Users\me\.claude\settings.json` доходил до разметки уже битым —
 * с потерянным разделителем перед скрытой папкой. Внутри кавычек экранирование
 * не работает, и путь остаётся таким, каким его написали.
 */
markdown.core.ruler.before('inline', 'file_paths_wrap', (state) => {
  for (const block of state.tokens) {
    if (block.type === 'inline') block.content = wrapPaths(block.content);
  }
});

/**
 * Варианты выбора, написанные обычным текстом.
 *
 * Через инструмент вопроса модель спрашивает не всегда — чаще она просто
 * пишет «Вариант 1 — …», «Вариант 2 — …» посреди ответа. Для читателя это
 * то же самое место, где от него ждут решения, и оно так же теряется в
 * сплошном тексте. Помечаем такие абзацы, чтобы их было видно с первого
 * взгляда.
 */
const OPTION_LINE = /^\s*\**\s*(вариант|option|способ)\s*\d/i;

markdown.core.ruler.push('choice_lines', (state) => {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (token?.type !== 'inline' || !OPTION_LINE.test(token.content)) continue;

    // Класс вешаем на сам абзац или заголовок — на то, что обрамляет строку.
    const opener = state.tokens[index - 1];
    if (opener && (opener.type === 'paragraph_open' || opener.type === 'heading_open')) {
      opener.attrJoin('class', 'chat-choice');
    }
  }
});

/**
 * Шаг второй: пометить классом код, который оказался путём. Помечаются и те
 * пути, что модель обрамила кавычками сама, — для читателя разницы нет.
 */
markdown.core.ruler.push('file_paths_mark', (state) => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;

    for (const token of block.children) {
      if (token.type !== 'code_inline') continue;

      PATH_PATTERN.lastIndex = 0;
      const match = PATH_PATTERN.exec(token.content);
      if (match && match[0] === token.content.trim()) token.attrSet('class', 'chat-path');
    }
  }
});

/**
 * Оборачивает пути в кавычки, не трогая уже размеченное: то, что внутри
 * кавычек, и адрес ссылки. Разбор посимвольный — регулярка на вложенности
 * разметки ошибается.
 */
function wrapPaths(content: string): string {
  let out = '';
  let index = 0;

  while (index < content.length) {
    const char = content[index];

    // Ссылка со схемой копируется целиком: без этого её хвост после `https:`
    // выглядит как путь, метка режет адрес пополам и ссылка перестаёт работать.
    URL_PATTERN.lastIndex = index;
    const url = URL_PATTERN.exec(content);
    if (url && url.index === index) {
      out += url[0];
      index += url[0].length;
      continue;
    }

    // Внутри кавычек ничего не меняем: там уже код.
    if (char === '`') {
      const end = content.indexOf('`', index + 1);
      if (end === -1) {
        out += content.slice(index);
        break;
      }
      out += content.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    // Адрес ссылки — не текст, метить его нельзя: разметка сломается.
    if (char === ']' && content[index + 1] === '(') {
      const end = content.indexOf(')', index + 2);
      if (end === -1) {
        out += content.slice(index);
        break;
      }
      out += content.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    PATH_PATTERN.lastIndex = index;
    const match = PATH_PATTERN.exec(content);

    if (!match || match.index !== index) {
      out += char;
      index += 1;
      continue;
    }

    out += '`' + match[0] + '`';
    index += match[0].length;
  }

  return out;
}

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noreferrer noopener');
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}

/** Короткий фрагмент без блочных обёрток — для строки в списке. */
export function renderMarkdownInline(text: string): string {
  return markdown.renderInline(text);
}
