import { describe, expect, it } from 'vitest';
import { geminiProvider } from './gemini.ts';

/**
 * «Разрешить правки» у Gemini CLI — флагом `--approval-mode` (0.62.0, `gemini --help`:
 * `default | auto_edit | yolo | plan`). Проверено живьём на заглушке модели
 * (`tools/qa/check-cli-gemini.mjs`): в `-p` при `default` инструменты записи
 * (`write_file`, `replace`, `run_shell_command`) модели не объявляются вовсе, и
 * вызов `write_file` получает «Tool not found» — файл цел; при `yolo` объявлены
 * все и выполняются без вопроса. Флаг сильнее `general.defaultApprovalMode`
 * настроек: выключенный переключатель не превращается молча в `auto_edit`.
 */
const args = geminiProvider.assistant!.oneShotArgs!;

describe('gemini: argv одиночного запуска', () => {
  it('включено — yolo, как живой ход, где каждая просьба получает «да»', () => {
    expect(args('P', { allowEdits: true })).toEqual([
      '--approval-mode',
      'yolo',
      '-o',
      'stream-json',
      '-p',
      'P',
    ]);
  });

  it('выключено — default: в -p спросить некого, инструменты записи не объявлены', () => {
    expect(args('P', { allowEdits: false })).toEqual([
      '--approval-mode',
      'default',
      '-o',
      'stream-json',
      '-p',
      'P',
    ]);
  });

  it('без политики (ассистент формы, разбор групп) флага прав нет — решают настройки CLI', () => {
    expect(args('P')).toEqual(['-o', 'stream-json', '-p', 'P']);
    expect(args('P', { model: 'gemini-3.8-flash' })).toEqual([
      '-m',
      'gemini-3.8-flash',
      '-o',
      'stream-json',
      '-p',
      'P',
    ]);
  });

  it('модель и права вместе; промпт — последний элемент', () => {
    const line = args('P', { model: 'gemini-3.8-flash', allowEdits: true });
    expect(line).toEqual([
      '-m',
      'gemini-3.8-flash',
      '--approval-mode',
      'yolo',
      '-o',
      'stream-json',
      '-p',
      'P',
    ]);
    expect(line.at(-1)).toBe('P');
  });

  it('объявление совпадает с кодом: переключатель доходит флагом, вывод разбирается', () => {
    expect(geminiProvider.assistant?.editsControl).toBe('flag');
    // `-o stream-json` без разборщика лёг бы в переписку сырым JSON.
    expect(geminiProvider.assistant?.parseStdout).toBeTypeOf('function');
    // `yolo` пишется только в argv — в settings.json его панель не пишет никогда.
    expect(args('P', { allowEdits: true })).not.toContain('-y');
  });
});
