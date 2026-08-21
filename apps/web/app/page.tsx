import { headers } from "next/headers";

type ActivityResponse = {
  completeness: string;
  events: Array<{ id: string; occurredAt: string; verb: string; contributionRole: string; contextKind: string; actorKind: string; message?: string; sourceUrl?: string }>;
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
    <header><h1>DevMemoir</h1>{!activity ? <a className="button" href={`${apiOrigin}/auth/github/start?returnPath=/`}>Continue with GitHub</a> : null}</header>
    {!activity ? <section className="card"><p>Connect a GitHub App installation to see observed work in a repository you selected.</p><p className="muted">This is not a complete GitHub history.</p></section> : <>
      <section className="card"><strong>{activity.completeness}</strong><p className="muted">Observed facts from the connected repository are shown below.</p></section>
      <section className="card">{activity.events.length === 0 ? <p className="muted">No activity has been imported yet.</p> : activity.events.map((event) => <article className="event" key={event.id}>
        <div><strong>{event.verb}</strong> <span className="muted">({event.contributionRole}, {event.contextKind})</span></div>
        <time className="muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
        {event.message ? <p>{event.message}</p> : null}
        {event.sourceUrl ? <a href={event.sourceUrl} rel="noreferrer">View source</a> : null}
      </article>)}</section>
    </>}
  </main>;
}
