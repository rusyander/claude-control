import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Platform, PlatformAgent, PlatformAgentAnswer } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import {
  useAgentSession,
  useAskAgent,
  useResetAgentSession,
  useSavePlatform,
} from '@entities/Platform';
import {
  askBlocker,
  newSessionId,
  outcomeTone,
  sessionLine,
  warnsCut,
  warnsSessionGap,
} from './lib/agentsView';
import styles from './PlatformPage.module.scss';
import { serverFieldText } from '@shared/config/i18n';

interface AgentsCardProps {
  platform: Platform;
  hasToken: boolean;
}

/**
 * Агенты контура: спросить агента компании прямо из панели.
 *
 * Список агентов человек ведёт САМ, и это не упущение мастера: публичная
 * поверхность ключа — семь маршрутов, и «дай список агентов» среди них нет.
 * Поэтому рядом со списком стоит подпись `agents-manual-roster`, а не пустое
 * место, из которого человек делает вывод, что панель что-то потеряла.
 *
 * Исход вызова показывается РАЗНЫМ: «агентов нет в лицензии компании» — не
 * ошибка и красным не подсвечивается, иначе человек идёт чинить то, что не
 * ломалось. Сессию ведёт контур, поэтому её видно и её можно сбросить — своей
 * копии переписки панель не держит.
 */
