import { cn } from '@/lib/utils';
import { setiIcon } from './file-kind';

/** The format of a file, recognisable at a glance (Seti UI). Neutral when Seti has no colour for it. */
export function FileTypeIcon({ name, mediaType, className }: { name: string; mediaType: string; className?: string }) {
  const { path, color } = setiIcon(name, mediaType);
  // Seti's "white" and "grey" read as nothing on light themes: they follow the text colour instead.
  const neutral = !color || ['#d4d7d6', '#4d5a5e', '#6d8086', '#41535b'].includes(color.toLowerCase());
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-muted/70', className)} aria-hidden>
      <svg viewBox="0 0 32 32" className="size-7"><path d={path} fill={neutral ? 'currentColor' : color} className={neutral ? 'text-muted-foreground' : undefined} /></svg>
    </span>
  );
}
