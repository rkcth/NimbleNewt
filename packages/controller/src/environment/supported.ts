/**
 * The one list of environments NimbleNewt claims to support (card F04h). Everything that checks, prints or documents support reads this;
 * nothing else keeps its own copy. "Supported" means tested: each entry is something the project's CI or QA runs actually exercised, and
 * `evidence` says what. The owner's decisions of 2026-10-20: claim what CI covers; refuse to start elsewhere unless the operator overrides
 * (the override exists so someone who has verified their own environment is not locked out). The exact release floors below are the lowest
 * releases seen in CI and are for the owner to confirm or widen.
 */
export interface PlatformSupport {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly name: string;
  /** Lowest `os.release()` major number (Darwin 25 is macOS 26), or the lowest Windows build number; absent when no floor is claimed. */
  readonly minimumRelease?: number;
  /** What the floor means in the operating system's own terms. */
  readonly releaseNote?: string;
  readonly evidence: string;
}

export const SUPPORTED_ENVIRONMENT = {
  node: { minimum: "22.19.0", evidence: "Node 22.19.0 and 24.21.0 pass CI on every push" },
  postgres: { minimumMajor: 17, evidence: "PostgreSQL 17 and 18 pass the full suites on Linux, macOS and Windows (card F04g); 14 to 16 also pass but are not claimed" },
  platforms: [
    { platform: "linux", arch: "x64", name: "Linux x64", evidence: "GitHub-hosted Ubuntu runner (kernel 6.17) and the development server (Ubuntu 26.04, kernel 7.0)" },
    { platform: "darwin", arch: "arm64", name: "macOS on Apple silicon", minimumRelease: 25, releaseNote: "Darwin 25, macOS 26", evidence: "GitHub-hosted macOS runner (Darwin 25.6.0)" },
    { platform: "win32", arch: "x64", name: "Windows x64", minimumRelease: 26100, releaseNote: "Windows build 26100 (Windows 11 24H2 and Windows Server 2025)", evidence: "GitHub-hosted Windows runner (10.0.26100)" },
  ] satisfies readonly PlatformSupport[],
  /**
   * File systems under the data directory and the workspaces (card F04i; owner decision 2026-10-22: an unsupported one is an error the operator can override). Names are lower case, as the
   * system reports them. Case-insensitive and normalising ones (APFS, NTFS) are on the list because the workspace bridge folds names itself.
   */
  filesystems: [
    { platform: "linux", names: ["ext4", "xfs", "btrfs"], evidence: "ext4: the development server and GitHub-hosted Ubuntu runners; xfs and btrfs are on the list by the owner's decision and are not exercised by CI" },
    { platform: "darwin", names: ["apfs"], evidence: "GitHub-hosted macOS runner" },
    { platform: "win32", names: ["ntfs"], evidence: "GitHub-hosted Windows runner" },
  ] satisfies readonly FilesystemSupport[],
} as const;

export interface FilesystemSupport { readonly platform: NodeJS.Platform; readonly names: readonly string[]; readonly evidence: string }

/** File system types that live on another machine (or in another process). Never supported for the data directory; the same type under a workspace is refused as well, as it is not on the list. */
export const NETWORK_FILESYSTEMS: readonly RegExp[] = [
  /^nfs\d*$/, /^cifs$/, /^smb\d*$/, /^smbfs$/, /^afs$/, /^afpfs$/, /^ncpfs$/, /^ceph$/, /^9p$/, /^lustre$/, /^gpfs$/, /^glusterfs$/, /^beegfs$/, /^davfs$/, /^webdav$/, /^coda$/, /^sshfs$/, /^ocfs2$/,
  /^fuse\./, /^fuse$/, /^macfuse$/, /^osxfuse$/, /^fusefs$/,
];

/**
 * What the controller, the workspace bridge and the sandbox need from the host, found by probing and never by the name of a Linux distribution (card F04j; owner decision 2026-10-22: there are
 * too many distributions to list). This is the one list. The Node version is NOT here: it is `SUPPORTED_ENVIRONMENT.node`, checked by the F04h check.
 * `needs` says which part of the controller wants it: `start` always, `sqlite` and `postgres` with that storage, `sandbox` and `limits` when the controller is told it will run those locally.
 * A missing one is a hard stop that no switch overrides (the feature cannot run without it) unless `missing` says `overridable`; a version below `minimum` can always be overridden.
 */
export type PrerequisiteNeed = "start" | "sqlite" | "postgres" | "sandbox" | "limits";
export interface PrerequisiteSpec {
  readonly id: string;
  readonly name: string;
  readonly needs: PrerequisiteNeed;
  readonly platforms: readonly NodeJS.Platform[];
  /** Lowest version, for tools that report one. The floor is derived from what the code uses and is for the owner to confirm. */
  readonly minimum?: string;
  readonly missing: "hard" | "overridable";
  readonly install: string;
  /** Another prerequisite that must be present for this one to be probed (an absent bubblewrap makes a user-namespace probe meaningless). */
  readonly after?: string;
  /** What the override means, for the ones that can be overridden when missing. */
  readonly overrideMeans?: string;
}

export const REQUIRED_PREREQUISITES: readonly PrerequisiteSpec[] = [
  { id: "git", name: "git", needs: "start", platforms: ["linux", "darwin", "win32"], minimum: "2.38.1", missing: "hard", install: "install Git from https://git-scm.com/downloads or with your system's package manager, and make sure `git` is on the PATH of the service" },
  { id: "bubblewrap", name: "bubblewrap (bwrap)", needs: "sandbox", platforms: ["linux"], missing: "hard", install: "install the `bubblewrap` package with your system's package manager and make sure `bwrap` is on the PATH of the service" },
  { id: "user-namespaces", name: "unprivileged user namespaces (kernel feature bubblewrap needs)", needs: "sandbox", platforms: ["linux"], missing: "hard", after: "bubblewrap", install: "enable unprivileged user namespaces for the service user (kernel settings such as user.max_user_namespaces, or the security module's policy for bwrap); inside a container, allow them for the container" },
  { id: "sandbox-exec", name: "sandbox-exec (Seatbelt)", needs: "sandbox", platforms: ["darwin"], missing: "hard", install: "sandbox-exec ships with macOS at /usr/bin/sandbox-exec; a macOS that no longer provides it cannot run the macOS sandbox" },
  { id: "systemd-user-session", name: "a systemd user session (systemd-run --user --scope)", needs: "limits", platforms: ["linux"], missing: "overridable", install: "run the service as a user with a systemd user session (for example `loginctl enable-linger <user>` and start it from that session) with cgroup v2 delegation", overrideMeans: "resource limits then use the weaker fallbacks the launch record reports (some are partial or none), and a launch that requires full enforcement is still refused" },
  { id: "sqlite-library", name: "the SQLite library (node:sqlite)", needs: "sqlite", platforms: ["linux", "darwin", "win32"], missing: "hard", install: "use a Node.js build that includes node:sqlite (the official builds do), at the minimum version in the supported list" },
  { id: "postgres-library", name: "the PostgreSQL client library (pg)", needs: "postgres", platforms: ["linux", "darwin", "win32"], missing: "hard", install: "run `npm ci` in the installation so the `pg` package is present" },
];

/** The switch that lets an operator start in an environment the list does not cover. */
export const OVERRIDE_FLAG = "--allow-unsupported-environment";
export const OVERRIDE_ENV = "NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT";
