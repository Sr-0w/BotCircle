import { useEffect, useState } from "react";
import { ArchiveIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, PencilIcon, XIcon } from "lucide-react";
import type { AgentDTO, AgentPermissions } from "@opendots/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { removeAgentLocally } from "@/lib/store";
import { toast } from "sonner";
import { ModelPicker } from "../model-picker";

import { t } from "@/lib/i18n";
const COLORS = ["#2563eb", "#e11d48", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04", "#db2777"];

/** Permissions grouped by what they let the Circle DO (#53). Values and effects are unchanged. */
const PERM_GROUPS: { title: string; perms: { key: Exclude<keyof AgentPermissions, "createAgents">; label: string }[] }[] = [
  { title: t("Information et services"), perms: [
    { key: "web", label: t("Lire des pages web") },
    { key: "mail", label: t("Lire les e-mails (l’envoi demande ton accord)") },
    { key: "connectors", label: t("Utiliser les connecteurs MCP") },
  ] },
  { title: t("Ordinateur et exécution"), perms: [
    { key: "shell", label: t("Utiliser l’ordinateur (shell)") },
    { key: "computer", label: t("Voir et piloter le bureau graphique") },
    { key: "code", label: t("Déléguer du code à OpenCode") },
  ] },
  { title: t("Autonomie et collaboration"), perms: [
    { key: "manageMemory", label: t("Gérer sa mémoire") },
    { key: "manageActivities", label: t("Créer des planifications et surveillances") },
    { key: "messageAgents", label: t("Échanger avec les autres Circles") },
  ] },
];

type View = "home" | "permissions" | "data" | "advanced";

/**
 * A Circle's details (#53): a short summary (name renamed in place, state, description, real model) and four
 * entries. Permissions (what it may do) and Data & connections (what it can reach) are separate pages.
 */
export function AgentSettings({ agent, onOpenTab, request }: { agent: AgentDTO; onOpenTab?: (tab: string) => void; request?: { view: View; n: number } | null }) {
  const [view, setView] = useState<View>("home");
  useEffect(() => { if (request) setView(request.view); }, [request]);
  const [picking, setPicking] = useState(false);
  useEffect(() => setView("home"), [agent.id]);

  async function save(patch: Parameters<typeof api.updateAgent>[1]) {
    try {
      await api.updateAgent(agent.id, patch);
      toast.success(t("Enregistré"));
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    }
  }
  const row = "flex w-full items-center gap-3 border-b px-1 py-3 text-left transition-colors hover:bg-accent/40";
  const back = (title: string) => (
    <button className="mb-3 flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground" onClick={() => setView("home")}><ChevronLeftIcon className="size-3.5" />{title}</button>
  );

  if (view === "permissions") return (
    <div className="space-y-5 pb-6" data-circle-section="permissions">
      {back(t("Détails"))}
      {PERM_GROUPS.map((group) => (
        <div key={group.title} className="space-y-2">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{group.title}</p>
          {group.perms.map((p) => (
            <label key={p.key} className="flex items-center justify-between gap-3 text-sm">
              <span>{p.label}</span>
              <Switch checked={agent.permissions[p.key]} onCheckedChange={(v) => void save({ permissions: { ...agent.permissions, [p.key]: v } }).catch(() => {})} />
            </label>
          ))}
          {group.title === t("Autonomie et collaboration") && (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{t("Créer des Circles")}</span>
              <Select value={agent.permissions.createAgents} onValueChange={(v) => void save({ permissions: { ...agent.permissions, createAgents: v as AgentPermissions["createAgents"] } }).catch(() => {})}>
                <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">{t("Sur demande")}</SelectItem>
                  <SelectItem value="allow">{t("Toujours")}</SelectItem>
                  <SelectItem value="deny">{t("Jamais")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      ))}
      <p className="text-muted-foreground text-xs">{t("Les actions sensibles demandent toujours ton accord.")}</p>
    </div>
  );

  if (view === "data") return (
    <div className="pb-6" data-circle-section="data">
      {back(t("Détails"))}
      <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("Connaissances")}</p>
      <button className={row} onClick={() => onOpenTab?.("files")}><span className="flex-1 text-sm">{t("Fichiers")}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
      <button className={row} onClick={() => onOpenTab?.("memory")}><span className="flex-1 text-sm">{t("Mémoire")}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
      <p className="mt-5 mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("Ressources connectées")}</p>
      <button className={row} onClick={() => (window.location.hash = "#/settings/computer")}><span className="flex-1 text-sm">{t("Ordinateur")}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
      <button className={row} onClick={() => (window.location.hash = "#/settings/connectors")}><span className="flex-1 text-sm">{t("Connecteurs")}</span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
    </div>
  );

  if (view === "advanced") return <Advanced agent={agent} save={save} onBack={back(t("Détails"))} picking={picking} setPicking={setPicking} />;

  return (
    <div className="pb-6" data-circle-section="home">
      <InlineName agent={agent} onSave={(name) => save({ name })} />
      {agent.description && <p className="mt-1 text-muted-foreground text-sm">{agent.description}</p>}
      <div className="mt-4 border-t">
        <button className={row} onClick={() => setView("advanced")}>
          <span className="min-w-0 flex-1"><span className="block text-sm">{t("Modèle")}</span><span className="block truncate text-muted-foreground text-xs">{agent.effectiveModel.model} · {agent.model ? t("propre à ce Circle") : t("modèle par défaut")}</span></span>
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        </button>
        <button className={row} onClick={() => setView("permissions")}><span className="min-w-0 flex-1"><span className="block text-sm">{t("Permissions")}</span><span className="block text-muted-foreground text-xs">{t("Ce qu’il a le droit de faire")}</span></span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
        <button className={row} onClick={() => setView("data")}><span className="min-w-0 flex-1"><span className="block text-sm">{t("Données et connexions")}</span><span className="block text-muted-foreground text-xs">{t("Fichiers, mémoire, ordinateur")}</span></span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
        <button className={row} onClick={() => setView("advanced")}><span className="min-w-0 flex-1"><span className="block text-sm">{t("Avancé")}</span><span className="block text-muted-foreground text-xs">{t("Modèle, personnalité, consignes")}</span></span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
        <button className={row} onClick={() => onOpenTab?.("journal")}><span className="min-w-0 flex-1"><span className="block text-sm">{t("Activité")}</span><span className="block text-muted-foreground text-xs">{t("Les opérations importantes qu’il a faites")}</span></span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>
      </div>
    </div>
  );
}

/** The name with a pencil; editing happens in place: Enter or ✓ saves, Escape or × cancels. */
function InlineName({ agent, onSave }: { agent: AgentDTO; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false), [value, setValue] = useState(agent.name), [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(false); setValue(agent.name); }, [agent.id, agent.name]);
  const valid = value.trim().length > 0 && value.trim().length <= 40;
  async function commit() {
    if (!valid) return;
    if (value.trim() === agent.name) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(value.trim()); setEditing(false); } catch { /* keeps the old name, the field stays open */ } finally { setBusy(false); }
  }
  if (!editing) return (
    <div className="flex items-center gap-1">
      <h2 className="truncate font-semibold text-lg">{agent.name}</h2>
      <Button size="icon" variant="ghost" className="size-7 rounded-full text-muted-foreground" aria-label={t("Renommer")} onClick={() => { setValue(agent.name); setEditing(true); }}><PencilIcon className="size-3.5" /></Button>
    </div>
  );
  return (
    <div className="flex items-center gap-1" data-rename>
      <Input autoFocus value={value} maxLength={40} disabled={busy} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} aria-label={t("Nom")}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } if (e.key === "Escape") { e.preventDefault(); setEditing(false); setValue(agent.name); } }} />
      <Button size="icon" variant="ghost" className="size-8" aria-label={t("Enregistrer")} disabled={!valid || busy} onClick={() => void commit()}><CheckIcon className="size-4" /></Button>
      <Button size="icon" variant="ghost" className="size-8" aria-label={t("Annuler")} onClick={() => { setEditing(false); setValue(agent.name); }}><XIcon className="size-4" /></Button>
    </div>
  );
}

