/** Своя команда кейса у копии: строка `--cmd` и, если нужен, `--format` её отчёта. */
export interface CaseCommand {
  cmd: string;
  format?: string;
  /** Когда задана — человеку в `case-cmd` без аргументов. */
  at?: string;
}

/** `группа:кейс` → команда. */
export type CaseCommands = Record<string, CaseCommand>;

/** Как файл оказался вне git: уже игнорировался, дописан в `info/exclude`, не репозиторий вовсе. */
export type ExcludeOutcome = 'ignored' | 'excluded' | 'not-a-repo';
