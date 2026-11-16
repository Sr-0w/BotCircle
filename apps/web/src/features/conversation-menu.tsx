import { MoreHorizontalIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** #56: the small "…" menu of a conversation (list row or open header): pin, archive / restore, delete. */
export function ConversationMenu({ items, label, className }: { items: { label: string; icon: React.ReactNode; onSelect: () => void; destructive?: boolean }[]; label: string; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} title={label} className={cn('rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground', className)} data-conversation-menu>
          <MoreHorizontalIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={item.onSelect} variant={item.destructive ? 'destructive' : 'default'}>{item.icon}{item.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
