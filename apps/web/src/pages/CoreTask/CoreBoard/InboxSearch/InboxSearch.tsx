import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InboxSearchReply, InboxSource } from '@agentdeck/contracts/core/inbox';
import { boardMoveRefusalOf, newUuidv7 } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { useInboxCreate, useInboxSearch } from '../Inbox/inboxApi';
import {
  outcomeOf,
  pickedItems,
  searchFailureOf,
  searchProblemOf,
  searchViewOf,
  toggleAll,
  togglePick,
} from './inboxSearch.lib';
import styles from './InboxSearch.module.scss';

const P = 'coreInbox.search';

interface InboxSearchProps {
  sources: InboxSource[];
  onClose: () => void;
  onOpenSources: () => void;
}

/** Ответ поиска вместе с источником, по которому искали: заводится всегда в него. */
interface Searched {
  sourceId: string;
  reply: InboxSearchReply;
}

/** Первый включённый источник — с него поиск и начинается; включённых нет — первый в списке. */
const firstSourceOf = (sources: InboxSource[]) =>
  (sources.find((s) => s.enabled) ?? sources[0])?.id ?? '';

/**
 * Окно «Найти в трекере» (этап 12, I7, D16, P167): поиск по одному источнику и заведение
 * выбранного во «Входящие» одним `POST /v1/inbox`. Запрос человека уходит только в поиск;
 * «неизвестно» источника показано причиной, а не пустым списком; ключ повтора заведения держится,
 * пока выбор не меняли, — повтор после обрыва связи не заведёт записи второй раз.
 */
