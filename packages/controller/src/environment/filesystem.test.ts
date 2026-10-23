import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import {
  OVERRIDE_ENV, OVERRIDE_FLAG, SUPPORTED_ENVIRONMENT, UnsupportedEnvironmentError, checkFilesystems, decideStartup, detectFilesystem, filesystemSupported, isNetworkType, nearestExisting, parseMacMounts, parseMountInfo, probeNaming,
  recordOverride, refusalMessage, type FilesystemDetector, type FilesystemFacts,
} from "./index.js";

after(stopServer);

const T = "2026-10-22T10:00:00.000Z";
/** A detector that answers as one simulated file system. */
const as = (facts: FilesystemFacts): FilesystemDetector => async () => facts;
const dataDir = [{ role: "data directory" as const, path: "/srv/nn/data" }];

test("every supported file system passes on its own operating system, with no problem and no output", async () => {
  const cases: [NodeJS.Platform, FilesystemFacts][] = [
    ["linux", { type: "ext4", network: false }], ["linux", { type: "xfs", network: false }], ["linux", { type: "btrfs", network: false }],
    ["darwin", { type: "apfs", network: false, caseInsensitive: true, normalizing: true }], ["win32", { type: "ntfs", network: false, caseInsensitive: true }],
  ];
  for (const [platform, facts] of cases) {
    const reports = await checkFilesystems([...dataDir, { role: "workspace", path: "/srv/nn/ws" }], { platform, detect: as(facts) });
    assert.deepEqual(reports.map((r) => [r.supported, r.problem]), [[true, undefined], [true, undefined]], `${platform} ${facts.type}`);
    assert.deepEqual(decideStartup(reports.flatMap((r) => (r.problem === undefined ? [] : [r.problem])), { allowUnsupported: false }), { problems: [], overridden: false, output: [] });
  }
});

test("a file system that is not on the list for this operating system is a problem that says what was found, what is supported and the exact override", async () => {
  const cases: [NodeJS.Platform, string][] = [["linux", "tmpfs"], ["linux", "ext3"], ["linux", "ext"], ["linux", "overlay"], ["linux", "zfs"], ["linux", "ntfs"], ["darwin", "hfs"], ["darwin", "exfat"], ["win32", "refs"], ["win32", "fat32"], ["win32", "exfat"], ["darwin", "ext4"]];
  for (const [platform, type] of cases) {
    const [report] = await checkFilesystems(dataDir, { platform, detect: as({ type, network: false, where: "/srv" }) });
    assert.equal(report!.supported, false, `${platform} ${type}`);
    const problem = report!.problem!;
    assert.equal(problem.item, "filesystem (data directory)");
    assert.ok(problem.found.includes(type) && problem.found.includes("/srv/nn/data") && problem.found.includes("not on the list"), problem.found);
    assert.ok(problem.supported.includes("ext4, xfs, btrfs") && problem.supported.includes("APFS") && problem.supported.includes("NTFS") && problem.supported.includes("network file systems are not supported"));
    assert.equal(problem.overridable, undefined, "the F04h switch covers it");
    assert.throws(() => decideStartup([problem], { allowUnsupported: false }), (e: unknown) => {
      assert.ok(e instanceof UnsupportedEnvironmentError);
      assert.match(e.message, /will not start/);
      assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes(OVERRIDE_ENV), "names the F04h switch");
      assert.ok(e.message.includes("node scripts/qa.mjs"), "says how to verify");
      return true;
    });
  }
});

test("a network file system is refused for the data directory and named as one, even where its type name is on no list", async () => {
  for (const type of ["nfs", "nfs4", "cifs", "smb3", "smbfs", "afpfs", "9p", "ceph", "glusterfs", "lustre", "fuse.sshfs", "fuse.rclone", "fuse", "macfuse"]) assert.equal(isNetworkType(type), true, type);
  for (const type of ["ext4", "xfs", "btrfs", "apfs", "ntfs", "tmpfs", "fuseblk", "nfsd"]) assert.equal(isNetworkType(type), false, type);
  for (const [platform, facts] of [["linux", { type: "nfs4", network: true }], ["darwin", { type: "apfs", network: true }], ["win32", { type: "ntfs", network: true }]] as const) {
    // A supported type name behind a network (a mapped NTFS share, an APFS-formatted network volume) is still refused.
    const [report] = await checkFilesystems(dataDir, { platform, detect: as(facts) });
    assert.equal(filesystemSupported(platform, facts), false);
    assert.equal(report!.supported, false, `${platform} ${facts.type}`);
    assert.ok(report!.problem!.found.includes("a network file system"), report!.problem!.found);
  }
});

