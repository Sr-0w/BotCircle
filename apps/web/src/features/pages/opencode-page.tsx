import { CodeSessions } from '../code/code-sessions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LinkIcon, LoaderIcon, PlusIcon, ScanQrCodeIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
import type { OpencodeInstanceDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useServerEvent } from '@/lib/store';
import { relativeTime } from '@/lib/utils';
import { t } from '@/lib/i18n';

const STATES = { online: 'En ligne', offline: 'Injoignable', unknown: 'Jamais contrôlée' } as const;
type Draft = { id?: string; name: string; baseUrl: string; username: string; password: string; defaultDirectory: string };
const EMPTY: Draft = { name: '', baseUrl: '', username: 'opencode', password: '', defaultDirectory: '' };

/**
 * Les instances OpenCode du compte : des machines de développement où tourne `opencode serve`. BotCircle s'y connecte
 * par l'API d'OpenCode ; l'adresse et le mot de passe se saisissent ici, jamais dans une conversation.
 */
export function OpencodePage() {
  const [instances, setInstances] = useState<OpencodeInstanceDTO[] | null>(null);
  const [pairing, setPairing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [checking, setChecking] = useState<string | null>(null);
  const reload = useCallback(() => { api.opencodeInstances().then(setInstances).catch((e) => toast.error(e.message)); }, []);
  useEffect(reload, [reload]);
  useServerEvent((e) => e.type === 'opencode.changed' && reload(), [reload]);
  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      // Mot de passe vide à la modification : inchangé.
      const saved = await api.saveOpencodeInstance({ id: draft.id, name: draft.name, baseUrl: draft.baseUrl, username: draft.username || 'opencode', defaultDirectory: draft.defaultDirectory || null, ...(draft.password ? { password: draft.password } : draft.id ? {} : { password: null }) });
      setDraft(null); reload();
      if (saved.state === 'online') toast.success(t('Instance connectée · OpenCode {v0}', { v0: saved.version ?? '' })); else toast.error(saved.lastError ?? t('Instance injoignable.'));
    } catch (error) { toast.error((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><OpencodeLogo size={20} />OpenCode</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('Connecte une machine de développement : tes compagnons autorisés pourront y déléguer du code à OpenCode, et tu suivras la session en direct.')}</p>
        </div>
        {instances && <CodeSessions instances={instances} />}
        {!instances ? <LoaderIcon className="animate-spin" /> : instances.length === 0 && !draft ? <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('Aucune instance connectée.')}</div> : null}
        {instances?.map((instance) => (
          <section key={instance.id} className="space-y-2 rounded-2xl border bg-card p-4" aria-label={instance.name} data-instance-state={instance.state}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-medium">{instance.name}</h2>
                <p className="truncate font-mono text-muted-foreground text-xs">{instance.baseUrl}{instance.defaultDirectory && ` · ${instance.defaultDirectory}`}</p>
              </div>
              <span className={'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ' + (instance.state === 'offline' ? 'text-destructive' : instance.state === 'online' ? '' : 'text-muted-foreground')}>
                <span className={'size-1.5 rounded-full ' + (instance.state === 'online' ? 'bg-success' : instance.state === 'offline' ? 'bg-destructive' : 'bg-muted-foreground/50')} />{t(STATES[instance.state])}
              </span>
            </div>
            <p className="text-muted-foreground text-xs">
              {instance.state === 'offline' ? instance.lastError : [instance.version && `OpenCode ${instance.version}`, instance.lastSeenAt && t('vue {when}', { when: relativeTime(instance.lastSeenAt) }), instance.activeTasks > 0 && t('{count} tâche(s) en cours', { count: instance.activeTasks }), instance.authKind === 'pairing' ? (instance.tokenExpiresAt ? t('jumelée jusqu’au {date}', { date: new Date(instance.tokenExpiresAt).toLocaleDateString() }) : t('jumelée')) : instance.hasPassword ? t('protégée par mot de passe') : t('sans mot de passe')].filter(Boolean).join(' · ')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" disabled={checking === instance.id} onClick={() => { setChecking(instance.id); void api.checkOpencodeInstance(instance.id).then(reload).catch((e) => toast.error(e.message)).finally(() => setChecking(null)); }}><RefreshCwIcon className={checking === instance.id ? 'animate-spin' : ''} /> {t('Contrôler')}</Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => setDraft({ id: instance.id, name: instance.name, baseUrl: instance.baseUrl, username: instance.username, password: '', defaultDirectory: instance.defaultDirectory ?? '' })}>{t('Modifier')}</Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-full text-destructive text-xs" onClick={() => { if (confirm(t('Retirer « {v0} » ? Les tâches et échanges passés restent consultables.', { v0: instance.name }))) void api.deleteOpencodeInstance(instance.id).then(reload).catch((e) => toast.error(e.message)); }}><Trash2Icon /> {t('Retirer')}</Button>
            </div>
          </section>
        ))}
        {draft ? (
          <form className="space-y-3 rounded-2xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={t('Instance OpenCode')}>
            <h2 className="font-medium">{draft.id ? t('Modifier l’instance') : t('Nouvelle instance')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="oc-name" className="text-xs">{t('Nom')}</Label><Input id="oc-name" value={draft.name} maxLength={60} placeholder={t('PC de dev')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-url" className="text-xs">{t('Adresse de l’API')}</Label><Input id="oc-url" value={draft.baseUrl} placeholder="https://code.exemple.fr" className="font-mono" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-user" className="text-xs">{t('Utilisateur')}</Label><Input id="oc-user" value={draft.username} autoComplete="off" onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-pass" className="text-xs">{t('Mot de passe')}</Label><Input id="oc-pass" type="password" value={draft.password} autoComplete="new-password" placeholder={draft.id ? t('inchangé') : 'OPENCODE_SERVER_PASSWORD'} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="oc-dir" className="text-xs">{t('Dossier du projet par défaut')}</Label><Input id="oc-dir" value={draft.defaultDirectory} placeholder="/home/moi/projets/mon-app" className="font-mono" onChange={(e) => setDraft({ ...draft, defaultDirectory: e.target.value })} /></div>
            </div>
            <div className="flex gap-2"><Button type="submit" disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()}>{busy && <LoaderIcon className="animate-spin" />}{t('Enregistrer et contrôler')}</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{t('Annuler')}</Button></div>
          </form>
        ) : pairing ? <PairForm onDone={() => { setPairing(false); reload(); }} onCancel={() => setPairing(false)} /> : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setPairing(true)}><LinkIcon /> {t('Jumeler avec un lien')}</Button>
            <Button variant="secondary" onClick={() => setDraft(EMPTY)}><PlusIcon /> {t('Adresse et mot de passe')}</Button>
          </div>
        )}
        <details className="rounded-2xl border p-4 text-sm" open={!instances?.length}>
          <summary className="cursor-pointer font-medium">{t('Comment connecter ta machine')}</summary>
          <div className="mt-2 space-y-2 text-muted-foreground text-xs">
            <p className="font-medium text-foreground">{t('Le plus simple (OpenCode 2) : le jumelage')}</p>
            <p>{t('Sur la machine de développement, lance :')}</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono">opencode pair --remote</pre>
            <p>{t('Il affiche un lien et un QR code, valables 5 minutes et une seule fois. Colle le lien ici (ou scanne le QR code depuis ton téléphone). --remote passe par une adresse OpenTunnel : ça marche depuis n’importe quel réseau, sans ouvrir de port. Le jumelage dure 30 jours ; relance la commande pour le renouveler.')}</p>
            <p className="pt-1 font-medium text-foreground">{t('Sinon : adresse et mot de passe')}</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono">OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 0.0.0.0 --port 4096</pre>
            <p>{t('Le serveur BotCircle doit alors pouvoir joindre cette adresse : réseau privé (Tailscale, WireGuard), tunnel SSH ou reverse proxy HTTPS. N’expose jamais ce port sans mot de passe.')}</p>
            <p>{t('Ensuite, autorise un compagnon dans son profil : « Déléguer du code à OpenCode ».')}</p>
          </div>
        </details>
      </div>
    </div>
  );
}

