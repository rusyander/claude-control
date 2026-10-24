import type { FindPlan } from './find.ts';
import type { InterpreterCode } from './interpreters.ts';
import type { Word } from './shell-parse.ts';

/**
 * Где исполнится сценарий: `same` — в этой же оболочке (`eval`), `child` — в
 * новом процессе, видящем только экспортированное (`bash -c`, F-03),
 * `deferred` — при выходе, с состоянием конца команды (`trap`, F-02), `blind` —
 * неизвестно когда и с каким состоянием (`alias`).
 */
export type ScriptScope = 'same' | 'child' | 'deferred' | 'blind';

export type Unwrapped =
  /**
   * Звено — эта команда (`timeout 60 X`, `env A=1 X`, `cmd /c X`). `cwd` —
   * каталог, куда обёртка уводит команду (`env -C каталог X`): судится там, как
   * после `cd` (ревью 23.10, R-04).
   */
  | { kind: 'command'; words: Word[]; cwd?: Word }
  /** Звено исполнит сценарий оболочки: `bash -c '…'`, `eval '…'`, `trap '…' EXIT`. */
  | { kind: 'script'; script: string; scope: ScriptScope }
  /** Код интерпретатора: `python -c`, `node -e`; без кода — сценарий из файла. */
  | { kind: 'code'; code: InterpreterCode }
  | { kind: 'find'; find: FindPlan }
  /** Обёртка без своей команды: `env`, `nice`, `command -v x` — печать. */
  | { kind: 'reader' }
  /** Исполнит то, чего не прочесть: `eval "$x"`, `bash -c "$s"`, `trap "$h" EXIT`. */
  | { kind: 'danger' };
