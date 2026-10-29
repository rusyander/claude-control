/**
 * Команды ядра этапа 3, что выходят, ядро не загружая: `index.ts mutate …` — прогон мутантов
 * проверки (зона B, 04 §Mutants), `index.ts capture install|remove|status` — захват прогонов
 * сессии (зона D). Каждая зона заменяет свою заглушку модулем в своей папке.
 */

export const MUTATE_COMMAND = 'mutate';
export const CAPTURE_COMMAND = 'capture';

export interface DevCommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

// `mutate` живёт в `verifier/mutate/cli.ts` (зона B), `capture` — в `capture-command.ts` (зона D);
// здесь — только имена команд для разбора argv.
