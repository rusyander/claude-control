/**
 * Разбор `Get-CimInstance … | ConvertTo-Json -Compress` (Windows PowerShell 5.1).
 *
 * Сам `ConvertTo-Json` управляющие символы экранирует (`\u0007`), но PowerShell пишет вывод в
 * трубу кодовой страницей консоли (OEM), и символы вне её подменяет «похожими»: «•» (U+2022) в
 * CP437/CP866 — байт 0x07, то есть сырой BEL посреди строки JSON. `JSON.parse` отвергал ВЕСЬ
 * вывод: один процесс, в чьих аргументах есть «•» (хост сессии qwen с наставлением, проход s10,
 * F3), ронял список остальных, и «Где идёт сессия» отвечала 503 по любой сессии.
 *
 * Поэтому два слоя. Команда начинается с `CIM_UTF8` — вывод в UTF-8, символ доходит как есть
 * (заодно и кириллица в путях, которую OEM-вывод портил). А то, что всё же пришло сырым, и то,
 * что пришло экранированным, заменяется пробелом: U+0000–U+001F вне строки JSON — пробельный
 * разделитель, внутри — обычный символ, так что годный JSON остаётся тем же, а негодный
 * становится годным; в разобранных строках управляющих символов нет.
 *
 * Один объект PowerShell отдаёт объектом, несколько — массивом; ответ всегда массив. BOM в начале
 * снимается. Пустой вывод — пустой список. Не JSON вовсе — исключение (вызывающий читает его
 * «списка нет», не «процессов нет»).
 */

/** Префикс команды PowerShell: вывод в трубу — UTF-8 без BOM, а не кодовой страницей консоли. */
export const CIM_UTF8 = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ';

const BOM = 0xfeff;
// eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет замены
const CONTROL = /[\x00-\x1F]/g;

export function parseCimJson<T>(stdout: string): T[] {
  const text = stdout.charCodeAt(0) === BOM ? stdout.slice(1) : stdout;
  const raw = text.trim().replace(CONTROL, ' ');
  if (!raw) return [];
  const parsed = JSON.parse(raw, (_key, value: unknown) =>
    typeof value === 'string' ? value.replace(CONTROL, ' ') : value,
  ) as T[] | T;
  return Array.isArray(parsed) ? parsed : [parsed];
}
