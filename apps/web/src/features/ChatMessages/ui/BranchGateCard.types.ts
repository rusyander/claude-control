import type { BranchGateChild } from '@shared/lib/agent-runs';

/** Придержанная первая правка: где именно агент собирался писать. */
export interface PendingBranchGate {
  toolName: string;
  input: unknown;
  toolUseId: string;
  cwd: string;
  branch: string;
  /** Работа разговора отдана группам — кнопка отказа передаёт правку им (Д15). */
  children?: BranchGateChild[];
  /** Ветка MR детей: от неё встанет копия. */
  base?: string;
}

export interface BranchGateCardProps {
  gates: PendingBranchGate[];
  /**
   * Ответ уходит на сервер и МОЖЕТ не пройти: имя ветки занято, копия грязная.
   * Поэтому обещание, а не «выстрелил и забыл», — карточка гасится по успеху, а
   * отказ остаётся у поля с именем.
   */
  onDecide: (
    toolUseId: string,
    choice: 'copy' | 'here' | 'stop',
    branch?: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
}
