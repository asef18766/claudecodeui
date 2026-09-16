import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Container, Loader2, Monitor } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { SandboxImageOption } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ComposerSandboxMenuProps = {
  /** The user's switch, regardless of whether the server can honour it. */
  requested: boolean;
  /** Template the sandbox is built from; null = the agent's default image. */
  template: string | null;
  available: boolean;
  checking: boolean;
  unavailableReason: string | null;
  /** Null until requested; empty when the host has no local Docker images. */
  images: SandboxImageOption[] | null;
  imagesError: string | null;
  /** Reference of the image being exported into the template store right now. */
  importingImage: string | null;
  importError: string | null;
  onLoadImages: () => void;
  /** Default image (null) — the agent's built-in sbx image. */
  onSelectDefault: () => void;
  onSelectImage: (image: SandboxImageOption) => void;
  onDisable: () => void;
  providerLabel: string;
  /** Agent the sandbox must host; an image whose flavor does not name it cannot be used. */
  providerId: string;
};

/**
 * Rendered by chat's ChatComposer beside the permission menu: a popover that
 * decides whether the next turn's agent (and every tool it runs) lives inside
 * the workspace's Docker sandbox instead of on the host, and which local
 * Docker image that sandbox is built from. Picking an image that is not yet
 * a sandbox template exports it first.
 */
function ComposerSandboxMenu({
  requested,
  template,
  available,
  checking,
  unavailableReason,
  images,
  imagesError,
  importingImage,
  importError,
  onLoadImages,
  onSelectDefault,
  onSelectImage,
  onDisable,
  providerLabel,
  providerId,
}: ComposerSandboxMenuProps) {
  const { t } = useTranslation('chat');
  // Open/closed state of the popover, owned here like the other composer menus.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 26 * 16);

  // Images are only worth fetching once someone actually opens the menu.
  useEffect(() => {
    if (isOpen) {
      onLoadImages();
    }
  }, [isOpen, onLoadImages]);

  const active = requested && available;
  const activeImage = active && template
    ? images?.find((candidate) => candidate.templateReference === template) ?? null
    : null;
  const heading = t('composer.sandbox.heading', { provider: providerLabel });
  const title = checking
    ? t('composer.sandbox.checking')
    : !available
      ? `${t('composer.sandbox.unavailable')}${unavailableReason ? ` (${unavailableReason})` : ''}`
      : active
        ? t('composer.sandbox.disable')
        : t('composer.sandbox.enable');

  // Falls back to the stored template's tag when the image list has not
  // loaded yet (the menu was never opened this page load).
  const activeLabel = activeImage
    ? `${activeImage.repository.split('/').pop()}:${activeImage.tag}`
    : active && template
      ? template.split('/').pop() ?? template
      : t('composer.sandbox.label');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        disabled={checking || !available}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-pressed={active}
        aria-label={t('composer.sandbox.label')}
        title={title}
        className={cn(
          'flex h-8 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          active
            ? 'border-sky-300/60 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-600/40 dark:bg-sky-900/15 dark:text-sky-300 dark:hover:bg-sky-900/25'
            : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted',
        )}
      >
        <Container className="h-4 w-4 shrink-0" />
        <span className="hidden truncate sm:inline">{activeLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          <ComposerMenuItem
            icon={<Monitor className="h-4 w-4" />}
            label={t('composer.sandbox.off')}
            description={t('composer.sandbox.offDescription')}
            isSelected={!requested}
            onSelect={() => {
              onDisable();
              setIsOpen(false);
            }}
          />
          <ComposerMenuItem
            icon={<Container className="h-4 w-4" />}
            label={t('composer.sandbox.defaultTemplate')}
            description={t('composer.sandbox.defaultTemplateDescription', { provider: providerLabel })}
            isSelected={requested && template === null}
            onSelect={() => {
              onSelectDefault();
              setIsOpen(false);
            }}
            className="text-sky-700 dark:text-sky-300"
          />
          <ComposerMenuSeparator />
          <ComposerMenuHeading>{t('composer.sandbox.imagesHeading')}</ComposerMenuHeading>
          {images === null ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t('composer.sandbox.imagesLoading')}</p>
          ) : imagesError ? (
            <p className="px-2.5 py-1.5 text-xs text-destructive">{t('composer.sandbox.imagesError')}</p>
          ) : images.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t('composer.sandbox.noImages')}</p>
          ) : (
            images.map((image) => {
              const isImporting = importingImage === image.reference;
              const details = [image.repository, image.size].filter(Boolean).join(' · ');
              // `sbx` reads the flavor label to apply the agent kit; without a
              // matching one the sandbox fails to create, so the row is inert.
              const supportsAgent = Boolean(image.agentFlavor?.toLowerCase().includes(providerId.toLowerCase()));
              return (
                <ComposerMenuItem
                  key={image.reference}
                  icon={isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Container className="h-4 w-4" />}
                  label={`${image.repository.split('/').pop()}:${image.tag}`}
                  description={
                    isImporting
                      ? t('composer.sandbox.importing')
                      : supportsAgent
                        ? details
                        : t('composer.sandbox.incompatible', { provider: providerLabel })
                  }
                  disabled={!supportsAgent}
                  trailing={supportsAgent && image.templateReference ? (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                      {t('composer.sandbox.imported')}
                    </span>
                  ) : undefined}
                  isSelected={requested && template !== null && template === image.templateReference}
                  onSelect={() => {
                    onSelectImage(image);
                    // Stay open while an export runs so its progress is visible.
                    if (image.templateReference) {
                      setIsOpen(false);
                    }
                  }}
                  className={supportsAgent ? 'text-sky-700 dark:text-sky-300' : undefined}
                />
              );
            })
          )}
          {importError && (
            <p className="px-2.5 py-1.5 text-xs text-destructive">{t('composer.sandbox.importFailed', { error: importError })}</p>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of these props change while typing. */
export default memo(ComposerSandboxMenu);
