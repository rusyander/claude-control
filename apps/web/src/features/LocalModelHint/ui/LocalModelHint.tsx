import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { LOCAL_MODELS_ROUTE } from '@shared/config/routes';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import {
  JobProgress,
  chatHint,
  jobFor,
  toGb,
  useConnectLocal,
  useLocalModels,
  usePullModel,
} from '@entities/LocalModels';
import styles from './LocalModelHint.module.scss';
import type { LocalModelHintProps } from './LocalModelHint.types';
import { readDismissed } from '../lib/readDismissed';
import { writeDismissed } from '../lib/writeDismissed';

/**
 * Строка вверху раздела «Локальные модели»: какую модель поставить на ЭТУ
 * машину и одна кнопка, которая скачивает, поднимает сервер и отдаёт модель
 * агентам. Загрузка идёт на сервере — закрытая вкладка её не обрывает. Под
 * полем чата её нет (владелец 06.10): там она мешала работе.
 */
export function LocalModelHint({ onReady }: LocalModelHintProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(readDismissed);
  const { data } = useLocalModels({ enabled: !dismissed });
  const pull = usePullModel();
  const connect = useConnectLocal();
  const hint = dismissed ? undefined : chatHint(data);
  // Работа, по окончании которой продолжаем: только та, что запущена отсюда.
  const followed = useRef<string | undefined>(undefined);
  const job = followed.current ? jobFor(data, 'model', followed.current) : undefined;

  useEffect(() => {
    if (!job || job.state === 'running') return;
    followed.current = undefined;
    if (job.state === 'done' && data?.connect.active) onReady?.();
  }, [job, data?.connect.active, onReady]);

  if (!hint) return null;
  const { model, fit } = hint;
  const [low, high] = fit.tokensPerSec;
  const params = { model: model.title, gpu: hint.gpu, low, high, size: toGb(model.sizeBytes) };

  const start = (): void => {
    followed.current = model.tag;
    pull.mutate({ tag: model.tag, connect: true });
  };

  return (
    <div className={styles.root} role="status">
      <div className={styles.line}>
        <Icon name="server" size={16} />
        <Typography variant="body-sm" color="muted" className={styles.text}>
          {hint.kind === 'busy' ? t('localModels.hint.busy', params) : null}
          {hint.kind === 'connect' ? t('localModels.hint.connect', params) : null}
          {hint.kind === 'download'
            ? t(hint.gpu ? 'localModels.hint.download' : 'localModels.hint.downloadNoGpu', params)
            : null}
        </Typography>
        {hint.kind === 'download' ? (
          <Button size="sm" variant="secondary" isLoading={pull.isPending} onClick={start}>
            {t('localModels.hint.downloadButton')}
          </Button>
        ) : null}
        {hint.kind === 'connect' ? (
          <Button
            size="sm"
            variant="secondary"
            isLoading={connect.isPending}
            onClick={() => connect.mutate(model.tag)}
          >
            {t('localModels.hint.connectButton')}
          </Button>
        ) : null}
        <Link to={LOCAL_MODELS_ROUTE}>
          <Typography variant="caption" color="accent">
            {t('localModels.hint.more')}
          </Typography>
        </Link>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="close" size={14} />}
          aria-label={t('localModels.hint.dismiss')}
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
        />
      </div>
      {hint.kind === 'busy' ? <JobProgress job={hint.job} /> : null}
    </div>
  );
}
