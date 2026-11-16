import { useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { AgentAvatar, ApprovalDTO } from "@opendots/shared";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ServiceLogo } from "@/components/brand/service-logo";
import { DotAvatar } from "../dot-avatar";

import { t } from "@/lib/i18n";
const STATUS: Record<ApprovalDTO["status"], string> = {
  pending: "En attente de ta validation",
  // Granted is not done: the server executes it next and reports the real outcome.
  approved: "Autorisation accordée · exécution…",
  executed: "Autorisé et exécuté",
  failed: "Autorisé, mais l’exécution a échoué",
  rejected: "Refusé",
  expired: "Expiré",
};

/** Consequences that must stay visible before the decision, however compact the card. */
const RISKY = /\b(delete|remove|destroy|drop|purge|wipe|force|dns|purchase|pay|payment|transfer|sudo|root|chmod|rm\s+-rf|supprim|efface|achat|paiement|virement)\b/i;

/**
 * Un résumé d'approbation arrive en une ligne (« Service — compte · action · commit … · {json} »).
 * On le découpe : le contexte, l'action en titre, et la charge utile en détails repliés.
 */
export function splitApprovalSummary(summary: string): { context: string | null; title: string; details: [string, string][]; extra: string[] } {
  const parts = summary.split(" · ").map((part) => part.trim()).filter(Boolean);
  const details: [string, string][] = [];
  const extra: string[] = [];
  const text: string[] = [];
  for (const part of parts) {
    if (/^[{[]/.test(part)) {
      try {
        const value = JSON.parse(part) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [key, v] of Object.entries(value)) details.push([key, typeof v === "string" ? v : JSON.stringify(v)]);
        } else extra.push(part);
      } catch {
        extra.push(part);
      }
    } else if (/^commit [0-9a-f]{7,}$/i.test(part)) details.push(["commit", part.slice(7, 19)]);
    else text.push(part);
  }
  if (!text.length) return { context: null, title: summary, details: [], extra: [] };
  const context = text.length > 1 && text[0].length <= 80 ? text[0] : null;
  const rest = context ? text.slice(1) : text;
  return { context, title: rest[0], details, extra: [...rest.slice(1), ...extra] };
}

/**
 * Validation d'une opération précise du backend. En attente : compacte (quoi, où, qui demande), détails à la demande,
 * conséquences visibles d'emblée pour une action à risque. Décidée : une seule ligne, l'état réel venant du serveur.
 */
