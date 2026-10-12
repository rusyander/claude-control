import type { RunInputRecord } from '@agentdeck/contracts/run-input';

export interface RunInputsProps {
  /** Ключ разговора звена: `sessionId` у Claude, `<провайдер>:<id>` у чужого CLI. */
  inputKey: string;
}

export interface RunInputSectionProps {
  label: string;
  text: string;
}

export interface RunInputRunsProps {
  /** Свежие первыми — как их отдаёт сервер. */
  runs: readonly RunInputRecord[];
}
