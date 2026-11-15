import { cn } from '@/lib/utils';

/**
 * The official OpenCode logo (https://opencode.ai/brand), unchanged: the light version on light themes, the dark one
 * on dark themes. Its proportions are fixed at 4:5 and it is drawn at whole-pixel sizes (16×20, 20×25, 24×30…).
 */
export function OpencodeLogo({ size = 20, className, title }: { size?: 16 | 20 | 24 | 32; className?: string; title?: string }) {
  const height = (size * 5) / 4;
  const common = { width: size, height, viewBox: '0 0 240 300', role: title ? 'img' : undefined, 'aria-label': title, 'aria-hidden': title ? undefined : true } as const;
  return (
    <span className={cn('inline-flex shrink-0', className)} data-opencode-logo>
      <svg {...common} className="dark:hidden"><path d="M180 240H60V120H180V240Z" fill="#D2D2D2" /><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#1F1F1F" /></svg>
      <svg {...common} className="hidden dark:block"><path d="M180 240H60V120H180V240Z" fill="#4B4B4B" /><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#EEEEEE" /></svg>
    </span>
  );
}
