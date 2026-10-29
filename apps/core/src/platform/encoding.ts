import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Кодировка вывода внешних инструментов (09 §encoding). Node и git пишут UTF-8, но
 * консольные утилиты Windows (`where`, `reg`, `schtasks`, `netstat`) пишут в кодовой
 * странице консоли — 866 или 1251 на русской системе, и `String(buf)` превращал «не
 * удаётся найти» в кракозябры (замер 28.10: `where <нет такого>` на этой машине).
 *
 * Правило: байты, которые целиком читаются как UTF-8, — UTF-8; иначе — OEM-страница,
 * если она известна; иначе latin1 (байты не теряются, текст хотя бы виден).
 */

const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  65001: 'utf-8',
};

/** Метка WHATWG для кодовой страницы или `undefined` (437, 850 — в Node их нет). */
export function codePageLabel(codePage: number): string | undefined {
  return CODE_PAGE_LABELS[codePage];
}

export function decodeToolOutput(bytes: Uint8Array, codePage?: number): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    // Не UTF-8 — ниже кодовая страница консоли.
  }
  const label = codePage === undefined ? undefined : codePageLabel(codePage);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Метка неизвестна этой сборке Node (без full-icu) — ниже latin1.
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/**
 * OEM-страница из вывода `reg query …\Nls\CodePage /v OEMCP` (`OEMCP    REG_SZ    866`).
 * Чистый разбор: сам запуск `reg.exe` — в `run-tool.ts`, чтобы кодировка не тянула процессы.
 */
export function parseOemCodePage(regOutput: string): number | undefined {
  const match = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(regOutput);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Аргументы git, общие для всех вызовов ядра: имена файлов не в восьмеричных escape
 * (`core.quotepath=off` — иначе русское имя приходит как `"\320\277…"` и сверка путей
 * расходится), и на Windows длинные пути (`core.longpaths`, 03 §Launcher).
 */
export function gitBaseArgs(os: OsKind = currentOs()): string[] {
  const args = ['-c', 'core.quotepath=off'];
  if (os === 'win32') args.push('-c', 'core.longpaths=true');
  return args;
}

/** Перевод строки, которым уже написан текст: правка файла пользователя не меняет его концы строк. */
export function eolOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