export function InboxSearch({ sources, onClose, onOpenSources }: InboxSearchProps) {
  const { t } = useTranslation();
  const search = useInboxSearch();
  const create = useInboxCreate();
  const [sourceId, setSourceId] = useState(() => firstSourceOf(sources));
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState<Searched | undefined>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cmdId, setCmdId] = useState(newUuidv7);
  const source = sources.find((s) => s.id === sourceId);
  const items = searched?.reply.items ?? [];
  const view = search.isPending ? 'pending' : searchViewOf(searched?.reply);
  // Проза ядра английская (контракт): текст — своя строка по причине, проза — подсказкой.
  const failure = search.isError ? searchFailureOf(search.error) : undefined;
  const problem =
    view === 'problem' && searched?.reply.problem
      ? searchProblemOf(searched.reply.problem)
      : undefined;

  const repick = (next: Set<string>) => {
    setPicked(next);
    setCmdId(newUuidv7());
    create.reset();
  };

  const run = () => {
    if (!sourceId) return;
    setSearched(undefined);
    repick(new Set());
    search.mutate({ sourceId, q }, { onSuccess: (reply) => setSearched({ sourceId, reply }) });
  };

  const submit = () => {
    if (!searched) return;
    create.mutate({ sourceId: searched.sourceId, items: pickedItems(items, picked), cmdId });
  };

  if (sources.length === 0) {
    return (
      <Modal isOpen onOpenChange={(open) => !open && onClose()} title={t(`${P}.title`)} size="fit">
        <Stack gap="var(--spacing-sm)" data-inbox-search>
          <Typography variant="body-sm" as="p" data-inbox-search-nosources>
            {t(`${P}.noSources`)}
          </Typography>
          <Button variant="secondary" onClick={onOpenSources}>
            {t('coreInbox.bar.sources')}
          </Button>
        </Stack>
      </Modal>
    );
  }

  const outcome = create.data ? outcomeOf(create.data) : undefined;
  const allPicked = items.length > 0 && items.every((item) => picked.has(item.key));

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()} title={t(`${P}.title`)} size="lg">
      <Stack gap="var(--spacing-md)" data-inbox-search>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <Stack gap="var(--spacing-sm)">
            <SelectField
              label={t(`${P}.source`)}
              value={sourceId}
              onChange={setSourceId}
              options={sources.map((s) => ({
                value: s.id,
                label: s.enabled ? s.id : t(`${P}.sourceOff`, { id: s.id }),
              }))}
            />
            <TextField
              label={t(`${P}.query`)}
              value={q}
              onChange={setQ}
              placeholder={t(`${P}.placeholder`)}
              hint={source?.system === 'gitlab' ? t(`${P}.hintGitlab`) : t(`${P}.hintJira`)}
              isMono
            />
            <Stack direction="row" gap="var(--spacing-sm)" align="center">
              <Button
                type="submit"
                leftIcon={<Icon name="search" size={16} />}
                disabled={!sourceId || search.isPending}
                data-inbox-search-run
              >
                {search.isPending ? t(`${P}.running`) : t(`${P}.run`)}
              </Button>
            </Stack>
          </Stack>
        </form>

        {view === 'pending' && (
          <Typography
            variant="body-sm"
            color="subtle"
            as="p"
            role="status"
            data-inbox-search-pending
          >
            {t(`${P}.running`)}
          </Typography>
        )}
        {failure && (
          <Typography
            variant="body-sm"
            color="danger"
            as="p"
            role="alert"
            title={failure.raw}
            data-inbox-search-error
          >
            {t(`${P}.failures.${failure.key}`)}
          </Typography>
        )}
        {problem && (
          <Typography
            variant="body-sm"
            color="danger"
            as="p"
            role="alert"
            title={problem.raw}
            data-inbox-problem
          >
            {t(`${P}.problems.${problem.key}`)}
          </Typography>
        )}
        {view === 'empty' && (
          <Typography variant="body-sm" color="subtle" as="p" data-inbox-search-empty>
            {t(`${P}.empty`)}
          </Typography>
        )}
        {view === 'items' && (
          <Stack gap="var(--spacing-xs)">
            <label className={styles.all}>
              <input
                type="checkbox"
                className={styles.check}
                checked={allPicked}
                onChange={() => repick(toggleAll(picked, items))}
                data-inbox-pick-all
              />
              <Typography variant="body-sm" as="span">
                {t(`${P}.all`)}
              </Typography>
            </label>
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.key} className={styles.item} data-inbox-item={item.key}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={picked.has(item.key)}
                    onChange={() => repick(togglePick(picked, item.key))}
                    aria-label={t(`${P}.pick`, { key: item.key })}
                  />
                  <div className={styles.body}>
                    <Stack direction="row" gap="var(--spacing-xs)" align="baseline" wrap>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        <Typography variant="body-sm" weight="medium" as="span">
                          {item.key}
                        </Typography>
                      </a>
                      <Typography variant="caption" color="subtle" as="span">
                        {t(`${P}.kinds.${item.kind}`)}
                        {item.type ? ` · ${item.type}` : ''}
                      </Typography>
                    </Stack>
                    <Typography variant="body-sm" as="span">
                      {item.title}
                    </Typography>
                    {item.labels.length > 0 && (
                      <Typography variant="caption" color="subtle" as="span">
                        {item.labels.join(', ')}
                      </Typography>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {searched?.reply.truncated && (
              <Typography variant="caption" color="warning" as="p" data-inbox-truncated>
                {t(`${P}.truncated`)}
              </Typography>
            )}
            <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap>
              <Button
                variant="primary"
                onClick={submit}
                disabled={picked.size === 0 || create.isPending}
                isLoading={create.isPending}
                data-inbox-create
              >
                {t(`${P}.create`, { count: picked.size })}
              </Button>
              {outcome && (
                <Typography
                  variant="body-sm"
                  color="success"
                  as="p"
                  role="status"
                  data-inbox-outcome
                >
                  {t(`${P}.outcome`, outcome)}
                </Typography>
              )}
              {create.isError && (
                <Typography
                  variant="body-sm"
                  color="danger"
                  as="p"
                  role="alert"
                  data-inbox-create-error
                >
                  {t(`${P}.failed`, { reason: boardMoveRefusalOf(create.error).reason })}
                </Typography>
              )}
            </Stack>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