/**
 * Pairing: the one-time link of `opencode pair` (or its QR code) is redeemed by the server, which keeps the resulting
 * session token. Where the browser can read barcodes (Chrome on Android), the QR code can be scanned with the camera.
 */
function PairForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [link, setLink] = useState(''), [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  async function pair(value = link) {
    if (!value.trim()) return;
    setBusy(true); setError('');
    try {
      const instance = await api.pairOpencode(value.trim(), directory.trim() || null);
      toast.success(t('« {v0} » jumelée · OpenCode {v1}', { v0: instance.name, v1: instance.version ?? '' }));
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <form className="space-y-3 rounded-2xl border bg-card p-4" aria-label={t('Jumeler avec un lien')} onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <h2 className="font-medium">{t('Jumeler avec un lien')}</h2>
      <div className="space-y-1.5">
        <Label htmlFor="oc-link" className="text-xs">{t('Lien affiché par opencode pair')}</Label>
        <div className="flex gap-2">
          <Input id="oc-link" value={link} autoFocus autoComplete="off" spellCheck={false} placeholder="https://….opentunnel.xyz/auth/connect/…" className="font-mono" onChange={(e) => { setLink(e.target.value); setError(''); }}
            onPaste={(e) => { const pasted = e.clipboardData.getData('text'); if (/\/auth\/connect\//.test(pasted)) { e.preventDefault(); setLink(pasted.trim()); } }} />
          {canScan && <Button type="button" variant="secondary" onClick={() => setScanning(true)} aria-label={t('Scanner le QR code')}><ScanQrCodeIcon /></Button>}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="oc-pair-dir" className="text-xs">{t('Dossier du projet par défaut (facultatif)')}</Label>
        <Input id="oc-pair-dir" value={directory} placeholder="/home/moi/projets/mon-app" className="font-mono" onChange={(e) => setDirectory(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !link.trim()}>{busy && <LoaderIcon className="animate-spin" />}{t('Jumeler')}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t('Annuler')}</Button>
      </div>
      {scanning && <QrScanner onResult={(value) => { setScanning(false); setLink(value); void pair(value); }} onClose={() => setScanning(false)} />}
    </form>
  );
}

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/** Camera QR scanner built on the browser's BarcodeDetector; nothing leaves the device but the decoded link. */
function QrScanner({ onResult, onClose }: { onResult: (value: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null, timer = 0, stopped = false;
    const detector = new (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector({ formats: ['qr_code'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream; await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          const found = (await detector.detect(video.current).catch(() => [])).find((code) => /\/auth\/connect\//.test(code.rawValue));
          if (found) { onResult(found.rawValue); return; }
          timer = window.setTimeout(() => void tick(), 300);
        };
        void tick();
      } catch { setError(t('Caméra indisponible : colle plutôt le lien.')); }
    })();
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((track) => track.stop()); };
  }, [onResult]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-4" role="dialog" aria-label={t('Scanner le QR code')}>
      <video ref={video} className="w-full max-w-sm rounded-2xl" playsInline muted />
      <p className="text-center text-sm text-white">{error || t('Vise le QR code affiché par opencode pair.')}</p>
      <Button variant="secondary" onClick={onClose}>{t('Fermer')}</Button>
    </div>
  );
}
