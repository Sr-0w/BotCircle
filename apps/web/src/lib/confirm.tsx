import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

/** A deliberate yes/no, with what will happen spelled out (never a one-tap destructive action). */
export interface ConfirmRequest { title: string; body: React.ReactNode; confirm: string; destructive?: boolean }
const listeners = new Set<(request: ConfirmRequest, resolve: (ok: boolean) => void) => void>();

export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  if (!listeners.size) return Promise.resolve(window.confirm(`${request.title}\n\n${typeof request.body === 'string' ? request.body : ''}`));
  return new Promise((resolve) => listeners.forEach((open) => open(request, resolve)));
}

export function ConfirmHost() {
  const [pending, setPending] = useState<{ request: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => { const open = (request: ConfirmRequest, resolve: (ok: boolean) => void) => setPending({ request, resolve }); listeners.add(open); return () => { listeners.delete(open); }; }, []);
  const answer = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) answer(false); }}>
      <DialogContent className="max-w-md" data-confirm-dialog>
        <DialogHeader>
          <DialogTitle>{pending?.request.title}</DialogTitle>
          <DialogDescription asChild><div className="space-y-2 text-sm">{pending?.request.body}</div></DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>{t('Annuler')}</Button>
          <Button variant={pending?.request.destructive ? 'destructive' : 'default'} onClick={() => answer(true)} data-confirm-ok>{pending?.request.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
