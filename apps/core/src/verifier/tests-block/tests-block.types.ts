import type { CheckEntry, CheckRegistry } from '@agentdeck/contracts/core/records';

/** Кейс библиотеки, связанный с автотестом (`automation.status:'automated'` + `file`). */
export interface LinkedCase {
  groupId: string;
  caseId: string;
  /** Файл автотеста от корня проекта (как в кейсе). */
  file: string;
  /** Полный путь vitest «a > b > it»; describe-путь покрывает всё под ним; пусто — весь файл. */
  testName?: string;
}

/** Исход кейса, доказанный одной записью проверки. */
export interface CaseHit {
  groupId: string;
  caseId: string;
  status: 'passed' | 'failed';
  /** Зелёный только на повторе (`pass-flaky`): сколько повторов понадобилось. */
  flakyAttempts?: number;
  /** Упавшие тесты записи, что легли на кейс. */
  failedTests?: { name: string; owner?: string }[];
}

/** Что писателю нужно знать о проверке, кроме записи: её строка реестра и единицы. */
export interface CaseScope {
  entry: CheckEntry;
  units: CheckRegistry['units'];
}
