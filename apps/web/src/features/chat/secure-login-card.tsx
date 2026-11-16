import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { CircleCheckIcon, CircleSlashIcon, LoaderIcon, LockIcon, MousePointerIcon } from 'lucide-react';
import type { SecureLoginDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type DesktopStatus } from '@/lib/api';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { remotePointer } from '../pages/remote-pointer';

const STATUS: Record<SecureLoginDTO['status'], string> = {
  pending: 'En attente de ta connexion', authenticated: 'Connexion effectuée', cancelled: 'Connexion annulée', failed: 'Connexion non aboutie', expired: 'Demande expirée',
};

/** L'état vient du serveur : événements en direct, sinon relu après rechargement. */
function useSecureLogin(id: string): SecureLoginDTO | null {
  const live = useStore((s) => s.secureLogins.find((login) => login.id === id) ?? null);
  const [fetched, setFetched] = useState<SecureLoginDTO | null>(null);
  useEffect(() => { if (!live) { let active = true; api.secureLogin(id).then((login) => active && setFetched(login)).catch(() => {}); return () => { active = false; }; } }, [id, live]);
  return live ?? fetched;
}

/**
 * Carte de confiance d'une connexion : rendue par BotCircle à partir de ce que le serveur a vérifié, jamais par le
 * modèle. Elle montre l'origine réelle et ne contient aucun champ de mot de passe : l'utilisateur s'authentifie
 * directement dans le navigateur du compagnon, dont les outils sont suspendus pendant ce temps.
 */
export function SecureLoginCard({ loginId }: { loginId: string }) {
  const login = useSecureLogin(loginId);
  const agent = useStore((s) => s.agents.find((a) => a.id === login?.agentId));
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  if (!login) return <div className="w-[min(100%,26rem)] rounded-2xl border bg-card px-3.5 py-3 text-muted-foreground text-sm">{t('Connexion…')}</div>;
  const url = new URL(login.url), pending = login.status === 'pending';
  async function resolve(outcome: 'authenticated' | 'cancelled' | 'failed') {
    setBusy(true);
    try { await api.resolveSecureLogin(loginId, outcome); setOpen(false); } catch (error) { toast.error((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <section data-secure-login={login.status} aria-label={t('Connexion sécurisée')} className="flex w-[min(100%,26rem)] flex-col gap-2.5 rounded-2xl border bg-card px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        {pending ? <LockIcon className="mt-0.5 size-4 shrink-0" /> : login.status === 'authenticated' ? <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleSlashIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{t('Se connecter à {host}', { host: url.host })}</p>
          <p className="text-muted-foreground text-xs">{t(STATUS[login.status])}</p>
        </div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{url.protocol === 'https:' ? t('Connexion chiffrée (HTTPS) · voir l’adresse complète') : t('Connexion locale non chiffrée · voir l’adresse complète')}</summary>
        <p className="mt-1 break-all font-mono">{login.url}</p>
      </details>
      {login.reason && <p className="text-muted-foreground text-xs">{agent?.name ? `${agent.name} : ` : ''}{login.reason}</p>}
      {pending && <>
        <p className="text-muted-foreground text-xs">{t('Tu saisis tes identifiants toi-même, directement dans son navigateur. Ses captures, ses clics et son terminal sont suspendus ; il ne recevra que « connecté » ou non.')}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" className="h-8 rounded-full text-xs" onClick={() => setOpen(true)}><MousePointerIcon /> {t('Prendre le contrôle du navigateur')}</Button>
          <Button size="sm" variant="ghost" className="h-8 rounded-full text-xs" disabled={busy} onClick={() => void resolve('cancelled')}>{t('Annuler')}</Button>
        </div>
      </>}
      {open && pending && <TakeoverDialog login={login} busy={busy} onClose={() => setOpen(false)} onResolve={resolve} />}
    </section>
  );
}

/** Le navigateur du compagnon, piloté par l'utilisateur seul. Ce qui est tapé va au bureau par le flux VNC, pas à BotCircle ni au modèle. */
function TakeoverDialog({ login, busy, onClose, onResolve }: { login: SecureLoginDTO; busy: boolean; onClose: () => void; onResolve: (outcome: 'authenticated' | 'cancelled' | 'failed') => void }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null), [connected, setConnected] = useState(false), [error, setError] = useState('');
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => { let active = true; api.desktop(login.agentId).then((value) => active && setStatus(value)).catch((e) => active && setError(e.message)); return () => { active = false; }; }, [login.agentId]);
  useEffect(() => {
    if (!status?.running || !target.current) return;
    let active = true;
    const url = new URL('/api/computer/vnc', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('agentId', login.agentId);
    const rfb = new RFB(target.current, url.href, { credentials: { password: status.vncPassword ?? '' } });
    const remote = remotePointer(target.current, rfb, status.width, status.height);
    rfb.viewOnly = false; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#111';
    rfb.addEventListener('connect', () => { if (active) { setConnected(true); setError(''); remote.refresh(); rfb.focus(); } });
    rfb.addEventListener('disconnect', () => { if (active) { setConnected(false); setError(t('Connexion au bureau interrompue.')); } });
    return () => { active = false; remote.remove(); rfb.disconnect(); };
  }, [status?.running, status?.vncPassword, status?.width, status?.height, login.agentId]);
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-3 p-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LockIcon className="size-4" />{t('Se connecter à {host}', { host: new URL(login.url).host })}</DialogTitle>
          <DialogDescription>{t('Vérifie l’adresse affichée dans le navigateur avant de saisir quoi que ce soit. Le Circle ne voit rien pendant que tu as la main.')}</DialogDescription>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-black">
          <div ref={target} className="size-full" data-secure-desktop />
          {!connected && <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">{error || (status && !status.running ? t('Son ordinateur est arrêté.') : <LoaderIcon className="animate-spin" />)}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => onResolve('authenticated')}>{t('Je suis connecté — rendre la main')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => onResolve('failed')}>{t('Je n’ai pas pu me connecter')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => onResolve('cancelled')}>{t('Annuler')}</Button>
          <span className="ml-auto text-muted-foreground text-xs">{t('Fermer cette fenêtre te laisse la main : la connexion reste en attente.')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