function Advanced({ agent, save, onBack, picking, setPicking }: { agent: AgentDTO; save: (patch: Parameters<typeof api.updateAgent>[1]) => Promise<void>; onBack: React.ReactNode; picking: boolean; setPicking: (v: boolean) => void }) {
  const [draft, setDraft] = useState({ description: agent.description, personality: agent.personality, instructions: agent.instructions });
  useEffect(() => { setDraft({ description: agent.description, personality: agent.personality, instructions: agent.instructions }); }, [agent.id, agent.description, agent.personality, agent.instructions]);
  const dirty = draft.description !== agent.description || draft.personality !== agent.personality || draft.instructions !== agent.instructions;
  return (
    <div className="space-y-5 pb-6" data-circle-section="advanced">
      {onBack}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("Modèle")}</Label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-md border px-2.5 py-1.5 font-mono text-xs">
            {agent.effectiveModel.model}
            {!agent.model && <span className="ml-1 font-sans text-muted-foreground">{t("(par défaut)")}</span>}
          </div>
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>{t("Changer")}</Button>
        </div>
        {agent.model && <button className="text-muted-foreground text-xs underline-offset-2 hover:underline" onClick={() => void save({ model: null }).catch(() => {})}>{t("Revenir au modèle par défaut")}</button>}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("Couleur")}</Label>
        <div className="flex gap-1.5">
          {COLORS.map((c) => (
            <button key={c} onClick={() => void save({ color: c }).catch(() => {})} className="flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition hover:scale-110" style={{ background: c, boxShadow: agent.color === c ? `0 0 0 2px ${c}` : undefined }} aria-label={c}>
              {agent.color === c && <CheckIcon className="size-3 text-white" />}
            </button>
          ))}
        </div>
      </div>
      <Field label={t("Responsabilités")}><Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
      <Field label={t("Personnalité")}><Textarea rows={2} value={draft.personality} onChange={(e) => setDraft({ ...draft, personality: e.target.value })} /></Field>
      <Field label={t("Consignes")}><Textarea rows={4} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></Field>
      {dirty && <Button size="sm" className="w-full" onClick={() => void save(draft).catch(() => {})}>{t("Enregistrer")}</Button>}
      <p className="rounded-lg bg-muted/60 p-2.5 text-muted-foreground text-xs">{t("Astuce : tu peux aussi simplement dire à {name} « sois plus direct » ou « utilise tel modèle ».", { name: agent.name })}</p>
      <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive" onClick={async () => {
        if (!confirm(t("Retirer {v0} ? Ses activités seront suspendues.", { v0: agent.name }))) return;
        try { await api.archiveAgent(agent.id); removeAgentLocally(agent.id); } catch (e) { toast.error((e as Error).message); }
      }}><ArchiveIcon /> {t("Retirer ce Circle")}</Button>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="flex h-[70vh] max-w-lg flex-col">
          <DialogHeader><DialogTitle>{t("Modèle de {name}", { name: agent.name })}</DialogTitle></DialogHeader>
          <ModelPicker className="min-h-0 flex-1" value={agent.model?.model ?? null} onChange={async (m) => {
            await save({ model: { provider: m.provider, model: m.id, reasoning: m.reasoning ? agent.effectiveModel.reasoning ?? "medium" : null } }).catch(() => {});
            setPicking(false);
          }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
