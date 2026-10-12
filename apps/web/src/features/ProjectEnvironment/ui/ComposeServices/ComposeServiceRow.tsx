import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { isServiceUp, serviceStateView } from '../../lib/serviceState';
import { portUrl } from '../../lib/portUrl';
import type { ComposeServiceRowProps } from './ComposeServices.types';
import styles from './ComposeServices.module.scss';

/**
 * Строка сервиса. Порт работающего — ссылка: «где у меня Postgres» —
 * первый вопрос к окружению. У остановленного порт из файла — просто текст,
 * по ссылке там никто не ответит.
 */
export function ComposeServiceRow({ service, isBusy, onAction }: ComposeServiceRowProps) {
  const { t } = useTranslation();
  const view = serviceStateView(service);
  const up = isServiceUp(service);
  const label = t(`environment.state.${view.key}`, { code: view.code });

  return (
    <tr>
      <th scope="row" className={styles.nameCell}>
        <span className={styles.name}>{service.name}</span>
        {service.dependsOn.length > 0 && (
          <span className={styles.sub}>
            {t('environment.table.dependsOn', { names: service.dependsOn.join(', ') })}
          </span>
        )}
      </th>
      <td>
        {service.image && <code className={styles.mono}>{service.image}</code>}
        {service.build && <span className={styles.sub}>{t('environment.table.build')}</span>}
      </td>
      <td>
        <span className={styles.state} {...(service.status ? { title: service.status } : {})}>
          <StatusDot tone={view.tone} pulse={view.pulse} />
          {label}
        </span>
      </td>
      <td>
        {service.ports.length === 0 ? (
          <span className={styles.sub}>{t('environment.table.noPorts')}</span>
        ) : (
          <ul className={styles.ports}>
            {service.ports.map((port) => {
              const url = service.state === 'running' ? portUrl(port) : undefined;
              const text = `${port.published} → ${port.target}${port.protocol === 'tcp' ? '' : `/${port.protocol}`}`;
              const title = t('environment.table.portTitle', {
                published: port.published,
                target: port.target,
              });
              return (
                <li key={`${port.published}/${port.protocol}`}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" title={title}>
                      {text}
                    </a>
                  ) : (
                    <span title={title}>{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </td>
      <td>
        <div className={styles.rowActions}>
          {up ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="refresh" size={16} />}
                aria-label={t('environment.row.restart', { name: service.name })}
                title={t('environment.row.restart', { name: service.name })}
                disabled={isBusy}
                onClick={() => onAction('restart', service.name)}
              />
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="stop" size={16} />}
                aria-label={t('environment.row.stop', { name: service.name })}
                title={t('environment.row.stop', { name: service.name })}
                disabled={isBusy}
                onClick={() => onAction('stop', service.name)}
              />
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="play" size={16} />}
              aria-label={t('environment.row.up', { name: service.name })}
              title={t('environment.row.up', { name: service.name })}
              disabled={isBusy}
              onClick={() => onAction('up', service.name)}
            />
          )}
        </div>
      </td>
    </tr>
  );
}
