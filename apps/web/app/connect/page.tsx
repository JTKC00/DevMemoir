import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { claimInstallation, connectRepository, startInstallation } from "./actions";

type ConnectRepository = { id: number; fullName: string; private: boolean; defaultBranch: string };
type ConnectOptions = { connected: boolean; repositories: ConnectRepository[] };

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
    {options.connected && options.repositories.length === 0 && !params.claim ? <section className="card"><p>Installation connected. No repository inventory is available yet.</p></section> : null}
    {options.connected && options.repositories.length > 0 ? <section className="card">
      <h2>2. Select one repository</h2>
      <p>Milestone 1 supports exactly one connected repository.</p>
      <form action={connectRepository}>
        <label htmlFor="fullName">Repository</label>
        <select id="fullName" name="fullName" required defaultValue="">
          <option value="" disabled>Select a repository</option>
          {options.repositories.map((repository) => <option key={repository.id} value={repository.fullName}>{repository.fullName}{repository.private ? " (private)" : ""}</option>)}
        </select>
        <button type="submit">Connect repository</button>
      </form>
    </section> : null}
  </main>;
}
