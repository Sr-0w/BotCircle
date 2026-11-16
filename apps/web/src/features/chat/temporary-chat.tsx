import { useEffect, useRef, useState } from 'react';
import type { ModelConfig } from '@opendots/shared';
import { Button } from '@/components/ui/button';
import { ModelPicker } from '../model-picker';

type Message = { role: 'user' | 'assistant'; content: string; model?: ModelConfig };
type Snapshot = { id: string; expiresAt: number; messages: Message[]; busy: boolean };
class TemporaryApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const headers = { 'content-type': 'application/json', 'x-opendots-client': '1' };
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/temporary-chats${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
  });
  if (res.status === 401) window.dispatchEvent(new Event('opendots:unauthorized'));
  const data = await res.json();
  if (!res.ok) throw new TemporaryApiError(data.error ?? 'Chat temporaire indisponible.', res.status);
  return data;
}

/**
 * Kept mounted by Shell across SPA navigation; neither transcript nor session ID
 * is written to browser storage, URL, the normal chat store or analytics.
 */
export function TemporaryChat({ visible, onStartNormalChat }: { visible: boolean; onStartNormalChat: () => Promise<void> }) {
  const [session, setSession] = useState<Snapshot | null>(null);
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [provider, setProvider] = useState<'openrouter' | 'ollama'>('openrouter');
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState('');
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (sessionRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    const discard = () => {
      const id = sessionRef.current?.id;
      active.current?.abort();
      if (id) void fetch(`/api/temporary-chats/${id}`, { method: 'DELETE', headers, keepalive: true }).catch(() => {});
      sessionRef.current = null;
      setSession(null); setDraft(''); setPartial(''); setBusy(false);
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', discard);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) discard(); };
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', discard);
      window.removeEventListener('pageshow', restore);
      discard();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const id = session.id;
    // GET never prolongs retention. Polling also notices server restarts/logout.
    const poll = async () => {
      try {
        const next = await request<Snapshot>(`/${id}`);
        if (sessionRef.current?.id === id) setSession(next);
      } catch (e) {
        if (sessionRef.current?.id !== id) return;
        if ((e instanceof TemporaryApiError && [401, 404].includes(e.status)) || Date.now() >= sessionRef.current.expiresAt) {
          active.current?.abort();
          sessionRef.current = null;
          setSession(null); setPartial(''); setDraft(''); setBusy(false);
          setError('Chat temporaire expiré. Son contenu a été abandonné.');
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    const resume = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [session?.id]);

  const start = async () => {
    setError(''); setBusy(true);
    try { setSession(await request<Snapshot>('', 'POST')); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const close = async () => {
    if (!session || !window.confirm('Fermer ce chat temporaire ? Son contenu sera perdu. Aucun chat normal ne sera supprimé.')) return;
    active.current?.abort();
    const id = session.id;
    // Drop local data even if offline; server expiry remains the safety net.
    sessionRef.current = null;
    setSession(null); setDraft(''); setPartial(''); setError(''); setBusy(false);
    try { await request(`/${id}`, 'DELETE'); }
    catch { setError('Copie locale effacée. Hors connexion : la copie serveur sera purgée à son expiration.'); }
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session || !model || !draft.trim() || busy) return;
    const id = session.id;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(''); setPartial('');
    let completed = false;
    try {
      const res = await fetch(`/api/temporary-chats/${id}/turn`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ text: draft, model }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Envoi impossible.');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const kind = /^event: ?(.+)$/m.exec(frame)?.[1];
          const data = /^data: ?(.*)$/m.exec(frame)?.[1];
          if (kind === 'delta' && data) setPartial(prev => prev + JSON.parse(data));
          if (kind === 'done') completed = true;
          if (kind === 'failure' && data) throw new Error(JSON.parse(data));
        }
      }
      if (!completed) setError('Flux interrompu. Vérifie les messages avant de renvoyer ce tour.');
    } catch (e) {
      setError(controller.signal.aborted ? 'Réponse arrêtée. Vérifie le contexte avant de renvoyer.' : (e as Error).message);
    } finally {
      if (sessionRef.current?.id === id) {
        try {
          const next = await request<Snapshot>(`/${id}`);
          if (sessionRef.current?.id === id) setSession(next);
        } catch (e) {
          // Offline is not expiry: keep the in-memory ID so the next poll can
          // reconnect. Never replay a send whose completion may have been lost.
          if (sessionRef.current?.id === id && ((e instanceof TemporaryApiError && [401, 404].includes(e.status)) || Date.now() >= sessionRef.current.expiresAt)) {
            sessionRef.current = null;
            setSession(null); setDraft(''); setPartial(''); setBusy(false);
            setError('Chat fermé, expiré ou serveur indisponible. Aucune conversion en historique.');
          } else if (sessionRef.current?.id === id) {
            setError('Connexion interrompue. Le contexte terminé sera récupéré ici au retour du réseau, avant expiration. Vérifie-le avant de renvoyer.');
          }
        }
        if (sessionRef.current?.id === id) {
          if (completed) setDraft('');
          setPartial(''); setBusy(false);
        }
      }
      if (active.current === controller) active.current = null;
    }
  };

  return (
    <section hidden={!visible} className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} aria-label="Chat temporaire">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="font-medium">Chat temporaire · sans historique</h1>
        {session && <Button variant="ghost" onClick={() => void close()}>Fermer et oublier</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Contenu uniquement en mémoire serveur : expiration après 10 minutes sans nouvel envoi, au plus 30 minutes.
            La navigation dans l’application conserve ce chat ; fermer ou recharger la page l’abandonne.
            Une coupure réseau interrompt le tour en cours ; les tours terminés restent récupérables ici jusqu’à expiration.
            Les fournisseurs traitent vos messages selon leur propre politique : ce mode n’est pas anonyme et ne garantit pas zéro rétention.
          </p>
          <p className="text-sm text-muted-foreground">
            Mémoire, outils, recherche Web, tâches, mentions de Circles, fichiers, partage et export sont désactivés dans cette version.
            Codex n’est pas disponible ici (rétention locale non auditée).
          </p>
          {!session && <Button disabled={busy} onClick={() => void start()}>Démarrer un chat temporaire</Button>}
          <Button variant="outline" disabled={busy} onClick={() => void onStartNormalChat().catch(() => setError('Impossible de créer un chat normal. Réessaie.'))}>Démarrer un chat normal</Button>
          <p className="text-xs text-muted-foreground">
            Un chat normal démarre un nouveau fil vide ; ce fil temporaire n’est jamais converti ni copié.
            Le temporaire reste accessible ici jusqu’à fermeture ou expiration.
          </p>
          {session?.messages.map((message, i) => (
            <article key={i} className="rounded-xl border p-4">
              <p className="mb-2 text-xs text-muted-foreground">{message.role === 'user' ? 'Vous' : `Assistant · ${message.model?.model ?? ''}`}</p>
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </article>
          ))}
          {busy && <p role="status" className="whitespace-pre-wrap break-words">{partial || 'Réponse en cours…'}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
      {session && (
        <form onSubmit={send} className="mx-auto w-full max-w-3xl space-y-2 p-4">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setPicker(!picker)}>
            {model ? `${model.provider} · ${model.model}` : 'Choisir un modèle'}
          </Button>
          {picker && <div className="h-72 space-y-2 overflow-auto rounded-xl border p-3">
            <select aria-label="Fournisseur" value={provider} onChange={e => setProvider(e.target.value as typeof provider)}>
              <option value="openrouter">OpenRouter</option><option value="ollama">Ollama</option>
            </select>
            <ModelPicker provider={provider} value={model?.model ?? null} onChange={m => { setModel({ provider: m.provider, model: m.id }); setPicker(false); }} />
          </div>}
          <label className="sr-only" htmlFor="temporary-message">Message temporaire</label>
          <textarea id="temporary-message" className="max-h-48 min-h-24 w-full resize-y rounded-xl border bg-background p-3" value={draft} maxLength={16000} onChange={e => setDraft(e.target.value)} disabled={busy} />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy || session.busy || !model || !draft.trim()}>Envoyer</Button>
            {busy && <Button type="button" variant="outline" onClick={() => {
              void request(`/${session.id}/stop`, 'POST').catch(() => {});
              active.current?.abort();
            }}>Arrêter</Button>}
            <span className="text-xs text-muted-foreground">Temporaire · aucune sauvegarde dans l’historique</span>
          </div>
        </form>
      )}
    </section>
  );
}
