/**
 * Форма текстового файла — метка порядка байтов (BOM) и стиль перевода строки.
 *
 * Панель правит ЧУЖИЕ рабочие файлы (settings.json Claude/Gemini, config.toml
 * Codex, opencode.json, CLAUDE.md/AGENTS.md/GEMINI.md). У пользователя они вполне
 * могут быть в CRLF (Windows-редактор, git с `core.autocrlf=true`) или начинаться
 * с UTF-8 BOM (Блокнот, PowerShell `>`/`Out-File`). Два следствия, которые нужно
 * снимать в одном месте:
 *
 *  1. **Чтение.** `JSON.parse` и TOML-парсер падают на ведущем U+FEFF, хотя файл
 *     совершенно валиден. Без снятия BOM раздел уходил бы в fail-closed
 *     («формат не распознан») на здоровом конфиге. Поэтому парсим ВСЕГДА без BOM.
 *  2. **Запись.** Если файл в CRLF, а мы вставляем сгенерированный блок с LF (или
 *     переписываем файл целиком результатом `JSON.stringify`), получаются
 *     СМЕШАННЫЕ окончания строк — файл «портится» на вид, ломается git-дифф.
 *     Поэтому итог приводится к форме ИСХОДНОГО файла: был BOM — остаётся BOM,
 *     был CRLF — блок тоже CRLF.
 *
 * Форму НЕ выдумываем: у нового файла её нет, и содержимое пишется как есть.
 */

/** Метка порядка байтов UTF-8 в виде символа (в JS BOM читается как U+FEFF). */
export const BOM_CHAR = '﻿';

/**
 * Форма файла: был ли BOM, какими переводами строк он размечен и кончался ли
 * переводом строки. Последнее — для файлов, которые целиком переписываются из
 * структуры (writeJsonFile): ~/.claude.json Claude Code пишет БЕЗ хвостового
 * перевода строки, и после «выключить → включить» файл должен совпасть байт в
 * байт, а не отличаться одним байтом. Пустой файл формы не задаёт — считаем «с».
 */
export interface TextForm {
  bom: boolean;
  eol: '\n' | '\r\n';
  /** Не задан — считаем «с переводом строки» (форма, собранная руками, без хвоста не спорит). */
  trailingNewline?: boolean;
}

/** Начинается ли текст с BOM. */
export function hasBom(raw: string): boolean {
  return raw.charCodeAt(0) === 0xfeff;
}

/** Текст без ведущего BOM (для парсеров JSON/TOML и для показа в редакторе). */
export function stripBom(raw: string): string {
  return hasBom(raw) ? raw.slice(1) : raw;
}

/**
 * Преобладающий стиль перевода строки. CRLF считаем стилем файла, если таких
 * окончаний не меньше, чем «голых» LF: смешанный файл приводим к более частому,
 * а спорный (поровну) — к CRLF, потому что чистый LF-файл CRLF-ов не содержит.
 */
export function detectEol(raw: string): '\n' | '\r\n' {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return '\n';
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}

/** Форма текста: BOM + стиль переводов строк + хвостовой перевод строки. */
export function detectTextForm(raw: string): TextForm {
  return {
    bom: hasBom(raw),
    eol: detectEol(raw),
    trailingNewline: raw.length === 0 || raw.endsWith('\n'),
  };
}

/**
 * Привести текст к заданной форме: единый стиль переводов строк + BOM, если он
 * был у исходного файла. Любые окончания (CRLF, одиночный CR, LF) нормализуются
 * к `form.eol` — иначе смешанные окончания как раз и появляются, когда браузер
 * присылает CRLF из `<textarea>`, а файл размечен LF.
 */
export function applyTextForm(text: string, form: TextForm): string {
  const body = stripBom(text).replace(/\r\n|\r|\n/g, form.eol);
  return form.bom ? `${BOM_CHAR}${body}` : body;
}

/** Приписать блок с LF-переводами к стилю файла (для хирургической вставки). */
export function blockToEol(block: string, eol: '\n' | '\r\n'): string {
  return eol === '\n' ? block : block.replace(/\r\n|\r|\n/g, eol);
}
