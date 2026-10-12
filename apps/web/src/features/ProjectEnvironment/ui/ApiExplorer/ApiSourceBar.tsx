import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddApiSource, useImportPostman, useRemoveApiSource } from '@entities/ApiExplorer';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { TextField } from '@shared/ui/text-field';
import { apiErrorText } from '../../lib/apiError';
import type { ApiSourceBarProps } from './ApiExplorer.types';
import styles from './ApiExplorer.module.scss';

/**
 * Откуда эндпоинты: выбор контракта, «Обновить», свой адрес и импорт Postman.
 * Если контракта нет нигде — здесь же объяснение, где панель искала: пустой
 * список без слова «где» заставляет гадать.
 */
export function ApiSourceBar({
  projectPath,
  info,
  selected,
  spec,
  onSelect,
  onRefresh,
  isRefreshing,
  onAskContract,
}: ApiSourceBarProps) {
  const { t } = useTranslation();
  const fileInputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const add = useAddApiSource(projectPath);
  const importPostman = useImportPostman(projectPath);
  const remove = useRemoveApiSource(projectPath);
  const [urlForm, setUrlForm] = useState(false);
  const [url, setUrl] = useState('');
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<string>();

  const options = info.sources.map((source) => ({
    value: source.id,
    label: `${source.label} — ${t(`environment.api.sourceKinds.${source.kind}`)}${
      source.kind === 'url' && !source.removable ? `, ${t('environment.api.sourceFound')}` : ''
    }`,
  }));

  const submitUrl = (): void => {
    if (!url.trim() || add.isPending) return;
    setFailure(undefined);
    add.mutate(url.trim(), {
      onSuccess: (data) => {
        setUrlForm(false);
        setUrl('');
        onSelect(data.sourceId);
      },
      onError: (error) => setFailure(apiErrorText(error, t)),
    });
  };

  const readFile = (file: File): void => {
    setFailure(undefined);
    file
      .text()
      .then((content) =>
        importPostman.mutate(
          { content, name: file.name.replace(/\.postman_collection\.json$|\.json$/i, '') },
          {
            onSuccess: (data) => onSelect(data.sourceId),
            onError: (error) => setFailure(apiErrorText(error, t)),
          },
        ),
      )
      .catch((error: unknown) =>
        setFailure(t('environment.api.errors.fileRead', { message: String(error) })),
      );
  };

  return (
    <div className={styles.bar}>
      <div className={styles.barRow}>
        {options.length > 0 && (
          <div className={styles.picker}>
            <SelectField
              label={t('environment.api.source')}
              value={selected?.id ?? ''}
              onChange={onSelect}
              options={options}
            />
          </div>
        )}
        <div className={styles.barActions}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="refresh" size={16} />}
            isLoading={isRefreshing}
            onClick={onRefresh}
            title={t('environment.api.refreshHint')}
          >
            {t('environment.api.refresh')}
          </Button>
          {selected?.removable && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={16} />}
              onClick={() => setRemoving(true)}
            >
              {t('environment.api.removeSource')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="link" size={16} />}
            onClick={() => setUrlForm((open) => !open)}
            aria-expanded={urlForm}
          >
            {t('environment.api.addUrl')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="file" size={16} />}
            isLoading={importPostman.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {t('environment.api.importPostman')}
          </Button>
          <input
            id={fileInputId}
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className={styles.fileInput}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) readFile(file);
            }}
          />
          {onAskContract && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="chat" size={16} />}
              onClick={onAskContract}
              title={t('environment.api.askContractHint')}
            >
              {t('environment.api.askContract')}
            </Button>
          )}
        </div>
      </div>

      {urlForm && (
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            submitUrl();
          }}
        >
          <div className={styles.grow}>
            <TextField
              label={t('environment.api.urlForm.label')}
              value={url}
              onChange={setUrl}
              placeholder="http://localhost:8080/v3/api-docs"
              hint={t('environment.api.urlForm.hint')}
              isMono
              autoFocus
            />
          </div>
          <div className={styles.formActions}>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={add.isPending}
              disabled={!url.trim()}
            >
              {t('environment.api.urlForm.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setUrlForm(false)}>
              {t('environment.api.urlForm.cancel')}
            </Button>
          </div>
        </form>
      )}

      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      {info.sources.length === 0 ? (
        <div className={styles.notice} data-tone="info" role="status">
          <p className={styles.noticeTitle}>
            <Icon name="info" size={16} />
            {t('environment.api.notFoundTitle')}
          </p>
          <p>{t('environment.api.notFoundText')}</p>
          {info.services.length > 0 && (
            <p className={styles.sub}>
              {t('environment.api.notFoundServices', {
                list: info.services.map((service) => `${service.name} (${service.url})`).join(', '),
              })}
            </p>
          )}
        </div>
      ) : (
        <div className={styles.facts}>
          {selected && (
            <Badge tone="neutral">{t(`environment.api.sourceKinds.${selected.kind}`)}</Badge>
          )}
          <span className={styles.sub}>
            {spec
              ? t('environment.api.specMeta', {
                  title: spec.version ? `${spec.title} ${spec.version}` : spec.title,
                  format: spec.format === 'postman' ? 'Postman' : `OpenAPI ${spec.format}`,
                  count: spec.endpoints.length,
                })
              : t('environment.api.specLoading')}
          </span>
        </div>
      )}
      {spec && spec.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {spec.warnings.map((warning) => (
            <li key={`${warning.code}-${warning.detail ?? ''}`}>
              {t(`environment.api.warnings.${warning.code}`, {
                count: warning.count ?? 0,
                detail: warning.detail ?? '',
              })}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={removing}
        onOpenChange={setRemoving}
        onConfirm={() => {
          setRemoving(false);
          if (!selected) return;
          remove.mutate(selected.id, {
            onSuccess: () => onSelect(''),
            onError: (error) => setFailure(apiErrorText(error, t)),
          });
        }}
        title={t('environment.api.removeTitle', { label: selected?.label ?? '' })}
        description={t('environment.api.removeText')}
        confirmLabel={t('environment.api.removeSource')}
      />
    </div>
  );
}
