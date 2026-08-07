import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/**
 * Грамматики подсветки: какой язык у открытого файла и откуда его взять.
 *
 * Список задан здесь руками, а не берётся из `@codemirror/language-data`, и это
 * не упрощение, а исправление. Таблица языков тянет за собой ~110 пакетов и
 * грузит их динамическим импортом ИЗНУТРИ зависимости — в дежурном режиме Vite
 * такой импорт не виден при первичном сканировании, поэтому первое открытие
 * любого файла запускало переоптимизацию: уже отданные браузеру модули
 * помечались устаревшими (`504 Outdated Optimize Dep`), редактор не собирался
 * вовсе и «прогружался» только со второго захода в файл.
 *
 * Импорты, написанные здесь явно, сканер Vite видит и складывает в кэш
 * зависимостей заранее — переоптимизации в работе больше не случается. На
 * сборку это не влияет: `import()` так и остаётся точкой разделения, грамматика
 * приезжает отдельным куском и только для того языка, который открыли.
 *
 * Язык не в списке — файл открывается как обычный текст. Это нормальный исход:
 * править `.env` без подсветки можно, а ронять окно ради экзотики нельзя.
 */

type LanguageLoader = () => Promise<Extension>;

/** Потоковый режим старого CodeMirror — их держит один пакет на все языки. */
const stream = (load: () => Promise<{ [key: string]: unknown }>, name: string): LanguageLoader => {
  return async () => {
    const module = await load();
    return StreamLanguage.define(module[name] as Parameters<typeof StreamLanguage.define>[0]);
  };
};

const js =
  (options: { jsx?: boolean; typescript?: boolean }): LanguageLoader =>
  async () =>
    (await import('@codemirror/lang-javascript')).javascript(options) as LanguageSupport;

// Языки, на которые ссылаются и расширение, и имя файла, — одной записью.
const shell = stream(() => import('@codemirror/legacy-modes/mode/shell'), 'shell');
const properties = stream(() => import('@codemirror/legacy-modes/mode/properties'), 'properties');

/**
 * Расширение файла → грамматика. Ключи без точки и в нижнем регистре.
 *
 * Порядок записей — по языкам, а не по алфавиту: соседние расширения одного
 * языка удобнее держать рядом, когда список правят.
 */
const BY_EXTENSION: Record<string, LanguageLoader> = {
  js: js({}),
  mjs: js({}),
  cjs: js({}),
  jsx: js({ jsx: true }),
  ts: js({ typescript: true }),
  mts: js({ typescript: true }),
  cts: js({ typescript: true }),
  tsx: js({ jsx: true, typescript: true }),

  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-vue')).vue(),

  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-sass')).sass({ indented: false }),
  sass: async () => (await import('@codemirror/lang-sass')).sass({ indented: true }),
  less: async () => (await import('@codemirror/lang-less')).less(),

  json: async () => (await import('@codemirror/lang-json')).json(),
  jsonc: async () => (await import('@codemirror/lang-json')).json(),
  json5: async () => (await import('@codemirror/lang-json')).json(),

  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  mdx: async () => (await import('@codemirror/lang-markdown')).markdown(),

  yml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),

  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  svg: async () => (await import('@codemirror/lang-xml')).xml(),
  xsl: async () => (await import('@codemirror/lang-xml')).xml(),

  py: async () => (await import('@codemirror/lang-python')).python(),
  pyi: async () => (await import('@codemirror/lang-python')).python(),
  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),

  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  h: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cxx: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cc: async () => (await import('@codemirror/lang-cpp')).cpp(),
  hpp: async () => (await import('@codemirror/lang-cpp')).cpp(),

  sh: shell,
  bash: shell,
  zsh: shell,
  ps1: stream(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell'),
  toml: stream(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  ini: properties,
  properties,
  conf: stream(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx'),
  diff: stream(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  patch: stream(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  rb: stream(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  lua: stream(() => import('@codemirror/legacy-modes/mode/lua'), 'lua'),
  pl: stream(() => import('@codemirror/legacy-modes/mode/perl'), 'perl'),
  r: stream(() => import('@codemirror/legacy-modes/mode/r'), 'r'),
  swift: stream(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  groovy: stream(() => import('@codemirror/legacy-modes/mode/groovy'), 'groovy'),
  gradle: stream(() => import('@codemirror/legacy-modes/mode/groovy'), 'groovy'),
  cs: stream(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp'),
  kt: stream(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  kts: stream(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  scala: stream(() => import('@codemirror/legacy-modes/mode/clike'), 'scala'),
  dart: stream(() => import('@codemirror/legacy-modes/mode/clike'), 'dart'),
};

/**
 * Файлы без расширения, у которых язык определяет само имя. Сравнение по
 * началу имени: `Dockerfile.dev` и `docker-compose.yaml` — тот же случай, что
 * `Dockerfile`.
 */
const BY_NAME: Array<[RegExp, LanguageLoader]> = [
  [/^dockerfile/i, stream(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile')],
  [/^makefile/i, stream(() => import('@codemirror/legacy-modes/mode/shell'), 'shell')],
  [/^(\.env|\.editorconfig|\.npmrc|\.gitconfig|\.gitignore)/i, properties],
  [/^(\.bashrc|\.zshrc|\.profile)/i, shell],
];

/**
 * Грамматика по пути файла. Возвращает `undefined`, если язык не опознан или
 * его не удалось загрузить, — файл тогда остаётся обычным текстом.
 */
export async function languageFor(path: string): Promise<Extension | undefined> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';

  const load =
    BY_EXTENSION[extension] ?? BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? undefined;
  if (!load) return undefined;

  try {
    return await load();
  } catch {
    return undefined;
  }
}
