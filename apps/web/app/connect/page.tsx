import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { claimInstallation, connectRepository, refreshInventory, resumeBackfill, startInstallation, unselectRepository } from "./actions";

type HistoricalStatus = {
  status: string;
  stage: string;
  lastSuccessAt?: string;
  pausedUntil?: string;
  counts: { commits: number; branches: number; tags: number; pullRequests: number; issues: number; releases: number };
  completeness: { observed: string; reachableAtSync: string; knownUnknown: string; outOfScope: string };
};

type ConnectRepository = {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  selected: boolean;
  accessStatus: string;
  lastAuthoritativeObservedAt?: string;
  archived?: boolean;
  disabled?: boolean;
  historical: HistoricalStatus;
};
type ConnectOptions = { connected: boolean; installationStatus?: string; lastInventoryAt?: string; repositories: ConnectRepository[] };

async function apiGet(path: string): Promise<Response> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  return fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}${path}`, { headers: cookie ? { cookie } : {}, cache: "no-store" });
}

export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ connected?: string; installation_id?: string; claim?: string; error?: string }> }) {
  const params = await searchParams;
  const sessionResponse = await apiGet("/auth/session");
  if (!sessionResponse.ok) redirect("/");
  const optionsResponse = await apiGet("/connect/repositories");
  const options = optionsResponse.ok ? await optionsResponse.json() as ConnectOptions : { connected: false, repositories: [] };
  const errorText = params.error ? "The requested connection could not be completed. Please try again." : null;

  return <main>
    <header><h1>Connect GitHub</h1><a href="/">Back to activity</a></header>
    {errorText ? <section className="card"><p>{errorText}</p></section> : null}
    {params.claim && params.installation_id ? <section className="card">
      <h2>Claim this installation</h2>
      <p>GitHub returned without a one-time state value. Confirm that this installation belongs to your allowlisted GitHub account.</p>
      <form action={claimInstallation}><input type="hidden" name="installation_id" value={params.installation_id} /><button type="submit">Confirm installation</button></form>
    </section> : null}
    {!options.connected && !params.claim ? <section className="card">
      <h2>1. Install the DevMemoir GitHub App</h2>
      <p>Choose the repositories that DevMemoir may read. Installation ownership is checked against your signed-in GitHub user.</p>
      <form action={startInstallation}><button type="submit">Install GitHub App</button></form>
    </section> : null}
    {options.connected ? <section className="card">
      <h2>2. Repository access</h2>
      <p className="muted">GitHub App access and DevMemoir tracking are separate. This inventory is authoritative only after a complete GitHub pagination run.</p>
      <p className="muted">{options.lastInventoryAt ? `Last synchronized: ${new Date(options.lastInventoryAt).toLocaleString()}` : "Inventory refresh is pending."}</p>
      <form action={refreshInventory}><button type="submit">Refresh repository access</button></form>
      {options.repositories.length === 0 ? <p className="muted">No accessible repositories are recorded yet.</p> : <div className="repository-list">
        {options.repositories.map((repository) => {
          const accessible = repository.accessStatus === "accessible";
          const activelyTracking = accessible && repository.selected;
          return <article className="repository-row" key={repository.id}>
            <div><strong>{repository.fullName}</strong> <span className="muted">{repository.private ? "private" : "public"}</span></div>
            <div className="muted">GitHub access: {accessible ? "accessible" : repository.accessStatus.replaceAll("_", " ")}</div>
            <div className="muted">DevMemoir: {activelyTracking ? "actively tracking" : accessible ? "not selected" : "not tracking (access unavailable)"}{repository.lastAuthoritativeObservedAt ? ` · observed ${new Date(repository.lastAuthoritativeObservedAt).toLocaleString()}` : ""}</div>
            {activelyTracking ? <div className="muted">Historical import: {repository.historical.status.replaceAll("_", " ")} · {repository.historical.stage.replaceAll("_", " ")}{repository.historical.lastSuccessAt ? ` · last success ${new Date(repository.historical.lastSuccessAt).toLocaleString()}` : ""}{repository.historical.pausedUntil ? ` · resumes after ${new Date(repository.historical.pausedUntil).toLocaleString()}` : ""}</div> : null}
            {activelyTracking ? <div className="muted">Observed facts: {repository.historical.counts.commits} commits · {repository.historical.counts.branches} branches · {repository.historical.counts.tags} tags · {repository.historical.counts.pullRequests} pull requests · {repository.historical.counts.issues} issues · {repository.historical.counts.releases} releases</div> : null}
            {activelyTracking ? <p className="muted">{repository.historical.completeness.knownUnknown} {repository.historical.completeness.outOfScope}</p> : null}
            {repository.archived || repository.disabled ? <div className="muted">{repository.archived ? "archived" : ""}{repository.archived && repository.disabled ? " · " : ""}{repository.disabled ? "disabled" : ""}</div> : null}
            {activelyTracking && repository.historical.status !== "completed" ? <form action={resumeBackfill}><input type="hidden" name="repositoryId" value={repository.id} /><button type="submit">Start or resume historical import</button></form> : null}
            {activelyTracking ? <form action={unselectRepository}><input type="hidden" name="repositoryId" value={repository.id} /><button type="submit">Stop tracking</button></form> : null}
          </article>;
        })}
      </div>}
      <h3>Choose a repository to track</h3>
      <p className="muted">M2 keeps the existing M1 limit of one actively tracked repository. Inventory access alone does not start a historical import.</p>
      <form action={connectRepository}>
        <label htmlFor="repositoryId">Accessible repository</label>
        <select id="repositoryId" name="repositoryId" required defaultValue="">
          <option value="" disabled>Select a repository</option>
          {options.repositories.filter((repository) => repository.accessStatus === "accessible" && !repository.selected).map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}{repository.private ? " (private)" : ""}</option>)}
        </select>
        <button type="submit">Start tracking</button>
      </form>
    </section> : null}
  </main>;
}
