/**
 * What every background-service flavour needs to know to run `cf sync watch`.
 *
 * The three platforms differ only in how a per-user, start-at-login job is
 * declared: a systemd user unit, a launchd agent, a Windows scheduled task.
 * What they run is identical, and is described once here.
 */

export type ServiceSpec = {
  /** Absolute path of the Node binary. Services get no PATH lookup. */
  nodePath: string;
  /** Absolute path of the `cf` entry point. */
  cliPath: string;
  /** Base poll interval in seconds. */
  interval: number;
  pullOnly: boolean;
  /** Limit the service to one registered project. */
  project?: string | undefined;
};

/** Arguments after the entry point: `sync watch --interval N ...`. */
export function watchArgs(spec: ServiceSpec): string[] {
  const args = ['sync', 'watch', '--interval', String(spec.interval)];
  if (spec.pullOnly) args.push('--pull-only');
  if (spec.project) args.push('--project', spec.project);
  return args;
}
