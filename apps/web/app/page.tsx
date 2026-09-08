import { headers } from "next/headers";
import { ACTIVITY_CONTEXTS, ACTIVITY_TYPES, activityFilters, groupActivity, type ActivityParams, type ActivityResponse } from "./activity";

type ActivityResult = { status: "ready"; activity: ActivityResponse } | { status: "unauthorized" | "unavailable" };

async function loadActivity(filters: ReturnType<typeof activityFilters>): Promise<ActivityResult> {
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const query = new URLSearchParams({ context: filters.context, includeBots: String(filters.includeBots) });
  try {
    const response = await fetch(`${apiOrigin}/api/activity?${query}`, { headers: cookie ? { cookie } : {}, cache: "no-store" });
    if (response.status === 401) return { status: "unauthorized" };
    if (!response.ok) return { status: "unavailable" };
    return { status: "ready", activity: await response.json() as ActivityResponse };
  } catch {
    return { status: "unavailable" };
  }
}

export default async function HomePage({ searchParams }: { searchParams?: Promise<ActivityParams> }) {
  const params = await searchParams ?? {};
  const filters = activityFilters(params);
  const result = await loadActivity(filters);
  const retryQuery = new URLSearchParams({ context: filters.context, type: filters.type, includeBots: String(filters.includeBots) });
  if (result.status === "unavailable") return <main>
    <header><h1>DevMemoir</h1></header>
    <section className="card" role="alert"><h2>Activity is temporarily unavailable</h2><p>We could not load your activity. Please try again.</p><a className="button" href={`/?${retryQuery}`}>Retry</a></section>
  </main>;
  const activity = result.status === "ready" ? result.activity : null;
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:4000";
  const groups = groupActivity(activity?.events ?? [], filters.type);
  const importPending = activity?.historical && activity.historical.status !== "completed";
  return <main>
    <header><h1>DevMemoir</h1>{!activity ? <a className="button" href={`${apiOrigin}/auth/github/start?returnPath=/`}>Continue with GitHub</a> : <nav aria-label="Main navigation"><a href="/ops">Operations</a> · <a className="button" href="/connect">{activity.repository ? "Manage connection" : "Connect GitHub"}</a></nav>}</header>
    {params.error === "login_failed" ? <section className="card" role="alert"><p>Sign-in could not be completed. Please try signing in again.</p></section> : null}
    {!activity ? <section className="card"><p>Connect a GitHub App installation to see observed work in a repository you selected.</p><p className="muted">This is not a complete GitHub history.</p></section> : <>
      <section className="card">{activity.repository ? <>
        <h2>{activity.repository.fullName}</h2>
        <p className="muted">{activity.completeness}</p>
        {activity.historical ? <>
          <p><strong>Historical import:</strong> {activity.historical.status.replaceAll("_", " ")}</p>
          {importPending ? <p>Activity may appear as the import progresses. <a href={`/?${retryQuery}`}>Refresh activity</a> · <a href="/connect">View import progress</a></p> : null}
          <details><summary>History coverage</summary><p>{activity.historical.completeness.observed} {activity.historical.completeness.knownUnknown}</p><p>{activity.historical.completeness.outOfScope}</p></details>
        </> : null}
      </> : <><strong>No repository connected</strong><p className="muted">Connect one repository to begin the supported historical import.</p></>}</section>
      {activity.repository ? <>
        <section className="card">
          <h2>Your development activity</h2>
          <form className="activity-filters" action="/" method="get">
            <label>Show<select name="context" defaultValue={filters.context}>{Object.entries(ACTIVITY_CONTEXTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Activity type<select name="type" defaultValue={filters.type}>{Object.entries(ACTIVITY_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="checkbox-label"><input type="checkbox" name="includeBots" value="true" defaultChecked={filters.includeBots} /> Include bots</label>
            <button type="submit">Apply filters</button><a href="/">Reset filters</a>
          </form>
          <p className="muted">Dates and times shown in UTC. Filters apply to the activity returned for this view.</p>
        </section>
        {groups.length === 0 ? <section className="card"><p>{activity.events.length > 0 || filters.context !== "default" || filters.type !== "all" ? "No activity matches these filters." : importPending ? "Your repository is connected. Activity will appear as the import progresses." : "No activity has been observed for this repository yet."}</p></section> : groups.map(({ day, events }) => <section className="card" key={day} aria-label={`Activity on ${day}`}>
          <h2><time dateTime={day}>{day}</time></h2>
          {events.map((event) => <article className="event" key={event.id}>
            <div className="event-heading"><strong>{event.sourceKind.replaceAll("_", " ")} · {event.verb.replaceAll("_", " ")}</strong><time className="muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toISOString().slice(11, 16)} UTC</time></div>
            {event.title ? <p>{event.title}</p> : null}
            {event.message && event.message !== event.title ? <p>{event.message}</p> : null}
            {event.sourceUrl ? <a href={event.sourceUrl} rel="noreferrer">View source</a> : null}
            <details><summary>Activity details</summary><p>{(event.ownerContributionRole ?? event.contributionRole).replaceAll("_", " ")} · {event.contextKind}{event.visibility === "private" ? " · private" : ""}</p><p className="muted">{event.completenessState.replaceAll("_", " ")} · attribution {event.attributionConfidence.replaceAll("_", " ")}</p></details>
          </article>)}
        </section>)}
      </> : null}
    </>}
  </main>;
}