export function ApprovalCard({ approvalId, fallbackSummary, embedded }: { approvalId: string; fallbackSummary?: string; embedded?: boolean }) {
  const approval = useStore((s) => s.approvals.find((a) => a.id === approvalId));
  const agent = useStore((s) => s.agents.find((a) => a.id === approval?.agentId));
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const status = approval?.status ?? "pending";
  const raw = approval?.summary ?? fallbackSummary ?? t("Action à valider");
  const summary = splitApprovalSummary(raw);
  const risky = RISKY.test(raw) || approval?.action === "shell.exec";
  const [open, setOpen] = useState(false);
  const showDetails = open || (status === "pending" && risky);
  const hasDetails = summary.details.length > 0 || summary.extra.length > 0 || approval?.action === "computer.action" || Boolean(approval?.error);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    try {
      const res = await api.decide(approvalId, decision);
      if (res.status === "failed") toast.error(res.error ?? t("L’exécution a échoué"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const details = showDetails && hasDetails && (
    <div className="mt-2 space-y-1.5 text-xs" data-approval-details>
      {(summary.details.length > 0 || summary.extra.length > 0) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-muted/60 p-2">
          {summary.details.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-words font-mono text-[11px]">{value.length > 400 ? `${value.slice(0, 400)}…` : value}</dd>
            </div>
          ))}
          {summary.extra.map((line, index) => <dd key={index} className="col-span-2 break-words text-muted-foreground">{line}</dd>)}
        </dl>
      )}
      {approval?.action === "computer.action" && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2">{JSON.stringify((approval.input as { action?: unknown })?.action, null, 2)}</pre>}
      {approval?.error && <p className="text-destructive">{approval.error}</p>}
    </div>
  );

  if (status !== "pending") {
    const Icon = status === "executed" ? CheckIcon : status === "failed" ? CircleAlertIcon : status === "approved" ? CheckIcon : XIcon;
    return (
      <div className={cn("not-prose w-full", !embedded && "max-w-md rounded-2xl border bg-card")} data-approval={status}>
        <button type="button" onClick={() => setOpen(!open)} disabled={!hasDetails} aria-expanded={open}
          className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left disabled:cursor-default">
          {approval?.action === 'avatar.set' ? <AvatarProposal input={approval.input} /> : <ServiceLogo service={approval?.service} />}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm">{summary.title}</span>
            <span className={cn("block truncate text-xs", status === "failed" ? "text-destructive" : "text-muted-foreground")}>{t(STATUS[status])}</span>
          </span>
          <Icon className={cn("size-4 shrink-0", status === "failed" ? "text-destructive" : status === "executed" ? "text-success" : "text-muted-foreground")} aria-hidden />
          {hasDetails && <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />}
        </button>
        {open && <div className="px-3.5 pb-3">{details}</div>}
      </div>
    );
  }

  return (
    <div className={cn("not-prose w-full px-3.5 py-3", !embedded && "max-w-md rounded-2xl border border-foreground/25 bg-card")} data-approval="pending">
      <div className="flex items-start gap-3">
        {approval?.action === "avatar.set" ? <AvatarProposal input={approval.input} /> : <ServiceLogo service={approval?.service} className="mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm leading-snug [overflow-wrap:anywhere]">{summary.title}</p>
          <p className="truncate text-muted-foreground text-xs">{[summary.context, agent ? t("Demandé par {v0}", { v0: agent.name }) : null].filter(Boolean).join(" · ")}</p>
          {risky && <p className="mt-1 flex items-center gap-1 text-destructive text-xs"><TriangleAlertIcon className="size-3" />{t("Action à conséquences : vérifie les détails avant d’autoriser.")}</p>}
          {details}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {hasDetails && !risky && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">{t("Détails")}<ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} /></button>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => decide("reject")} disabled={!!busy}>{t("Refuser")}</Button>
        <Button size="sm" className="h-8 rounded-full" onClick={() => decide("approve")} disabled={!!busy}>{t("Autoriser")}</Button>
      </div>
    </div>
  );
}

/**
 * Several validations asked together: one surface, each operation decided on its own (scopes differ, so there is no
 * blind "approve all"); refusing everything is allowed.
 */
export function ApprovalGroup({ ids }: { ids: string[] }) {
  const approvals = useStore((s) => s.approvals);
  const pending = ids.filter((id) => (approvals.find((a) => a.id === id)?.status ?? "pending") === "pending");
  async function rejectAll() {
    for (const id of pending) await api.decide(id, "reject").catch((e) => toast.error((e as Error).message));
  }
  return (
    <div className="not-prose w-full max-w-md overflow-hidden rounded-2xl border bg-card" data-approval-group={ids.length}>
      <div className="flex items-center gap-2 border-b px-3.5 py-2 text-xs">
        <span className="font-medium">{t("{count} validations demandées", { count: ids.length })}</span>
        {pending.length > 0 && <span className="text-muted-foreground">· {t("{count} en attente", { count: pending.length })}</span>}
        <span className="flex-1" />
        {pending.length > 1 && <button type="button" onClick={() => void rejectAll()} className="text-muted-foreground hover:text-foreground">{t("Tout refuser")}</button>}
      </div>
      <div className="divide-y">{ids.map((id) => <ApprovalCard key={id} approvalId={id} embedded />)}</div>
    </div>
  );
}


/** #50: a proposed silhouette is shown as it will look, before the user approves it. */
function AvatarProposal({ input }: { input: unknown }) {
  const value = input as { agentId?: string; avatar?: AgentAvatar; color?: string } | null;
  const agent = useStore((s) => s.agents.find((a) => a.id === value?.agentId));
  return <span data-avatar-proposal><DotAvatar color={value?.color ?? agent?.color ?? '#7c3aed'} shape={value?.avatar ?? null} size={36} /></span>;
}
