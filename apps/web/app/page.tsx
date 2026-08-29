import { headers } from "next/headers";

type ActivityResponse = {
  completeness: string;
  repository?: { id: string; fullName: string; private: boolean };
  historical?: {
    status: string;
    stage: string;
    lastSuccessAt?: string;
    counts: { commits: number; branches: number; tags: number; pullRequests: number; issues: number; releases: number };
    completeness: { observed: string; reachableAtSync: string; knownUnknown: string; outOfScope: string };
  };
  events: Array<{ id: string; repositoryId: string; sourceKind: string; sourceExternalId: string; eventType: string; occurredAt: string; verb: string; contributionRole: string; ownerContributionRole?: string; contextKind: string; actorKind: string; attributionConfidence: string; completenessState: string; visibility: string; projectionVersion: number; title?: string; message?: string; sourceUrl?: string }>;
};

async function loadActivity(): Promise<ActivityResponse | null> {
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const response = await fetch(`${apiOrigin}/api/activity`, { headers: cookie ? { cookie } : {}, cache: "no-store" });
  if (!response.ok) return null;
  return response.json() as Promise<ActivityResponse>;
}

export default async function HomePage() {
  const activity = await loadActivity();
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";
  return <main>
    <header><h1>DevMemoir</h1>{!activity ? <a className="button" href={`${apiOrigin}/auth/github/start?returnPath=/`}>Continue with GitHub</a> : <span><a href="/ops">Operations</a> · {activity.repository ? <a className="button" href="/connect">Manage connection</a> : <a className="button" href="/connect">Connect GitHub</a>}</span>}</header>
    {!activity ? <section className="card"><p>Connect a GitHub App installation to see observed work in a repository you selected.</p><p className="muted">This is not a complete GitHub history.</p></section> : <>
      <section className="card">{activity.repository ? <><strong>{activity.repository.fullName}</strong><p className="muted">{activity.completeness}</p>{activity.historical ? <><p><strong>Historical import:</strong> {activity.historical.status.replaceAll("_", " ")} · {activity.historical.stage.replaceAll("_", " ")}</p><p className="muted">{activity.historical.completeness.observed} {activity.historical.completeness.knownUnknown}</p><p className="muted">{activity.historical.completeness.outOfScope}</p></> : null}</> : <><strong>No repository connected</strong><p className="muted">Connect one repository to begin the supported historical import.</p></>}</section>
      <section className="card">{activity.events.length === 0 ? <p className="muted">No activity has been imported yet.</p> : activity.events.map((event) => <article className="event" key={event.id}>
        <div><strong>{event.verb}</strong> <span className="muted">({event.ownerContributionRole ?? event.contributionRole}, {event.contextKind}{event.visibility === "private" ? ", private" : ""})</span></div>
        <time className="muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
        {event.title ? <p>{event.title}</p> : null}
        {event.message ? <p>{event.message}</p> : null}
        <p className="muted">{event.completenessState.replaceAll("_", " ")} · attribution {event.attributionConfidence.replaceAll("_", " ")}</p>
        {event.sourceUrl ? <a href={event.sourceUrl} rel="noreferrer">View source</a> : null}
      </article>)}</section>
    </>}
  </main>;
}