test("workspaces are checked like the data directory, each root separately, and every problem is reported", async () => {
  const detect: FilesystemDetector = async (path) => (path.startsWith("/good") ? { type: "ext4", network: false } : path.startsWith("/net") ? { type: "nfs4", network: true } : { type: "tmpfs", network: false });
  const reports = await checkFilesystems([{ role: "data directory", path: "/good/data" }, { role: "workspace", path: "/good/ws" }, { role: "workspace", path: "/net/ws" }, { role: "workspace", path: "/tmp/ws" }], { platform: "linux", detect });
  assert.deepEqual(reports.map((r) => r.supported), [true, true, false, false]);
  assert.deepEqual(reports.flatMap((r) => (r.problem === undefined ? [] : [r.problem.item])), ["filesystem (workspace)", "filesystem (workspace)"]);
  assert.ok(reports[2]!.problem!.found.includes("/net/ws"));
});

test("a file system that cannot be found is refused, not guessed", async () => {
  const [report] = await checkFilesystems(dataDir, { platform: "linux", detect: async () => { throw new Error("no mount table"); } });
  assert.equal(report!.supported, false);
  assert.ok(report!.problem!.found.includes("unknown") && report!.problem!.found.includes("no mount table"));
});

test("case-insensitive and normalising file systems are supported and reported; the workspace bridge folds the names", async () => {
  const [report] = await checkFilesystems(dataDir, { platform: "darwin", detect: as({ type: "apfs", network: false, caseInsensitive: true, normalizing: true }) });
  assert.equal(report!.supported, true);
  assert.deepEqual([report!.facts!.caseInsensitive, report!.facts!.normalizing], [true, true]);
  // The bridge's own tests (packages/worker/src/workspace/workspace.test.ts: fold, collisions, "a collision is refused for another spelling of an existing file") cover the names; here the probe that finds the property is tried on this machine.
  const dir = mkdtempSync(join(tmpdir(), "nn-fsprobe-"));
  try {
    const naming = probeNaming(dir)!;
    assert.equal(typeof naming.caseInsensitive, "boolean");
    assert.deepEqual(readdirSync(dir), [], "the probe removes what it made");
    if (process.platform === "linux") assert.equal(naming.caseInsensitive, false, "ext4 and tmpfs on Linux are case sensitive by default");
    if (process.platform === "darwin") assert.equal(naming.caseInsensitive, true, "APFS as the GitHub runner formats it");
    if (process.platform === "win32") assert.equal(naming.caseInsensitive, true);
    assert.equal(probeNaming(join(dir, "missing")), undefined, "a directory that does not exist is not probed and nothing is created");
    assert.equal(existsSync(join(dir, "missing")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the Linux mount table is read by longest mount point, with escaped names and the newest mount winning a tie", () => {
  const table = [
    "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
    "30 22 0:25 / /srv rw,relatime shared:2 - xfs /dev/sdb1 rw",
    "31 30 0:30 / /srv/with\\040space rw - btrfs /dev/sdc rw",
    "32 30 0:31 / /srv/nfs rw - nfs4 server:/x rw,vers=4.2",
    "33 30 0:32 / /srv/fuse rw - fuse.sshfs me@host:/ rw",
    "34 30 0:33 / /srv/stack rw - ext4 /dev/a rw",
    "35 30 0:34 / /srv/stack rw - xfs /dev/b rw",
    "garbage line",
  ].join("\n");
  const at = (p: string): string | undefined => parseMountInfo(table, p)?.type;
  assert.equal(at("/home/me"), "ext4");
  assert.equal(at("/srv"), "xfs");
  assert.equal(at("/srv/data/x"), "xfs");
  assert.equal(at("/srv/with space/x"), "btrfs");
  assert.equal(at("/srv/nfs/deep"), "nfs4");
  assert.equal(at("/srv/fuse"), "fuse.sshfs");
  assert.equal(at("/srv/stack/a"), "xfs");
  assert.equal(at("/srv2"), "ext4", "/srv is not a prefix of /srv2");
  assert.equal(parseMountInfo("", "/x"), undefined);
});

test("the macOS mount table is read by longest mount point, and a mount without the local flag is a network mount", () => {
  const table = ["/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)", "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, protect)", "//me@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)", "server:/x on /Volumes/x (nfs, nodev)", "/dev/disk4s1 on /Volumes/Stick (msdos, local, nodev)"].join("\n");
  assert.deepEqual(parseMacMounts(table, "/System/Volumes/Data/Users/me"), { type: "apfs", mount: "/System/Volumes/Data", local: true });
  assert.deepEqual(parseMacMounts(table, "/Volumes/share/a"), { type: "smbfs", mount: "/Volumes/share", local: false });
  assert.equal(parseMacMounts(table, "/Volumes/x")?.local, false);
  assert.equal(parseMacMounts(table, "/Volumes/Stick")?.type, "msdos");
  assert.equal(parseMacMounts(table, "/etc")?.type, "apfs");
});

test("the real detector answers for this machine, for a directory that does not exist yet too, and creates nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-fsreal-"));
  try {
    const here = await detectFilesystem(dir);
    assert.ok(here.type.length > 0 && typeof here.network === "boolean", JSON.stringify(here));
    const below = join(dir, "not", "yet");
    const missing = await detectFilesystem(below);
    assert.equal(missing.type, here.type, "a missing directory lives on its parent's file system");
    assert.equal(missing.caseInsensitive, undefined, "no probe where nothing exists");
    assert.equal(existsSync(join(dir, "not")), false);
    assert.equal(nearestExisting(below), nearestExisting(dir));
    mkdirSync(join(dir, "x"));
    assert.deepEqual(readdirSync(dir), ["x"], "detection leaves no probe file behind");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the supported file systems are in the one list with the other supported environments", () => {
  assert.deepEqual(SUPPORTED_ENVIRONMENT.filesystems.map((f) => [f.platform, ...f.names]), [["linux", "ext4", "xfs", "btrfs"], ["darwin", "apfs"], ["win32", "ntfs"]]);
});

test("the refusal text for a file system names the exact switch once, together with other refusals", async () => {
  const [report] = await checkFilesystems(dataDir, { platform: "linux", detect: as({ type: "nfs4", network: true, where: "/srv" }) });
  const message = refusalMessage([report!.problem!, { item: "Node.js", found: "20.0.0", supported: "22.19.0 or newer", howToTest: "run it" }]);
  assert.equal(message.split(OVERRIDE_FLAG).length - 1, 1);
  assert.ok(message.includes("filesystem (data directory): found nfs4") && message.includes("Node.js: found 20.0.0"));
});

for (const backend of backends) {
  test(`${backend.name}: an overridden unsupported or network file system is recorded in the audit log, once per epoch, and an unoverridden one records nothing`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "c1", at: T });
      const reports = await checkFilesystems([...dataDir, { role: "workspace", path: "/srv/nn/ws" }], { platform: "linux", detect: async (p) => (p.includes("ws") ? { type: "tmpfs", network: false } : { type: "nfs4", network: true }) });
      const problems = reports.flatMap((r) => (r.problem === undefined ? [] : [r.problem]));
      assert.throws(() => decideStartup(problems, { allowUnsupported: false, host: "Host: linux x64" }), UnsupportedEnvironmentError);
      assert.deepEqual(await world.storage.listAudit({ afterSeq: 0, limit: 10 }), [], "a refused start writes nothing");
      const check = decideStartup(problems, { allowUnsupported: true, host: "Host: linux x64, distribution Example OS 1" });
      assert.equal(check.overridden, true);
      assert.ok(check.output[0]!.startsWith("WARNING") && check.output.some((l) => l.includes("filesystem (data directory): found nfs4")) && check.output.some((l) => l.includes("distribution Example OS 1")), "printed at start");
      assert.equal(await recordOverride(world.storage, epoch, check, T), true);
      assert.equal(await recordOverride(world.storage, epoch, check, T), true, "repeating is the same record");
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 10 });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.type, "environment.override");
      assert.deepEqual((audit[0]!.detail["problems"] as { item: string }[]).map((p) => p.item), ["filesystem (data directory)", "filesystem (workspace)"]);
      assert.equal(audit[0]!.detail["host"], "Host: linux x64, distribution Example OS 1");
    } finally { await world.close(); }
  });
}
