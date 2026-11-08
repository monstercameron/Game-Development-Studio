// Read-only MCP tool for the Recovery report. It calls Forge's loopback /api/recovery route and
// returns redacted evidence only (ids, counts, project-relative paths). Acting on the report
// (resolving or retrying a job, moving orphaned files) needs the Recovery panel and a person.

export function registerRecoveryTools(server, { read, readonly }) {
  server.registerTool(
    'forge_recovery_report',
    {
      description:
        'Read the Recovery report: whether the previous studio session ended without an orderly shutdown (crash, kill, power loss), which render jobs are interrupted or need attention and whether each is provably safe to retry, orphaned staging files, databases that were checked, restored from a backup or started fresh, engine ownership and reachability (a refused connection versus a hang), and recent recovery events. Read-only: an interrupted job whose remote outcome is unknown is never retried automatically, and resolving it is a confirmed action in the studio.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/recovery'),
  );
}