export function AgentsCard({ platform, hasToken }: AgentsCardProps) {
  const { t } = useTranslation();
  const save = useSavePlatform();
  const ask = useAskAgent();
  const reset = useResetAgentSession();

  const [agentId, setAgentId] = useState(platform.agents[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const [draft, setDraft] = useState<PlatformAgent>({ id: '', title: '' });
  const [sessionId, setSessionId] = useState('');
  const [answer, setAnswer] = useState<PlatformAgentAnswer | undefined>();

  const session = useAgentSession(platform.id, sessionId, sessionId !== '');
  const line = sessionLine(session);
  const blocker = askBlocker(platform, hasToken, agentId, question);

  const addAgent = (): void => {
    const next = { id: draft.id.trim(), title: draft.title.trim() };
    if (!next.id || !next.title) return;
    save.mutate({ platform: { ...platform, agents: [...platform.agents, next] } });
    setAgentId(next.id);
    setDraft({ id: '', title: '' });
  };

  const removeAgent = (id: string): void => {
    save.mutate({
      platform: { ...platform, agents: platform.agents.filter((agent) => agent.id !== id) },
    });
    if (agentId === id) setAgentId('');
  };

  const send = (): void => {
    if (blocker) return;
    // Сессия заводится на нашей стороне: у контура нет ручки «заведи сессию»,
    // она появляется в момент первого хода с этим идентификатором. Значит, до
    // удачного хода её на контуре НЕТ — и придуманный нами идентификатор
    // сбрасывается обратно, иначе карточка показывала бы сессию, о которой
    // контур не знает. Сессию, заведённую прошлыми ходами, неудача не трогает.
    const known = sessionId;
    const id = known || newSessionId();
    setSessionId(id);
    const forget = (): void => {
      if (!known) setSessionId('');
    };
    ask.mutate(
      { id: platform.id, agent: agentId, message: question.trim(), session: id },
      {
        onSuccess: (result) => {
          setAnswer(result);
          // Вопрос стираем только у дошедшего хода: после отказа человек
          // повторяет его кнопкой, а не набирает заново.
          if (result.outcome === 'ok') setQuestion('');
          else forget();
        },
        onError: forget,
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <Typography variant="body" weight="medium" as="h2">
              {t('platform.agentsTitle')}
            </Typography>
            <CompromiseMark id="agents-manual-roster" />
          </Stack>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.agentsOwner')}
          </Typography>
        </Stack>

        {/* Список агентов. Пустой — это норма для только что подключённого
            контура, и объяснять надо не «нет данных», а откуда берётся id. */}
        {platform.agents.length === 0 ? (
          <Typography variant="body-sm" color="muted">
            {t('platform.agentsEmpty')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-2xs)">
            {platform.agents.map((agent) => (
              <Stack
                key={agent.id}
                direction="row"
                gap="var(--spacing-xs)"
                align="center"
                justify="between"
                wrap
              >
                <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                  <Badge tone={agent.id === agentId ? 'info' : 'neutral'}>{agent.title}</Badge>
                  <Typography variant="caption" color="subtle" as="span">
                    {agent.id}
                  </Typography>
                </Stack>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAgent(agent.id)}
                  aria-label={t('platform.agentsRemove', { title: agent.title })}
                >
                  <Icon name="trash" size={16} />
                </Button>
              </Stack>
            ))}
          </Stack>
        )}

        <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
          <Stack flex={1} minWidth="10rem">
            <TextField
              label={t('platform.agentsNewTitle')}
              value={draft.title}
              onChange={(value) => setDraft({ ...draft, title: value })}
            />
          </Stack>
          <Stack flex={1} minWidth="12rem">
            <TextField
              label={t('platform.agentsNewId')}
              value={draft.id}
              onChange={(value) => setDraft({ ...draft, id: value })}
              placeholder={t('platform.agentsNewIdHint')}
              isMono
            />
          </Stack>
          <Button variant="secondary" onClick={addAgent} disabled={!draft.id || !draft.title}>
            {t('platform.agentsAdd')}
          </Button>
        </Stack>

        {platform.agents.length > 0 && (
          <Stack gap="var(--spacing-xs)">
            <SelectField
              label={t('platform.agentsPick')}
              value={agentId}
              onChange={setAgentId}
              options={platform.agents.map((agent) => ({ value: agent.id, label: agent.title }))}
            />
            <TextField
              label={t('platform.agentsQuestion')}
              value={question}
              onChange={setQuestion}
              multiline
              rows={3}
            />
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Button onClick={send} disabled={blocker !== '' || ask.isPending}>
                {ask.isPending ? t('platform.agentsAsking') : t('platform.agentsAsk')}
              </Button>
              {/* Причину, по которой спросить нельзя, называем словами: четыре
                  разные беды чинятся в четырёх разных местах. */}
              {blocker && (
                <Typography variant="caption" color="muted">
                  {t(`platform.agentsBlocked.${blocker}`)}
                </Typography>
              )}
            </Stack>
          </Stack>
        )}

        {answer && (
          <Stack gap="var(--spacing-2xs)" className={styles.journal}>
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Badge tone={outcomeTone(answer.outcome)}>
                {t(`platform.agentsOutcome.${answer.outcome}`)}
              </Badge>
              <Typography variant="caption" color="muted" as="span">
                {serverFieldText(answer, 'detail')}
              </Typography>
            </Stack>
            {answer.text && (
              <Typography variant="body-sm" style={{ whiteSpace: 'pre-wrap' }}>
                {answer.text}
              </Typography>
            )}
            {/* Агент не договорил: предел вывода, фильтр, время. Зелёный
                «Ответил» над оборванным текстом — законченный ответ на вид. */}
            {warnsCut(answer) && (
              <Typography variant="caption" color="warning">
                {t('platform.agentsCut', { reason: answer.finishReason })}
              </Typography>
            )}
            {/* Ответ настоящий, а сессия не пополнилась: без этой строки человек
                узнал бы о дыре только по «забывшему» агенту. */}
            {warnsSessionGap(answer) && (
              <Typography variant="caption" color="warning">
                {t('platform.agentsSessionGap')}
              </Typography>
            )}
          </Stack>
        )}

        {sessionId && (
          <Stack gap="var(--spacing-2xs)" className={styles.journal}>
            <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between" wrap>
              <Typography variant="caption" color="muted">
                {t('platform.agentsSession', { id: sessionId })}
              </Typography>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  reset.mutate(
                    { id: platform.id, sessionId },
                    {
                      onSuccess: () => {
                        setSessionId('');
                        setAnswer(undefined);
                      },
                    },
                  )
                }
              >
                {t('platform.agentsSessionReset')}
              </Button>
            </Stack>
            {/* Переписку показывает КОНТУР, а не наша копия: разошедшаяся копия
                означала бы, что человек читает не то, из чего агент отвечает.
                Пока чтение идёт — не утверждаем ничего: «контур ничего не
                помнит» это факт о ЕГО хранилище, а не о нашем незнании. */}
            {line !== 'unknown' && (
              <Typography variant="caption" color={line === 'failed' ? 'warning' : 'subtle'}>
                {line === 'kept'
                  ? t('platform.agentsSessionKept', { count: session.data?.total ?? 0 })
                  : t(`platform.agentsSession${line === 'empty' ? 'Empty' : 'Unread'}`)}
              </Typography>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
