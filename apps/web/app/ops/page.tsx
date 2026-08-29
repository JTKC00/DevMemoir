import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { resumeDeliveryRepairs, retryDeliveryAudit, retryRepositoryReconciliation } from "./actions";

type State = "healthy" | "in_progress" | "paused" | "failed" | "stale" | "never_run";
type OpsHealth = {
  overall: "healthy" | "degraded" | "attention_required";
  generatedAt: string;
  maintenance: Array<{ task: string; bucket: string; state: "completed" | "running" | "failed_or_incomplete"; acceptedAt?: string; completedAt?: string; errorCode?: string }>;
  deliveryAudit: { state: State; generation?: number; page?: number; updatedAt?: string; pausedUntil?: string; errorCode?: string };
  deliveryRepairs: { recoverable: number; terminal: number; byStatus: Record<string, number> };
  repositories: Array<{ repositoryId: string; installationGithubId: number; state: State; generation?: number; stage?: string; lastSuccessAt?: string; completedAt?: string; pausedUntil?: string; errorCode?: string }>;
};

const label = (value: string) => value.replaceAll("_", " ");
const time = (value?: string) => value ? new Date(value).toLocaleString() : "Never";
const badge = (state: string) => <span className={`status status-${state}`}>{label(state)}</span>;

async function loadHealth(): Promise<OpsHealth> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const response = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/ops/health`, { headers: cookie ? { cookie } : {}, cache: "no-store" });
  if (response.status === 401) redirect("/");
  if (response.status === 403) notFound();
  if (!response.ok) throw new Error("Operational health is temporarily unavailable");
  return response.json() as Promise<OpsHealth>;
}

export default async function OpsPage({ searchParams }: { searchParams: Promise<{ action?: string; result?: string }> }) {
  const [health, params] = await Promise.all([loadHealth(), searchParams]);
  return <main>
    <header><div><h1>Operational Health</h1><p className="muted">Owner-only metadata · generated {time(health.generatedAt)}</p></div><a href="/">Back to activity</a></header>
    {params.result ? <section className="notice">{label(params.action ?? "recovery")}: {label(params.result)}</section> : null}
    <section className="card ops-summary"><h2>Overall</h2>{badge(health.overall)}</section>
    <section className="card"><h2>Maintenance</h2><div className="ops-list">{health.maintenance.map((window) => <article className="ops-row" key={window.task}>
      <div><strong>{label(window.task)}</strong> {badge(window.state)}</div><div className="muted">Bucket {window.bucket} · accepted {time(window.acceptedAt)} · completed {time(window.completedAt)}</div>{window.errorCode ? <code>{window.errorCode}</code> : null}
    </article>)}</div></section>
    <section className="card"><h2>Repository Reconciliation</h2>{health.repositories.length === 0 ? <p className="muted">No selected, accessible repository.</p> : <div className="ops-list">{health.repositories.map((repository) => <article className="ops-row" key={repository.repositoryId}>
      <div><strong>Repository {repository.repositoryId}</strong> {badge(repository.state)}</div>
      <div className="muted">Installation {repository.installationGithubId}{repository.generation ? ` · generation ${repository.generation}` : ""}{repository.stage ? ` · ${label(repository.stage)}` : ""}</div>
      <div className="muted">Last success {time(repository.lastSuccessAt)}{repository.completedAt ? ` · completed ${time(repository.completedAt)}` : ""}{repository.pausedUntil ? ` · retry after ${time(repository.pausedUntil)}` : ""}</div>
      {repository.errorCode ? <code>{repository.errorCode}</code> : null}
      {repository.state === "in_progress" || (repository.state === "paused" && repository.pausedUntil && new Date(repository.pausedUntil) > new Date()) ? <button disabled>{repository.state === "paused" ? "Paused" : "Already running"}</button> : <form action={retryRepositoryReconciliation}><input type="hidden" name="repositoryId" value={repository.repositoryId} /><button type="submit">Retry reconciliation</button></form>}
    </article>)}</div>}</section>
    <section className="card"><h2>Delivery Audit</h2><p>{badge(health.deliveryAudit.state)}</p><p className="muted">Generation {health.deliveryAudit.generation ?? "none"} · page {health.deliveryAudit.page ?? "none"} · last activity {time(health.deliveryAudit.updatedAt)}{health.deliveryAudit.pausedUntil ? ` · retry after ${time(health.deliveryAudit.pausedUntil)}` : ""}</p>{health.deliveryAudit.errorCode ? <code>{health.deliveryAudit.errorCode}</code> : null}
      {health.deliveryAudit.state === "in_progress" || (health.deliveryAudit.state === "paused" && health.deliveryAudit.pausedUntil && new Date(health.deliveryAudit.pausedUntil) > new Date()) ? <button disabled>{health.deliveryAudit.state === "paused" ? "Paused" : "Already running"}</button> : <form action={retryDeliveryAudit}><button type="submit">Retry delivery audit</button></form>}
    </section>
    <section className="card"><h2>Delivery Repairs</h2><p>{health.deliveryRepairs.recoverable} recoverable · {health.deliveryRepairs.terminal} terminal</p><div className="repair-counts">{Object.entries(health.deliveryRepairs.byStatus).map(([status, count]) => <span key={status}><strong>{count}</strong> {label(status)}</span>)}</div>{health.deliveryRepairs.recoverable > 0 ? <form action={resumeDeliveryRepairs}><button type="submit">Resume recoverable repairs</button></form> : <button disabled>Nothing to resume</button>}</section>
  </main>;
}
