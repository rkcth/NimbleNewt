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
} as const;

/** The switch that lets an operator start in an environment the list does not cover. */
export const OVERRIDE_FLAG = "--allow-unsupported-environment";
export const OVERRIDE_ENV = "NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT";
