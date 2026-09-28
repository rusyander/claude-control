/**
 * Картинки, которые человек даёт агенту ПРЯМО В ЗАПРОСЕ: агент панели,
 * помощник формы, ассистент шага группы. У них нет файловой системы (агент
 * панели — лёгкое окно, `--tools ""`), поэтому путь к файлу им бесполезен:
 * картинка едет в самом запросе блоком `image`, и модель видит её в том же ходе.
 *
 * Чат Claude сюда не относится: там вложение ложится файлом в папку чата, и CLI
 * читает его сам (`uploads.ts`). Общее у всех полей одно — момент вложения и его
 * пределы (`planAttach` на фронте): отказ при добавлении, с настоящим размером.
 *
 * ВАЖНО про импорт на сервере: файл самодостаточен (ни одного импорта) и вынесен
 * в отдельную точку экспорта `@agentdeck/contracts/agent-images` — бочку без
 * расширений Node под `--experimental-strip-types` не резолвит.
 */

/** Типы, которые модель принимает блоком `image`. Список закрыт. */
export const AGENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AgentImageType = (typeof AGENT_IMAGE_TYPES)[number];

/** Расширения тех же типов — для `accept` поля выбора и для проверки имени. */
export const AGENT_IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** Значение `accept` для поля выбора картинки. */
export const AGENT_IMAGE_ACCEPT: string = AGENT_IMAGE_EXTENSIONS.join(',');

/**
 * Предел одной картинки НА ПРОВОДЕ, в байтах файла. API модели меряет 5 МБ по
 * строке base64 (5 242 880 символов), а base64 длиннее байтов на треть — отсюда
 * 3,75 МБ. Больший снимок фронт перед отправкой ужимает сам (длинная сторона
 * до `AGENT_IMAGE_MAX_EDGE`), поэтому человек этот предел не встречает: при
 * вложении действует тот же предел, что у чата.
 */
export const AGENT_IMAGE_WIRE_MAX_BYTES = 3_750_000;

/**
 * Длинная сторона, до которой фронт ужимает картинку. Больше модель всё равно
 * не разглядит: API уменьшает такую картинку сам, только уже за токены.
 */
export const AGENT_IMAGE_MAX_EDGE = 1568;

/** Сколько картинок в одном сообщении. */
export const AGENT_IMAGE_MAX_COUNT = 8;

/** Картинка в теле запроса. */
export interface AgentImage {
  /** Имя, как его видел человек, — для строки в истории и подписи. */
  name: string;
  mediaType: AgentImageType;
  /** Содержимое в base64, без префикса `data:`. */
  base64: string;
}

/** Расширение имени в нижнем регистре; без точки — пустая строка. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Картинка ли это по имени (для отказа при вложении). */
export function isAgentImageName(name: string): boolean {
  return AGENT_IMAGE_EXTENSIONS.includes(extensionOf(name));
}

/** Тип по имени; не картинка — `undefined`. */
export function agentImageTypeOf(name: string): AgentImageType | undefined {
  const ext = extensionOf(name);
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return undefined;
}

/**
 * Тип по САМИМ байтам. Сервер сверяет его с объявленным: блок с чужим типом
 * API отвергает целиком, и ход падал бы у модели, а не при вложении.
 */
export function sniffAgentImage(bytes: Uint8Array): AgentImageType | undefined {
  if (bytes.length < 12) return undefined;
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Строка, которой реплика человека называет приложенные картинки. Английская:
 * её читает модель (решение D-E — всё, что уходит агенту, по-английски), а
 * окно по ней рисует чипы, так что человек маркер не видит. Одна на фронт,
 * телефон и сервер — как `ATTACHMENTS_MARKER` у чата.
 *
 * Зачем она в тексте реплики, а не рядом: агент панели получает историю
 * текстом, и на следующем ходу модель знает, что картинка была, хотя самой
 * картинки уже не видит. А сверка истории вкладки с файлом разговора идёт по
 * тексту — строка, добавленная только сервером, делала бы каждую вкладку
 * «отставшей».
 */
export const AGENT_IMAGES_MARKER = 'Attached images:';

/** Реплика с названными картинками: текст, пустая строка, маркер и имена. */
export function withAgentImagesNote(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  // Имя с «, » (или с кавычкой в начале) — в кавычках JSON: иначе при чтении
  // «a, b.png» становилось двумя картинками (F-328). Простые имена — как были.
  const listed = names.map((name) => (/, |^"/.test(name) ? JSON.stringify(name) : name));
  return `${text}\n\n${AGENT_IMAGES_MARKER} ${listed.join(', ')}`;
}

/** Строка JSON в начале `rest` — её длина и значение; не строка — `undefined`. */
function leadingJsonString(rest: string): { length: number; value: string } | undefined {
  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0];
  if (!quoted) return undefined;
  try {
    return { length: quoted.length, value: JSON.parse(quoted) as string };
  } catch {
    return undefined;
  }
}

/** Разрезать реплику на текст и имена картинок. Без маркера — картинок нет. */
export function splitAgentImages(text: string): { text: string; images: string[] } {
  const at = text.lastIndexOf(`\n\n${AGENT_IMAGES_MARKER} `);
  if (at < 0) return { text, images: [] };
  const images: string[] = [];
  let rest = text.slice(at + AGENT_IMAGES_MARKER.length + 3);
  while (rest.length > 0) {
    const quoted = leadingJsonString(rest);
    const end = quoted ? quoted.length : rest.indexOf(', ');
    const name = quoted ? quoted.value : (end < 0 ? rest : rest.slice(0, end)).trim();
    if (name) images.push(name);
    if (end < 0) break;
    rest = rest.slice(end).replace(/^, /, '');
  }
  return { text: text.slice(0, at), images };
}
