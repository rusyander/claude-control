import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangelogKind } from '@agentdeck/contracts/changelog';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { formatDate } from '@shared/lib/formatDate';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { ChangelogAreaBar } from '../ChangelogAreaBar/ChangelogAreaBar';
import { KIND_COLOR, KIND_ORDER } from '../model/kinds';
import { pickText } from '../model/pickText';
import type { ChangelogEntryCardProps } from './ChangelogEntryCard.types';
import styles from './ChangelogEntryCard.module.scss';

interface Shot {
  url: string;
  caption: string;
}

/**
 * Выпуск ленты «Что нового» — большой аккордеон. Шапка (вся строка — одна
 * кнопка) несёт то, по чему выпуск находят глазами: дату, заголовок, пометки,
 * счётчики по видам изменений и итог по строкам. Тело — вводная, пункты по видам,
 * полоса «Что затронуто», снимки, ссылки и коммиты, свёрнутые отдельно.
 */
export function ChangelogEntryCard({ entry, isOpen, onToggle }: ChangelogEntryCardProps) {
  const { t, i18n } = useTranslation();
  const bodyId = useId();
  const titleId = useId();
  const [shot, setShot] = useState<Shot | null>(null);
  const [commitsOpen, setCommitsOpen] = useState(false);
  const language = i18n.language;
  const number = (n: number): string => n.toLocaleString(language);
  const isTree = entry.source === 'tree';
  // Заголовок и пояснение карточки правок рабочей копии даёт вкладка: сервер русских строк не выдаёт.
  const title = isTree ? t('changelog.tree.title') : pickText(entry.title, language);

  // Счётчики шапки: пунктов каждого вида; у выпуска без пунктов — один на главный вид.
  const counts = new Map<ChangelogKind, number>();
  for (const item of entry.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  if (counts.size === 0 && !isTree) counts.set(entry.kind, 1);

  const kindLabel = (kind: ChangelogKind): string => t(`changelog.kinds.${kind}`);
  const hasStats = entry.totals.files > 0;

  const openShot = (url: string, caption: string): void => setShot({ url, caption });
  const roleLabel = (role: 'before' | 'after' | 'shot' | undefined): string | undefined =>
    role ? t(`changelog.image.${role}`) : undefined;

  const copyHash = (hash: string): void => {
    // Буфер обмена может быть закрыт (не защищённый адрес, запрет страницы) — тихо, это удобство.
    void navigator.clipboard?.writeText(hash).catch(() => undefined);
  };

  return (
    <Card padding="none" isRaised={isOpen}>
      <button
        type="button"
        className={cn(styles.header, isOpen && styles.headerOpen)}
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        id={titleId}
        data-changelog-entry={entry.id}
      >
        <Icon name="chevronRight" size={22} className={cn(styles.chevron, isOpen && styles.open)} />
        <span className={styles.headMain}>
          <span className={styles.title}>{title}</span>
          <span className={styles.meta}>
            <Typography variant="body-sm" color="muted" as="span">
              {entry.status === 'pending'
                ? formatDateTime(entry.date, language)
                : formatDate(entry.date, language)}
            </Typography>
            {entry.status === 'pending' && !isTree && (
              <Badge tone="warning">{t('changelog.badge.pending')}</Badge>
            )}
            {entry.source === 'git' && <Badge tone="neutral">{t('changelog.badge.git')}</Badge>}
            {isTree && <Badge tone="neutral">{t('changelog.badge.tree')}</Badge>}
            {KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => (
              <span
                key={kind}
                className={styles.kindCount}
                title={`${kindLabel(kind)}: ${counts.get(kind)}`}
              >
                <span className={styles.dot} style={{ background: KIND_COLOR[kind] }} />
                <span className={styles.kindName}>{kindLabel(kind)}</span> {counts.get(kind)}
              </span>
            ))}
          </span>
        </span>
        {hasStats && (
          <span className={styles.totals}>
            <span
              className={styles.added}
              aria-label={t('changelog.linesAdded', { count: entry.totals.insertions })}
            >
              +{number(entry.totals.insertions)}
            </span>{' '}
            <span
              className={styles.removed}
              aria-label={t('changelog.linesRemoved', { count: entry.totals.deletions })}
            >
              −{number(entry.totals.deletions)}
            </span>
            <span className={styles.files}>
              {' · '}
              {t('changelog.filesTotal', { files: number(entry.totals.files) })}
            </span>
          </span>
        )}
      </button>

      {isOpen && (
        <div className={styles.body} id={bodyId} role="region" aria-labelledby={titleId}>
          {isTree && (
            <Typography variant="body" color="muted">
              {t('changelog.tree.summary')}
            </Typography>
          )}
          {entry.summary && (
            <Typography variant="body" color="muted" className={styles.summary}>
              {pickText(entry.summary, language)}
            </Typography>
          )}

          {KIND_ORDER.map((kind) => {
            const items = entry.items.filter((item) => item.kind === kind);
            if (items.length === 0) return null;
            return (
              <section key={kind} className={styles.group}>
                <h3 className={styles.groupTitle}>
                  <span className={styles.dot} style={{ background: KIND_COLOR[kind] }} />
                  {kindLabel(kind)}
                  <span className={styles.groupCount}>{items.length}</span>
                </h3>
                <ul className={styles.items}>
                  {items.map((item, index) => (
                    <li key={index} className={styles.item}>
                      <span className={styles.itemText}>
                        {pickText(item.text, language)}
                        {item.area && (
                          <Badge tone="neutral" className={styles.areaBadge}>
                            {pickText(item.area, language)}
                          </Badge>
                        )}
                      </span>
                      {item.how && (
                        <span className={styles.how}>
                          {t('changelog.how')} {pickText(item.how, language)}
                        </span>
                      )}
                      {item.images.length > 0 && (
                        <span className={styles.thumbs}>
                          {item.images.map((url) => (
                            <button
                              key={url}
                              type="button"
                              className={styles.thumb}
                              onClick={() => openShot(url, pickText(item.text, language))}
                              aria-label={t('changelog.image.open', {
                                name: pickText(item.text, language),
                              })}
                            >
                              <img src={url} alt="" loading="lazy" />
                            </button>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {entry.areas.length > 0 && (
            <section className={styles.group}>
              <h3 className={styles.groupTitle}>{t('changelog.areasLabel')}</h3>
              <ChangelogAreaBar areas={entry.areas} />
            </section>
          )}

          {entry.images.length > 0 && (
            <ul className={styles.gallery}>
              {entry.images.map((image) => {
                const caption = pickText(image.caption, language) || title;
                const role = roleLabel(image.role);
                return (
                  <li key={image.url} className={styles.figure}>
                    <button
                      type="button"
                      className={styles.thumbLarge}
                      onClick={() => openShot(image.url, caption)}
                      aria-label={t('changelog.image.open', { name: caption })}
                    >
                      <img src={image.url} alt={caption} loading="lazy" />
                    </button>
                    <span className={styles.figCaption}>
                      {role && (
                        <Badge tone={image.role === 'before' ? 'warning' : 'success'}>{role}</Badge>
                      )}
                      {pickText(image.caption, language)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {entry.links.length > 0 && (
            <ul className={styles.links}>
              {entry.links.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {pickText(link.label, language)}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {entry.commits.length > 0 && (
            <section className={styles.group}>
              <button
                type="button"
                className={styles.commitsToggle}
                onClick={() => setCommitsOpen((open) => !open)}
                aria-expanded={commitsOpen}
              >
                <Icon
                  name="chevronRight"
                  size={16}
                  className={cn(styles.chevron, commitsOpen && styles.open)}
                />
                {t('changelog.commits', { count: entry.commits.length })}
              </button>
              {commitsOpen && (
                <ul className={styles.commits}>
                  {entry.commits.map((commit) => (
                    <li key={commit.hash} className={styles.commit}>
                      <span className={styles.hash}>
                        <code>{commit.shortHash}</code>
                        <Button
                          iconOnly
                          variant="ghost"
                          size="sm"
                          aria-label={t('changelog.copyHash', { hash: commit.shortHash })}
                          icon={<Icon name="copy" size={14} />}
                          onClick={() => copyHash(commit.hash)}
                        />
                      </span>
                      <span className={styles.subject}>{commit.subject}</span>
                      <Typography variant="caption" color="subtle" as="span">
                        {formatDateTime(commit.date, language)}
                      </Typography>
                      {commit.body && <span className={styles.commitBody}>{commit.body}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      <Modal
        isOpen={shot !== null}
        onOpenChange={(open) => {
          if (!open) setShot(null);
        }}
        title={shot?.caption ?? title}
        size="lg"
      >
        {shot && <img className={styles.lightbox} src={shot.url} alt={shot.caption} />}
      </Modal>
    </Card>
  );
}
