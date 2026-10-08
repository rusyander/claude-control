/**
 * Ответ `kimi -p` в текстовом виде — снятие оформления стенограммы (D4).
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО (`kimi` Command, раздел про `-p`): вывод — «стенограмма»,
 * текст ассистента начинается с `• `, перенесённые строки сдвинуты на два
 * пробела; в stdout идёт только текст ассистента, а размышления, ход
 * инструментов и подсказка «как вернуться к сессии» — в stderr. Живьём на 2.1.1
 * (06.10.2026): каждое сообщение ассистента — строка `• <первая строка>`, все
 * его следующие строки — с отступом в два пробела (пустая строка остаётся
 * пустой), после сообщения — пустая строка; переноса по ширине окна нет ни без
 * терминала, ни при `COLUMNS=40`.
 *
 * Почему не `--output-format stream-json`: тот же argv запускает и ассистента
 * форм (`assistant-runner/cli.ts`), а он разбор stdout не применяет — там
 * ответом стали бы сырые строки JSON. Текстовый вид обратим без потерь, и
 * ассистенту форм хуже не становится.
 *
 * Обратное преобразование: строка с `• ` в начале открывает сообщение,
 * отступ в два пробела снимается, пустые строки придерживаются до следующей
 * строки текста — пустая строка после сообщения разделитель, а не ответ.
 * Сообщения склеиваются пустой строкой, как у живого хода (`kimi-server.ts`).
 * Строка не по форме (без маркера и без отступа) не выбрасывается — уходит как
 * есть: потерять слово ответа хуже, чем показать лишний символ.
 */

const BULLET = '• ';
const INDENT = '  ';

export interface KimiTranscriptParser {
  push(chunk: string): string;
  end(): string;
}

export function kimiTranscriptParser(): KimiTranscriptParser {
  let pending = '';
  let started = false;
  let blanks = 0;

  const line = (raw: string): string => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text === '') {
      if (started) blanks += 1;
      return '';
    }
    if (text.startsWith(BULLET)) {
      const lead = started ? '\n\n' : '';
      started = true;
      blanks = 0;
      return lead + text.slice(BULLET.length);
    }
    const body = text.startsWith(INDENT) ? text.slice(INDENT.length) : text;
    // До первого маркера — текст не по форме: отдаём как есть, без склейки.
    if (!started) {
      started = true;
      return body;
    }
    const gap = '\n'.repeat(blanks + 1);
    blanks = 0;
    return gap + body;
  };

  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      return parts.map(line).join('');
    },
    end() {
      const rest = pending;
      pending = '';
      return rest ? line(rest) : '';
    },
  };
}
