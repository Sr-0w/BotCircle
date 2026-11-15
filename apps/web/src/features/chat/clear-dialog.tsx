import { useState } from 'react';
import { CheckIcon, LoaderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

/**
 * Confirmation of /clear. Nothing changes before the final button: a new conversation starts, the old one stays in
 * the history. Profile, memory, connections and running tasks are kept.
 */
export function ClearDialog({ name, chat, busy, onConfirm, onClose }: { name: string; chat?: boolean; busy: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const kept = chat
    ? [t('Modèle et recherche web conservés'), t('Interventions en cours non interrompues'), t('Ancien chat conservé dans la liste')]
    : [t('Profil et personnalité conservés'), t('Mémoire persistante et connexions conservées'), t('Tâches en cours non interrompues'), t('Ancienne conversation archivée, consultable')];
  return (
    <Dialog open onOpenChange={(open) => !open && !working && onClose()}>
      <DialogContent className="sm:max-w-md" data-clear-dialog>
        <DialogHeader>
          <DialogTitle>{chat ? t('Repartir de zéro ?') : t('Réinitialiser {v0} ?', { v0: name })}</DialogTitle>
          <DialogDescription>{chat ? t('Un nouveau chat vierge sera ouvert, avec les mêmes réglages. Celui-ci restera dans la liste.') : t('Une nouvelle conversation avec {v0} sera créée. L’ancienne restera dans l’historique.', { v0: name })}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm">{kept.map((line) => <li key={line} className="flex items-center gap-2"><CheckIcon className="size-4 text-success" />{line}</li>)}</ul>
        {busy && <p className="text-destructive text-sm">{t('Une réponse est en cours : arrête-la ou attends la fin avant de réinitialiser.')}</p>}
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={working}>{t('Annuler')}</Button>
          <Button disabled={busy || working} onClick={() => { setWorking(true); setError(''); onConfirm().then(onClose).catch((e) => setError((e as Error).message)).finally(() => setWorking(false)); }}>
            {working && <LoaderIcon className="animate-spin" />}{chat ? t('Nouveau chat') : t('Réinitialiser')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
