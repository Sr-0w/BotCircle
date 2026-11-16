import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';
import type { SlashCommand } from './composer';

/** /help: every command of this conversation, with what it does (or why it is not available now). */
export function CommandsHelp({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-commands-help>
        <DialogHeader>
          <DialogTitle>{t('Commandes')}</DialogTitle>
          <DialogDescription>{t('Tape / dans le champ. @ pour solliciter un Circle ou un service, + pour joindre des fichiers.')}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-2 text-sm">
          {commands.map((c) => (
            <div key={c.name} className="flex gap-3">
              <dt className="w-20 shrink-0 font-mono">/{c.name}</dt>
              <dd className="min-w-0 text-muted-foreground">{c.unavailable ?? c.description}{c.args && <span className="block font-mono text-xs">{c.args.map((a) => a.value).join(' · ')}</span>}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
