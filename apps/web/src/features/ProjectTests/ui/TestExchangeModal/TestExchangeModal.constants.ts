import type { ResultsFormat, CasesFormat } from '@entities/ProjectTest';

export const RESULTS_FORMATS: ResultsFormat[] = ['junit', 'playwright', 'allure'];

export const CASES_FORMATS: CasesFormat[] = ['csv', 'xlsx', 'testrail-csv', 'markdown'];

export const EXPORT_FORMATS = ['csv', 'xlsx', 'md'] as const;
