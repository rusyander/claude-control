import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptId } from '@agentdeck/contracts/prompts';
import { usePrompt, usePrompts, useResetPrompt, useSavePrompt } from '@entities/Prompt';
import { toErrorMessage } from '@shared/api/client';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { TextField } from '@shared/ui/text-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';

/**
 * Каталог промптов приложения: тексты, которыми панель разговаривает с моделью
 * НЕ от имени человека — протокол инструментов, агент через контур, преамбула
 * контура, картинка, презентация.
 *
 * Экран устроен как список с открытой карточкой, а не как пять полей подряд:
 * промпт — это страница текста, и пять таких страниц на одном экране человек
 * листает вслепую. Открытый промпт грузится отдельным запросом (`usePrompt`) —
 * список специально дешёвый.
 *
 * Правка держится в СОСТОЯНИИ экрана, пока её не сохранили: автосохранение
 * промпта означало бы, что каждая опечатка уезжает в следующий запрос модели.
 */
export function PromptsCard() {
  const { t } = useTranslation();
  const prompts = usePrompts();
  const [openId, setOpenId] = useState<PromptId | undefined>(undefined);
  const record = usePrompt(openId);
  const save = useSavePrompt();
  const reset = useResetPrompt();

  const [draft, setDraft] = useState('');
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Открыли другой промпт или пришёл ответ сервера — черновик берётся из него.
  // Иначе после сохранения в поле остался бы прежний текст, а карточка уже
  // показывала бы новое состояние.
  useEffect(() => {
    if (record.data) setDraft(record.data.text);
  }, [record.data]);

  // Другой промпт — другой встроенный текст: оставленная раскрытой панель
  // показывала бы его от прошлой карточки.
  useEffect(() => {
    setShowBuiltin(false);
  }, [openId]);

  const dirty = Boolean(record.data && draft !== record.data.text);
  const busy = save.isPending || reset.isPending;
  // Отказ маршрута — на экран, а не в консоль. Их пять (длинный текст, пустое
  // тело, неизвестный промпт, не записалось, не сбросилось), и до этой строки
  // человек видел вместо любого из них ровно ничего: кнопка «отжималась», текст
  // оставался прежним, и понять, сохранилось ли, было нечем.
  const failure = save.error ?? reset.error;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body" weight="medium">
            {t('settings.prompts.title')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('settings.prompts.description')}
          </Typography>
        </Stack>

        {prompts.isLoading && <SkeletonList rows={5} withActions={false} />}

        {/* Мёртвый API — это не «промптов нет»: без этой ветки карточка
            показывала бы заголовок с описанием и ничего больше. */}
        {prompts.isError && (
          <Typography variant="body-sm" color="danger" role="alert">
            {toErrorMessage(prompts.error)}
          </Typography>
        )}

        {prompts.data?.length === 0 && (
          <EmptyState icon="file" title={t('settings.prompts.empty')} />
        )}

        <Stack gap="var(--spacing-2xs)">
          {prompts.data?.map((item) => (
            <Stack
              key={item.id}
              direction="row"
              gap="var(--spacing-xs)"
              align="center"
              justify="between"
              data-prompt={item.id}
            >
              <Stack gap="2px">
                <Typography variant="body-sm" weight="medium">
                  {t(`settings.prompts.name.${item.id}`)}
                </Typography>
                <Typography variant="caption" color="muted">
                  {t(`settings.prompts.hint.${item.id}`)}
                </Typography>
              </Stack>

              <Stack direction="row" gap="var(--spacing-xs)" align="center">
                {item.overridden && <Badge tone="info">{t('settings.prompts.edited')}</Badge>}
                {/* «Встроенный изменился» — не ошибка, а повод перечитать: панель
                    обновилась, а текст человека остался прежним. */}
                {item.builtinChanged && (
                  <Badge tone="warning">{t('settings.prompts.builtinChanged')}</Badge>
                )}
                <Typography variant="caption" color="muted">
                  {t('settings.prompts.size', { bytes: item.bytes })}
                </Typography>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={openId === item.id}
                  aria-controls="prompt-editor"
                  onClick={() => setOpenId(openId === item.id ? undefined : item.id)}
                >
                  {openId === item.id ? t('common.close') : t('settings.prompts.open')}
                </Button>
              </Stack>
            </Stack>
          ))}
        </Stack>

        {/* Открыли промпт, а запрос отказал: без этой ветки под кнопкой
            «Закрыть» не было бы вообще ничего. */}
        {openId && record.isError && (
          <Typography variant="body-sm" color="danger" role="alert">
            {toErrorMessage(record.error)}
          </Typography>
        )}

        {openId && record.data && (
          <Stack gap="var(--spacing-xs)" id="prompt-editor">
            <TextField
              label={t(`settings.prompts.name.${openId}`)}
              hint={t('settings.prompts.editorHint', { version: record.data.version })}
              value={draft}
              onChange={setDraft}
              multiline
              rows={16}
              isMono
            />

            <Stack direction="row" gap="var(--spacing-xs)" align="center">
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty || busy}
                onClick={() => save.mutate({ id: openId, text: draft })}
              >
                {t('common.save')}
              </Button>
              {/* Сброс необратим и истории у промптов нет: спрашиваем, как и при
                  любом другом разрушающем действии в панели. */}
              <Button
                variant="secondary"
                size="sm"
                disabled={!record.data.overridden || busy}
                onClick={() => setConfirmReset(true)}
              >
                {t('settings.prompts.reset')}
              </Button>
              {/* Встроенный текст читается ЗДЕСЬ, а не после нажатия «Сбросить»:
                  иначе единственным способом его перечитать было бы стереть
                  свой. */}
              {record.data.overridden && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showBuiltin}
                  aria-controls="prompt-builtin"
                  onClick={() => setShowBuiltin((current) => !current)}
                >
                  {showBuiltin
                    ? t('settings.prompts.hideBuiltin')
                    : t('settings.prompts.showBuiltin')}
                </Button>
              )}
              {dirty && (
                <Typography variant="caption" color="muted">
                  {t('settings.prompts.unsaved')}
                </Typography>
              )}
              {/* Пока текст не правлен, «Сбросить» нечего сбрасывать — но человек
                  должен видеть, ПОЧЕМУ кнопка недоступна, а не гадать. */}
              {!record.data.overridden && !dirty && (
                <Typography variant="caption" color="muted">
                  {t('settings.prompts.builtinNow')}
                </Typography>
              )}
            </Stack>

            {failure && (
              <Typography variant="body-sm" color="danger" role="alert">
                {toErrorMessage(failure)}
              </Typography>
            )}

            {record.data.builtinChanged && (
              <Typography variant="caption" color="warning">
                {t('settings.prompts.builtinChangedHint')}
              </Typography>
            )}

            {showBuiltin && record.data.overridden && (
              <div id="prompt-builtin">
                <TextField
                  label={t('settings.prompts.builtinTitle')}
                  hint={t('settings.prompts.builtinHint')}
                  value={record.data.builtinText}
                  onChange={() => undefined}
                  readOnly
                  multiline
                  rows={16}
                  isMono
                />
              </div>
            )}
          </Stack>
        )}
      </Stack>

      <ConfirmDialog
        isOpen={confirmReset}
        onOpenChange={(open) => !open && setConfirmReset(false)}
        title={t('settings.prompts.resetConfirmTitle')}
        description={t('settings.prompts.resetConfirmText')}
        confirmLabel={t('settings.prompts.reset')}
        isPending={reset.isPending}
        onConfirm={() => {
          if (openId) reset.mutate(openId);
          setConfirmReset(false);
        }}
      />
    </Card>
  );
}
