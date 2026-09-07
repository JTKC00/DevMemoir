export default function DeletionRequestedPage() {
  return <main><section className="card"><h1>Account deletion requested</h1><p>Access has been revoked. Live-data removal is queued for the privacy worker and may still be pending.</p><p>Minimal identity and installation records remain to reject late requests. Backup removal has not been verified; existing backups may retain data until their retention period ends.</p><p>Deleting your DevMemoir account does not uninstall the GitHub App. Manage the installation in GitHub settings.</p></section></main>;
}
