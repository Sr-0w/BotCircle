import { useEffect, useState, type ReactNode } from 'react';
import { DownloadIcon, EllipsisIcon, ExternalLinkIcon, EyeIcon, InfoIcon, ShieldIcon } from 'lucide-react';
import type { PresentedFile } from '@opendots/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { openDialog } from '@/lib/dialogs';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatBytes } from '../chat/composer';
import { FileTypeIcon } from './file-icon';
import { fileKindLabel, previewKind } from './file-kind';

/** Size and availability come from the artifact itself, not from the message that mentions it. */
function useFileState(file: PresentedFile) {
  const [size, setSize] = useState(file.size ?? null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!file.artifactId || file.size != null) return;
    let active = true;
    api.artifact(file.artifactId).then((a) => active && setSize(a.size)).catch((e) => active && [403, 404].includes((e as { status?: number }).status ?? 0) && setMissing(true));
    return () => { active = false; };
  }, [file.artifactId, file.size]);
  return { size, missing };
}

/**
 * One file, on one line (~56px): its format, name, kind and size, then Preview and Download. Rarer actions (access,
 * information, open in a tab) are in the menu.
 */
export function FileRow({ file }: { file: PresentedFile }) {
  const { size, missing } = useFileState(file);
  const kind = previewKind(file.filename, file.mediaType);
  const image = kind === 'image' && !missing && /^image\/(png|jpe?g|gif|webp)$/.test(file.mediaType);
  const preview = () => openDialog({ kind: 'file-preview', file: { ...file, size: size ?? undefined } });
  return (
    <div data-file-card data-file-row className="flex min-h-14 items-center gap-3 px-2.5 py-2">
      <button type="button" className="shrink-0 rounded-[9px] focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default" onClick={preview} disabled={!kind || missing} aria-label={t('Aperçu de {v0}', { v0: file.filename })} tabIndex={kind && !missing ? 0 : -1}>
        {image ? <img src={file.url} alt="" className="size-9 rounded-[9px] border object-cover" loading="lazy" /> : <FileTypeIcon name={file.filename} mediaType={file.mediaType} />}
      </button>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate font-medium text-sm" title={file.filename}>{file.filename}</p>
        <p className="truncate text-muted-foreground text-xs">{missing ? t('Indisponible') : [fileKindLabel(file.filename, file.mediaType), size != null ? formatBytes(size) : null].filter(Boolean).join(' · ')}</p>
        {file.caption && <p className="truncate text-muted-foreground text-xs">{file.caption}</p>}
      </div>
      {!missing && kind && <Button size="icon" variant="ghost" className="size-8 rounded-full text-muted-foreground hover:text-foreground" aria-label={t('Aperçu')} title={t('Aperçu')} onClick={preview}><EyeIcon /></Button>}
      {!missing && <Button asChild size="icon" variant="ghost" className="size-8 rounded-full text-muted-foreground hover:text-foreground"><a href={`${file.url}?download=1`} download={file.filename} aria-label={t('Télécharger')} title={t('Télécharger')}><DownloadIcon /></a></Button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="-ml-1 size-8 rounded-full text-muted-foreground hover:text-foreground" aria-label={t('Plus d’actions')}><EllipsisIcon /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!missing && <DropdownMenuItem asChild><a href={file.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> {t('Ouvrir dans un onglet')}</a></DropdownMenuItem>}
          {file.artifactId && <DropdownMenuItem onSelect={() => openDialog({ kind: 'artifact', artifactId: file.artifactId! })}><ShieldIcon /> {t('Accès et historique')}</DropdownMenuItem>}
          {file.artifactId && <DropdownMenuItem onSelect={() => openDialog({ kind: 'artifact', artifactId: file.artifactId! })}><InfoIcon /> {t('Informations')}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Several files sent together: one surface, light separators, never a card per file. */
export function FileGroup({ files, align, className, children }: { files: PresentedFile[]; align?: 'end'; className?: string; children?: ReactNode }) {
  if (!files.length) return null;
  return (
    <div data-file-group className={cn('w-[min(100%,26rem)] divide-y overflow-hidden rounded-2xl border bg-card text-left text-foreground', align === 'end' && 'ml-auto', className)}>
      {files.map((file, index) => <FileRow key={`${file.url}-${index}`} file={file} />)}
      {children}
    </div>
  );
}
