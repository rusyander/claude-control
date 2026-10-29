/** Типы для тестов сервера и конфигов vitest, которые зовут отказ посреди чужого mustfail. */
export interface ForeignMutation {
  file: string;
  pid: number;
  started: string;
  files: string[];
  unreadable?: true;
}
export function foreignMutation(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isAlive?: (pid: number) => boolean;
}): ForeignMutation | null;
export function describeMutation(m: ForeignMutation): string;
export function setup(): void;
