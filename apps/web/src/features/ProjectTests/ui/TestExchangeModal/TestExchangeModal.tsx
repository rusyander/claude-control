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
import {
  exportUrl,
  useImportTestCases,
  useImportTestResults,
  type CasesFormat,
  type ResultsFormat,
} from '@entities/ProjectTest';
import { importSource, type ImportSource } from '../../model/importSource';
import type { TestExchangeModalProps, PickedFile } from './TestExchangeModal.types';
import styles from './TestExchangeModal.module.scss';
import { RESULTS_FORMATS, CASES_FORMATS, EXPORT_FORMATS } from './TestExchangeModal.constants';
import { readFile } from '../../lib/readFile';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

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

  // Ручные кейсы уже лежат в проекте: выбирать нечего, каталог необязателен —
  // пустой означает `QA`, и кнопка «Взять из проекта» работает без единого поля.
  const isManual = casesFormat === 'markdown';

  const run = async (send: () => Promise<ProjectTestImportResult>): Promise<void> => {
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await send());
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  /** Пустой выбранный файл получает отказ здесь же и в сеть не уходит. */
  const send = (
    picked: PickedFile | undefined,
    typedPath: string,
    post: (source: ImportSource) => Promise<ProjectTestImportResult>,
  ): Promise<void> => {
    const source = importSource(picked?.content, typedPath);
    if (source === 'empty') {
      setDone(undefined);
      setError(t('tests.exchange.emptyFile', { name: picked?.name ?? '' }));
      return Promise.resolve();
    }
    return run(() => post(source));
  };

  const sendResults = (picked?: PickedFile): Promise<void> =>
    send(picked, resultsFile, (source) =>
      importResults.mutateAsync({
        format: resultsFormat,
        ...source,
        environmentId: environmentId || undefined,
      }),
    );

  const sendCases = (picked?: PickedFile): Promise<void> =>
    send(picked, casesFile, (source) =>
      importCases.mutateAsync({ groupId, format: casesFormat, ...source }),
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
          {/* По верху, а не по низу: у поля файла под вводом подсказка, и при
              выравнивании по низу само поле вставало выше списков рядом. */}
          <Stack direction="row" gap="var(--spacing-xs)" wrap align="start">
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
                if (file) {
                  void readFile(file, false).then((content) =>
                    sendResults({ name: file.name, content }),
                  );
                }
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
            {t(isManual ? 'tests.exchange.casesHintMarkdown' : 'tests.exchange.casesHint')}
          </Typography>
          {/* По верху, а не по низу: у поля файла под вводом подсказка, и при
              выравнивании по низу само поле вставало выше списков рядом. */}
          <Stack direction="row" gap="var(--spacing-xs)" wrap align="start">
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
              {/* У ручных кейсов поле означает КАТАЛОГ: файлов там десятки, и
                  указывать их по одному было бы работой вместо импорта. */}
              <TextField
                label={t(isManual ? 'tests.exchange.folder' : 'tests.exchange.file')}
                hint={t(isManual ? 'tests.exchange.folderHint' : 'tests.exchange.casesFileHint')}
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
                  void readFile(file, casesFormat === 'xlsx').then((content) =>
                    sendCases({ name: file.name, content }),
                  );
                }
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              isLoading={importCases.isPending}
              disabled={groupId.length === 0 || (!isManual && casesFile.trim().length === 0)}
              onClick={() => void sendCases()}
            >
              {t('tests.exchange.importFromProject')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="paperclip" size={16} />}
              disabled={groupId.length === 0 || isManual}
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
