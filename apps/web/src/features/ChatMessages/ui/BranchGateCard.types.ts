/** Придержанная первая правка: где именно агент собирался писать. */
export interface PendingBranchGate {
  toolName: string;
  input: unknown;
  toolUseId: string;
  cwd: string;
  branch: string;
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
