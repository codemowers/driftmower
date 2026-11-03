// The merge snippet needs two names from the served kubeconfig: the context to
// switch to, and the cluster it points at (for the scratch file name). The
// cluster is read from the context entry itself rather than taken apart from
// the context name: platform-manager has named contexts both
// `<sandbox>.<cluster>` and `<cluster>/<namespace>`, and only the cluster
// field is the same in both.
export function readContext(yaml: string, sandbox: string): { context: string; clusterName: string } {
  const context = yaml.match(/^current-context:\s*(\S+)/m)?.[1] ?? sandbox
  const clusterName =
    yaml.match(/^\s*-\s*context:\s*\n\s+cluster:\s*(\S+)/m)?.[1] ??
    yaml.match(/^\s*-\s*cluster:[\s\S]*?\n\s+name:\s*(\S+)/m)?.[1] ??
    sandbox

  // Never a path separator in a file name, whatever the cluster is called.
  return { context, clusterName: clusterName.replaceAll("/", "_") }
}
