import type { ProjectTestReport } from '@agentdeck/contracts';

/** Сколько всего кейсов в раскладке по автоматизации — знаменатель её полосы. */
export function automationTotal(report: ProjectTestReport): number {
  const { manual, toAutomate, automated } = report.automation;
  return manual + toAutomate + automated;
}
