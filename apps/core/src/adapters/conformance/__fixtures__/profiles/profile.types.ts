import type { SessionSpec } from '../../../adapter.types.ts';
import type { SdkAdapter, SdkAdapterOptions } from '../../../sdk-stream/sdk-adapter.ts';
import type { ReplayRun } from '../replay.ts';

/**
 * Профиль переходника для набора соответствия (03 §CLI adapter, P121): как собрать переходник,
 * какие записи живого CLI он проигрывает и как читать то, что CLI получил (argv, файлы сеанса).
 * Один файл на CLI (`profiles/<cli>.ts`): зона нового переходника добавляет свой и не трогает чужие.
 */
export interface Profile {
  id: string;
  make(options: SdkAdapterOptions): SdkAdapter;
  command: string;
  endpoint: SessionSpec['endpoint'];
  fixtures: {
    basic: string;
    resume: { name: string; cmdId: string };
    missing: Omit<ReplayRun, 'dump'>;
    deny: string;
    refused: string;
    permitAllow?: string;
    permitDeny?: string;
    wake?: string;
    /** Запрет оверлея при разрешающем сервере права: CLI отказывает сам, вопроса нет. */
    denyOverPermit?: string;
    /** Ход со строкой окна подписки (`windowEvent`). */
    window?: string;
    /** Ход, кончившийся ошибкой CLI «войдите заново» (`loginLost`, этап 12 P170). */
    loginLost?: string;
  };
  /** Файл сеанса с правилами запрета (относительно каталога сеанса). */
  settings: string;
  denyRules(settings: Record<string, unknown>): string[];
  /** Строгий список MCP: что видит CLI из argv и файлов сеанса. */
  mcpNames(argv: string[], dir: string): string[];
  hookCommands(settings: Record<string, unknown>): string[];
  /** Бриф, как его получил CLI (файлом или значением флага). */
  brief(argv: string[]): string;
  /** Навыки сеанса выключены — по argv CLI (`skillControl`). */
  skillsOff?(argv: readonly string[]): boolean;
  shellRule(argv: readonly string[]): string;
  /** Правило запрета пути в словаре CLI (форма пути у каждого своя). */
  pathRule(cwd: string, path: string, op: 'read' | 'edit'): string;
  /** Как CLI спрашивает о праве: инструментом сервера или строкой протокола. */
  permitRoad: 'tool' | 'in-band';
}
