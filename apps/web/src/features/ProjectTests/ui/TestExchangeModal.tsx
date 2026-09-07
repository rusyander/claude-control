import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestImportResult } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import {
  exportUrl,
  useImportTestCases,
  useImportTestResults,
  type CasesFormat,
  type ResultsFormat,
} from '@entities/ProjectTest';
import type { TestExchangeModalProps } from './TestExchangeModal.types';
import styles from './ProjectTests.module.scss';

const RESULTS_FORMATS: ResultsFormat[] = ['junit', 'playwright', 'allure'];
const CASES_FORMATS: CasesFormat[] = ['csv', 'xlsx', 'testrail-csv'];
const EXPORT_FORMATS = ['csv', 'xlsx', 'md'] as const;

/** Книга Excel — байты, всё остальное разбирается как текст. */
async function readFile(file: File, isBinary: boolean): Promise<string> {
  if (!isBinary) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Обмен: результаты из CI, кейсы из таблиц, выгрузка группы файлом.
 *
 * Панель — не единственное место, где живут тесты: прогон в CI, чужая TMS и
 * выгрузка для отчёта существуют независимо от неё. Всё это уже умеют сервер и
 * `pnpm tests`, но человек, который открыл раздел, командной строки может и не
 * знать — здесь те же операции нажимаются.
 *
 * Файл берётся ЛИБО путём внутри проекта, ЛИБО выбором с диска: отчёт CI лежит
 * в самом репозитории, и назвать `test-results/junit.xml` короче, чем искать его
 * в диалоге.
 */
export function TestExchangeModal({
  isOpen,
  onOpenChange,
  path,
  groupId,
  environments,
}: TestExchangeModalProps) {
  const { t } = useTranslation();

  const [resultsFormat, setResultsFormat] = useState<ResultsFormat>('junit');
  const [resultsFile, setResultsFile] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [casesFormat, setCasesFormat] = useState<CasesFormat>('csv');
  const [casesFile, setCasesFile] = useState('');
  const [exportFormat, setExportFormat] = useState<string>('csv');

  const [done, setDone] = useState<ProjectTestImportResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  const resultsInput = useRef<HTMLInputElement>(null);
  const casesInput = useRef<HTMLInputElement>(null);

  const importResults = useImportTestResults(path);
  const importCases = useImportTestCases(path);

  const run = async (send: () => Promise<ProjectTestImportResult>): Promise<void> => {
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await send());
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const sendResults = (content?: string): Promise<void> =>
    run(() =>
      importResults.mutateAsync({
        format: resultsFormat,
        content,
        file: content ? undefined : resultsFile.trim() || undefined,
        environmentId: environmentId || undefined,
      }),
    );

  const sendCases = (content?: string): Promise<void> =>
    run(() =>
      importCases.mutateAsync({
        groupId,
        format: casesFormat,
        content,
        file: content ? undefined : casesFile.trim() || undefined,
      }),
    );

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('tests.exchange.title')}
      description={t('tests.exchange.hint')}
      size="md"
    >
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.exchange.results')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.exchange.resultsHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap align="end">
            <SelectField
              label={t('tests.exchange.format')}
              value={resultsFormat}
              onChange={(value) => setResultsFormat(value as ResultsFormat)}
              options={RESULTS_FORMATS.map((value) => ({
                value,
                label: t(`tests.exchange.formatName.${value}`),
              }))}
            />
            <SelectField
              label={t('tests.exchange.environment')}
              value={environmentId}
              onChange={setEnvironmentId}
              options={[
                { value: '', label: t('tests.exchange.anyEnvironment') },
                ...environments.map((item) => ({ value: item.id, label: item.title })),
              ]}
            />
            <div className={styles.halfField}>
              <TextField
                label={t('tests.exchange.file')}
                hint={t('tests.exchange.fileHint')}
                value={resultsFile}
                onChange={setResultsFile}
                isMono
              />
            </div>
          </Stack>
          <Stack direction="row" gap="var(--spacing-2xs)" wrap align="center">
            {/* Нативный input скрыт: системная надпись не переводится. */}
            <input
              ref={resultsInput}
              type="file"
              accept=".xml,.json,.txt"
              className={styles.file}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file, false).then((content) => sendResults(content));
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              isLoading={importResults.isPending}
              disabled={resultsFile.trim().length === 0}
              onClick={() => void sendResults()}
            >
              {t('tests.exchange.importFromProject')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="paperclip" size={16} />}
              onClick={() => resultsInput.current?.click()}
            >
              {t('tests.exchange.pickFile')}
            </Button>
          </Stack>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.exchange.cases', { group: groupId })}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.exchange.casesHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap align="end">
            <SelectField
              label={t('tests.exchange.format')}
              value={casesFormat}
              onChange={(value) => setCasesFormat(value as CasesFormat)}
              options={CASES_FORMATS.map((value) => ({
                value,
                label: t(`tests.exchange.formatName.${value}`),
              }))}
            />
            <div className={styles.halfField}>
              <TextField
                label={t('tests.exchange.file')}
                hint={t('tests.exchange.fileHint')}
                value={casesFile}
                onChange={setCasesFile}
                isMono
              />
            </div>
          </Stack>
          <Stack direction="row" gap="var(--spacing-2xs)" wrap align="center">
            <input
              ref={casesInput}
              type="file"
              accept=".csv,.xlsx,.txt"
              className={styles.file}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void readFile(file, casesFormat === 'xlsx').then((content) => sendCases(content));
                }
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              isLoading={importCases.isPending}
              disabled={groupId.length === 0 || casesFile.trim().length === 0}
              onClick={() => void sendCases()}
            >
              {t('tests.exchange.importFromProject')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="paperclip" size={16} />}
              disabled={groupId.length === 0}
              onClick={() => casesInput.current?.click()}
            >
              {t('tests.exchange.pickFile')}
            </Button>
          </Stack>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.exchange.export', { group: groupId })}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('tests.exchange.exportHint')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap align="end">
            <SelectField
              label={t('tests.exchange.format')}
              value={exportFormat}
              onChange={setExportFormat}
              options={EXPORT_FORMATS.map((value) => ({
                value,
                label: t(`tests.exchange.formatName.${value}`),
              }))}
            />
            {/* Обычная ссылка: имя файла приходит от сервера, а собранный в
                памяти blob пришлось бы ещё и освобождать. */}
            <a
              className={styles.exportLink}
              href={exportUrl(path, groupId, exportFormat as (typeof EXPORT_FORMATS)[number])}
              download
            >
              {t('tests.exchange.download')}
            </a>
          </Stack>
        </Stack>

        {error && (
          <Typography variant="caption" color="danger">
            {error}
          </Typography>
        )}

        {done && (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap align="center">
            <Badge tone="success">{t('tests.exchange.read', { count: done.read })}</Badge>
            <Badge tone="info">{t('tests.exchange.matched', { count: done.matched })}</Badge>
            {done.created > 0 && (
              <Badge tone="info">{t('tests.exchange.created', { count: done.created })}</Badge>
            )}
            {done.unmatched.length > 0 && (
              <Badge tone="warning">
                {t('tests.exchange.unmatched', {
                  count: done.unmatched.length,
                  names: done.unmatched.slice(0, 3).join(', '),
                })}
              </Badge>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
