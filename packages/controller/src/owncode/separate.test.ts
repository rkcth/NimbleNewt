import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { SEPARATE_LIMITS, installationGuards, judgeSeparate, nodeSeparationFs, parseMountInfo, programRoot, type GuardedPlace, type MountEntry, type OwnPlace, type SeparationFs } from "./separate.js";

// Card B06, third slice: the NimbleNewt development project's own checkout must be apart from the running installation. These tests judge places against guarded folders on a real disk (symbolic links,
// missing folders, loops) and on a file system the test makes up (a bind mount, a file system without folder identity, a folder too deep, a failing disk). Nothing here touches the controller's records.

// The native realpath, as the judge's own: on Windows it gives the long name of a folder the temporary folder names by its short (8.3) name (`RUNNER~1`), so a path the test builds is spelled as the judge's.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-b06c-sep-")));
/** Windows takes `..` in a path by its spelling before it follows a link (`l\..\g` is the `g` beside `l`), as git for Windows does; on POSIX `..` leads up from where the link leads. */
const posixDots = process.platform !== "win32";
/** FIFOs and permission bits that stop a read are POSIX: Windows has no FIFO in its file system, and `chmod` there only sets the read-only flag, which does not stop a read. */
const posixFiles = process.platform !== "win32";
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (...parts: string[]): string => { const p = join(root, ...parts); mkdirSync(p, { recursive: true }); return p; };
const repo = (locator: string, label = "source", write = true): OwnPlace => ({ label, kind: "repository", locator, write });
/** A folder git takes as a git folder (a HEAD naming a branch, `objects` and `refs`), made at `path`; returns `path`. */
const gitFolder = (path: string): string => { mkdirSync(join(path, "objects"), { recursive: true }); mkdirSync(join(path, "refs"), { recursive: true }); writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n"); return path; };
const install = dir("srv", "nimblenewt");
const data = dir("var", "nimblenewt-data");
const guarded: GuardedPlace[] = [{ what: "the running installation's program files", path: install }, { what: "the controller's data directory", path: data }];
const refusedWith = async (places: readonly OwnPlace[] | "too-many", g: readonly GuardedPlace[], match: RegExp, o: Parameters<typeof judgeSeparate>[2] = {}): Promise<void> => {
  const got = await judgeSeparate(places, g, o);
  assert.equal(got.separate, false, `expected a refusal matching ${match}`);
  if (!got.separate) { assert.match(got.detail, match); assert.ok(got.detail.length <= 400); }
};

test("a checkout of its own beside the installation is separate; the same folder, one inside it and one above it are not", async () => {
  const own = dir("work", "nimblenewt-dev");
  assert.deepEqual(await judgeSeparate([repo(own)], guarded), { separate: true });
  // A sibling whose name starts with the installation's name is not inside it.
  assert.deepEqual(await judgeSeparate([repo(dir("srv", "nimblenewt-dev"))], guarded), { separate: true });
  await refusedWith([repo(install)], guarded, /is the same folder as the running installation's program files/);
  await refusedWith([repo(dir("srv", "nimblenewt", "packages", "controller"))], guarded, /is inside the running installation's program files/);
  await refusedWith([repo(join(root, "srv"))], guarded, /holds the running installation's program files/);
  await refusedWith([repo(join(root, "var"))], guarded, /holds the controller's data directory/);
  await refusedWith([repo(dir("var", "nimblenewt-data", "workspaces", "dev"))], guarded, /inside the controller's data directory/);
  // Spelled with a trailing separator and with "." segments: the same folder.
  await refusedWith([repo(`${install}/`)], guarded, /same folder/);
  await refusedWith([repo(`${install}/./packages/.`)], guarded, /inside/);
  // Every place is judged, not only the first: a separate checkout and an output folder inside the data directory are refused.
  await refusedWith([repo(own), { label: "reports", kind: "output", locator: dir("var", "nimblenewt-data", "out"), write: true }], guarded, /output "reports" .* inside the controller's data directory/);
});

test("symbolic links are followed: a link into the installation, a link to a folder above it and a link loop are refused", async () => {
  const links = dir("links");
  symlinkSync(join(install, "packages"), join(links, "into"));
  symlinkSync(join(root, "srv"), join(links, "up"));
  symlinkSync(join(links, "loop-b"), join(links, "loop-a"));
  symlinkSync(join(links, "loop-a"), join(links, "loop-b"));
  symlinkSync(dir("work", "elsewhere"), join(links, "fine"));
  await refusedWith([repo(join(links, "into"))], guarded, /inside the running installation's program files/);
  await refusedWith([repo(join(links, "up"))], guarded, /holds the running installation's program files/);
  await refusedWith([repo(join(links, "loop-a"))], guarded, /cannot be checked: it could not be read on the controller's machine \(ELOOP\)/);
  assert.deepEqual(await judgeSeparate([repo(join(links, "fine"))], guarded), { separate: true });
  // A guarded folder reached through a link is the folder itself.
  await refusedWith([repo(dir("work", "elsewhere", "x"))], [{ what: "the release folder the launcher reads", path: join(links, "fine") }], /inside the release folder the launcher reads/);
});

test("it fails closed: no checkout of its own, a checkout that is not on this machine or not there, and no guarded folders are all refused", async () => {
  const own = dir("work", "dev2");
  await refusedWith([], guarded, /no checkout of its own/);
  await refusedWith([repo(own, "source", false)], guarded, /no checkout of its own/, {});
  await refusedWith([{ label: "notes", kind: "document", locator: own, write: true }], guarded, /no checkout of its own/);
  await refusedWith([repo(own), repo("git@example.invalid:nn.git", "remote")], guarded, /repository "remote" is at git@example\.invalid:nn\.git, which is not a folder on the controller's machine/);
  await refusedWith([repo(join(root, "nowhere", "dev"))], guarded, /could not be read on the controller's machine \(ENOENT\)/);
  await refusedWith([repo(own)], [], /not told where the running installation is/);
  await refusedWith([repo(own)], [{ what: "the running installation's program files", path: "relative/install" }], /is not given as a full path/);
  await refusedWith("too-many", guarded, new RegExp(`more than ${SEPARATE_LIMITS.places} places`));
  await refusedWith(Array.from({ length: SEPARATE_LIMITS.places + 1 }, (_, i) => repo(own, `r${i}`)), guarded, /more than/);
  assert.deepEqual(await judgeSeparate(Array.from({ length: SEPARATE_LIMITS.places }, (_, i) => repo(own, `r${i}`)), guarded), { separate: true }, "exactly the limit is judged");
  await refusedWith([repo(own)], Array.from({ length: SEPARATE_LIMITS.guarded + 1 }, (_, i) => ({ what: `g${i}`, path: dir("g", String(i)) })), /not told where/);
  // A resource that is not a repository and not a local path (a service's address) is not a folder and is not judged.
  assert.deepEqual(await judgeSeparate([repo(own), { label: "site", kind: "service", locator: "https://example.invalid/", write: true }], guarded), { separate: true });
});

test("a guarded folder not made yet: a checkout that would hold it is refused, one elsewhere is separate", async () => {
  const own = dir("work", "dev3");
  const later: GuardedPlace[] = [{ what: "the release folder the launcher reads", path: join(own, "releases", "current") }];
  await refusedWith([repo(own)], later, /holds the release folder the launcher reads/);
  assert.deepEqual(await judgeSeparate([repo(own)], [{ what: "the release folder the launcher reads", path: join(root, "opt", "nn-releases") }]), { separate: true });
});

/** A made-up file system: paths map to identities; `realpath` is the identity map's own spelling. */
const fakeFs = (ids: Record<string, string>, o: { failStat?: string; code?: string; mounts?: readonly MountEntry[] | Error } = {}): SeparationFs => ({
  ...(o.mounts === undefined ? {} : { mounts: async () => { if (o.mounts instanceof Error) throw o.mounts; return o.mounts; } }),
  realpath: async (p) => { if (ids[p] === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return p; },
  stat: async (p) => {
    if (o.failStat === p) throw Object.assign(new Error("denied"), { code: o.code ?? "EACCES" });
    const id = ids[p];
    if (id === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    const [dev, ino] = id.split(":");
    return { dev: BigInt(dev!), ino: BigInt(ino!) };
  },
});
const tree = { "/": "1:2", "/srv": "1:10", "/srv/nn": "1:11", "/mnt": "1:20", "/mnt/live": "1:11", "/mnt/top": "1:10", "/work": "1:30", "/work/dev": "1:31", "/mnt/live/pkg": "1:12" };

test("a bind mount is the same folder: a checkout through a second mount of the installation, or of a folder above it, is refused", async () => {
  const g: GuardedPlace[] = [{ what: "the running installation's program files", path: "/srv/nn" }];
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g, { fs: fakeFs(tree), platform: "linux" }), { separate: true });
  await refusedWith([repo("/mnt/live")], g, /same folder as the running installation's program files/, { fs: fakeFs(tree), platform: "linux" });
  await refusedWith([repo("/mnt/live/pkg")], g, /inside the running installation's program files/, { fs: fakeFs(tree), platform: "linux" });
  await refusedWith([repo("/mnt/top")], g, /holds the running installation's program files/, { fs: fakeFs(tree), platform: "linux" });
});

test("what the disk cannot answer is refused: no folder identity, a folder too deep, a failing read of a guarded folder or a checkout", async () => {
  const g: GuardedPlace[] = [{ what: "the running installation's program files", path: "/srv/nn" }];
  await refusedWith([repo("/work/dev")], g, /gives no folder identity/, { fs: fakeFs({ ...tree, "/work/dev": "1:0" }), platform: "linux" });
  await refusedWith([repo("/work/dev")], g, /the running installation's program files \(\/srv\/nn\) cannot be checked: it could not be read \(EACCES\)/, { fs: fakeFs(tree, { failStat: "/srv" }), platform: "linux" });
  await refusedWith([repo("/work/dev")], g, /at \/work\/dev cannot be checked: it could not be read on the controller's machine \(EIO\)/, { fs: fakeFs(tree, { failStat: "/work", code: "EIO" }), platform: "linux" });
  const deep: Record<string, string> = { "/": "1:2" };
  let p = "";
  for (let i = 0; i < SEPARATE_LIMITS.depth + 2; i++) { p += `/d${i}`; deep[p] = `1:${100 + i}`; }
  await refusedWith([repo(p)], [{ what: "the running installation's program files", path: "/" + "x" }], new RegExp(`more than ${SEPARATE_LIMITS.depth} folders deep`), { fs: fakeFs({ ...deep, "/x": "1:3" }), platform: "linux" });
});

test("on a platform whose file systems fold case, a differently cased spelling of the installation is refused even when the disk gives no shared identity", async () => {
  const ids = { "/": "1:2", "/Srv": "1:10", "/Srv/NN": "1:11", "/srv": "1:40", "/srv/nn": "1:41", "/srv/nn/x": "1:42" };
  const g: GuardedPlace[] = [{ what: "the running installation's program files", path: "/Srv/NN" }];
  await refusedWith([repo("/srv/nn/x")], g, /inside the running installation's program files/, { fs: fakeFs(ids), platform: "darwin" });
  // Windows: the same, in Windows spelling (drive letters, either separator).
  // The checkout's way up is spelled with a lower-case drive letter (two spellings, two identities): drive letters fold too.
  const winIds = { "C:\\": "1:2", "C:\\Srv": "1:10", "C:\\Srv\\NN": "1:11", "c:\\": "1:3", "c:\\srv": "1:40", "c:\\srv\\nn": "1:41", "c:\\srv\\nn\\x": "1:42" };
  await refusedWith([repo("c:/srv/nn/x")], [{ what: "the running installation's program files", path: "C:\\Srv\\NN" }], /inside/, { fs: fakeFs(winIds), platform: "win32" });
  assert.deepEqual(await judgeSeparate([repo("/srv/nn/x")], g, { fs: fakeFs(ids), platform: "linux" }), { separate: true }, "Linux file systems keep case: two spellings with two identities are two folders");
});

test("the guarded folders come from what builds the controller; the program root is the source tree or release the controller runs from", () => {
  const here = programRoot();
  // This test runs from the built package, which lives in the source tree: the root is the folder whose package.json declares the workspaces, above packages/controller.
  assert.ok(resolve(here, "packages", "controller") === resolve(fileURLToPath(new URL("../../", import.meta.url))), `${here} holds this package`);
  // The guarded paths are taken as the controller opens them: resolved by the host's own rules (on Windows a path from the root is on the working directory's drive).
  assert.deepEqual(installationGuards({ programRoot: "/opt/nn/", dataDirectory: "/var/lib/nn" }), [{ what: "the running installation's program files", path: resolve("/opt/nn"), git: true }, { what: "the controller's data directory", path: resolve("/var/lib/nn") }]);
  const all = installationGuards({ programRoot: "/opt/nn", runtime: "/usr/bin", dataDirectory: "/d", databaseFile: "/e/c.sqlite", stateDirectory: "/s", releaseRoot: "/r", releaseIncoming: "/i", artifactDirectory: "/a", backupDirectory: "/b",
    backupKeyring: "/k/keyring.json", backupPasscode: "/k/passcode", backupRecovery: "/k/recovery", recoveryManifests: "/m", watchdogFile: "/w/watchdog.json", heartbeatFile: "/h/beat" });
  assert.deepEqual(all.map((g) => g.path), ["/opt/nn", "/usr/bin", "/d", "/e/c.sqlite", "/e/c.sqlite-wal", "/e/c.sqlite-shm", "/e/c.sqlite-journal", "/s", "/r", "/i", "/a", "/b", "/k/keyring.json", "/k/passcode", "/k/recovery", "/m", "/w/watchdog.json", "/h/beat"].map((x) => resolve(x)));
  assert.deepEqual(all.filter((g) => g.git === true).map((g) => g.path), [resolve("/opt/nn")], "only the program root's git folders are followed");
  // B06 fourth slice: the program root's git folders (at most its git folder and the common one) are added when judged, and still fit the limit.
  assert.ok(all.length + 2 <= SEPARATE_LIMITS.guarded, "every guard a controller can be given, with the program root's git folders, fits the limit");
  // First review of the fourth slice: with room to spare (a limit exactly full would refuse every judgement once one more guard is added), as the ASSUMPTION for 32 says.
  assert.ok(all.length + 2 + 8 <= SEPARATE_LIMITS.guarded, "the limit leaves room for more guards");
  // A package with no workspace root above it is its own root.
  const lone = dir("lone", "pkg", "dist", "owncode");
  assert.equal(programRoot(pathToFileURL(join(lone, "separate.js")).href), join(root, "lone", "pkg"));
});

// First review: the way up by path does not lead from a bind mount back to the folder it shows, so on Linux the mount table is read too.
const mt = (...rows: [string, string, string][]): MountEntry[] => rows.map(([dev, root, point]) => ({ dev, root, point }));
// One disk (8:1) mounted at /, a second (8:2) at /data; the made-up identities of a bind mount are those of the folder it shows (as the kernel gives them).
const bindTree = { "/": "1:2", "/srv": "1:10", "/srv/nn": "1:11", "/srv/nn/pkg": "1:12", "/work": "1:30", "/work/dev": "1:31", "/work/dev/nn": "1:11", "/mnt": "1:20", "/mnt/pkg": "1:12", "/data": "2:2", "/data/ws": "2:3", "/data/srv": "2:4", "/data/srv/nn": "2:5", "/app": "3:2" };
const g1: GuardedPlace[] = [{ what: "the running installation's program files", path: "/srv/nn" }];

test("a bind mount of a folder inside the installation, a checkout that holds a mount of it, and a mount inside the installation that shows a checkout are refused", async () => {
  const base: [string, string, string][] = [["8:1", "/", "/"], ["8:2", "/", "/data"]];
  const fs = (...more: [string, string, string][]): SeparationFs => fakeFs(bindTree, { mounts: mt(...base, ...more) });
  // Unrelated mounts: separate.
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fs(), platform: "linux" }), { separate: true });
  assert.deepEqual(await judgeSeparate([repo("/data/ws")], g1, { fs: fs(), platform: "linux" }), { separate: true });
  // The same path inside another disk is another folder.
  assert.deepEqual(await judgeSeparate([repo("/data/srv/nn")], g1, { fs: fs(), platform: "linux" }), { separate: true });
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fs(["8:2", "/srv/nn", "/work/dev/nn"]), platform: "linux" }), { separate: true }, "a mount of another disk's /srv/nn");
  // /mnt/pkg is a bind mount of /srv/nn/pkg: its way up (/mnt, /) never reaches /srv/nn, so only the mount table tells.
  await refusedWith([repo("/mnt/pkg")], g1, /inside the running installation's program files/, { fs: fs(["8:1", "/srv/nn/pkg", "/mnt/pkg"]), platform: "linux" });
  // Without the mount table the identities alone do not catch it (why the table is read).
  assert.deepEqual(await judgeSeparate([repo("/mnt/pkg")], g1, { fs: fakeFs(bindTree), platform: "linux" }), { separate: true });
  // /work/dev holds /work/dev/nn, a bind mount of the installation itself, or of a folder above it, or of one inside it.
  await refusedWith([repo("/work/dev")], g1, /holds a mount \(\/work\/dev\/nn\) of the running installation's program files/, { fs: fs(["8:1", "/srv/nn", "/work/dev/nn"]), platform: "linux" });
  await refusedWith([repo("/work/dev")], g1, /holds a mount/, { fs: fs(["8:1", "/srv", "/work/dev/nn"]), platform: "linux" });
  await refusedWith([repo("/work/dev")], g1, /holds a mount/, { fs: fs(["8:1", "/srv/nn/pkg", "/work/dev/nn"]), platform: "linux" });
  // The same disk mounted a second time, as a container is given its folders: /app shows /srv/nn and /data/ws shows /srv; neither way up meets the other.
  await refusedWith([repo("/data/ws")], [{ what: "the running installation's program files", path: "/app" }], /holds the running installation's program files/, { fs: fakeFs(bindTree, { mounts: mt(["8:1", "/", "/"], ["8:1", "/srv", "/data/ws"], ["8:1", "/srv/nn", "/app"]) }), platform: "linux" });
  // A mount inside the installation that shows the checkout.
  await refusedWith([repo("/data/ws")], g1, /is mounted inside the running installation's program files \(\/srv\/nn, at \/srv\/nn\/pkg\)/, { fs: fs(["8:2", "/ws", "/srv/nn/pkg"]), platform: "linux" });
  // The newest of two mounts at one point is the one seen.
  await refusedWith([repo("/mnt/pkg")], g1, /inside/, { fs: fs(["8:2", "/ws", "/mnt/pkg"], ["8:1", "/srv/nn/pkg", "/mnt/pkg"]), platform: "linux" });
  assert.deepEqual(await judgeSeparate([repo("/mnt/pkg")], g1, { fs: fs(["8:1", "/srv/nn/pkg", "/mnt/pkg"], ["8:2", "/ws", "/mnt/pkg"]), platform: "linux" }), { separate: true });
});

test("a mount table that cannot be read is refused; the table's own spelling is read as the kernel writes it", async () => {
  await refusedWith([repo("/work/dev")], g1, /mount table of the controller's machine could not be read \(denied\)/, { fs: fakeFs(bindTree, { mounts: new Error("denied") }), platform: "linux" });
  await refusedWith([repo("/work/dev")], g1, /cannot be checked: it is under no mount/, { fs: fakeFs(bindTree, { mounts: mt(["8:2", "/", "/data"]) }), platform: "linux" });
  assert.deepEqual(parseMountInfo("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n30 22 8:1 /srv/my\\040nn /mnt/a\\134b rw shared:1 - ext4 /dev/sda1 rw\n"), [{ id: "22", parent: "1", dev: "8:1", root: "/", point: "/" }, { id: "30", parent: "22", dev: "8:1", root: "/srv/my nn", point: "/mnt/a\\b" }]);
  assert.throws(() => parseMountInfo("22 1 x / / rw\n"), /could not be read/);
  assert.throws(() => parseMountInfo("22 1 8:1 / / rw\n22 1 8:1 / /x rw\n"), /could not be read/, "a mount ID given twice");
  assert.throws(() => parseMountInfo("a 1 8:1 / / rw\n"), /could not be read/);
  assert.throws(() => parseMountInfo("22 x 8:1 / / rw\n"), /could not be read/, "a parent ID that is not a number");
  assert.throws(() => parseMountInfo(""), /empty/);
  if (process.platform === "linux") {
    const real = await nodeSeparationFs.mounts!();
    assert.ok(real !== undefined && real.some((m) => m.point === "/"), "this machine's mount table is read");
  }
});

test("a folder whose name starts with two dots is inside the folder that holds it", async () => {
  const ids = { "/": "1:2", "/Srv": "1:10", "/Srv/NN": "1:11", "/srv": "1:40", "/srv/nn": "1:41", "/srv/nn/..x": "1:42" };
  await refusedWith([repo("/srv/nn/..x")], [{ what: "the running installation's program files", path: "/Srv/NN" }], /inside/, { fs: fakeFs(ids), platform: "darwin" });
  await refusedWith([repo(dir("srv", "nimblenewt", "..dots"))], guarded, /inside the running installation's program files/);
});

test("a repository's git folder is one of its places: a worktree or a .git link into the installation is refused", async () => {
  // The installation is itself a git checkout, with a worktree's folder under its .git.
  const wtGit = dir("srv", "nimblenewt", ".git", "worktrees", "dev");
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  const wt = dir("work", "wt-dev");
  writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
  await refusedWith([repo(wt)], guarded, /the git folder of the development project's repository "source" .* is inside the running installation's program files/);
  // Its own git folder elsewhere, with the common folder named relatively: refused only when that is in the installation.
  const ownGit = dir("work", "git-store", "worktrees", "dev");
  writeFileSync(join(ownGit, "commondir"), "../..\n");
  const wt2 = dir("work", "wt-own");
  writeFileSync(join(wt2, ".git"), "gitdir: ../git-store/worktrees/dev\n");
  assert.deepEqual(await judgeSeparate([repo(wt2)], guarded), { separate: true });
  // A git folder of its own whose common folder is the installation's: refused through the common folder.
  const halfGit = dir("work", "git-half", "worktrees", "dev");
  writeFileSync(join(halfGit, "commondir"), `${join(install, ".git")}\n`);
  const wt3 = dir("work", "wt-half");
  writeFileSync(join(wt3, ".git"), `gitdir: ${halfGit}\n`);
  await refusedWith([repo(wt3)], guarded, /git folder .*\.git\) is inside the running installation's program files/);
  // A git folder with no common folder (a submodule's): judged alone.
  const subGit = dir("work", "git-sub");
  const wt4 = dir("work", "wt-sub");
  writeFileSync(join(wt4, ".git"), "gitdir: ../git-sub\n");
  assert.deepEqual(await judgeSeparate([repo(wt4)], guarded), { separate: true }, subGit);
  // A .git link to the installation's own git folder.
  const linked = dir("work", "linked");
  symlinkSync(join(install, ".git"), join(linked, ".git"));
  await refusedWith([repo(linked)], guarded, /git folder .* inside the running installation's program files/);
  // An ordinary .git folder: separate.
  const plain = dir("work", "plain");
  dir("work", "plain", ".git");
  assert.deepEqual(await judgeSeparate([repo(plain)], guarded), { separate: true });
  // A .git file that names nothing, or a git folder that is not there: cannot tell.
  const odd = dir("work", "odd");
  writeFileSync(join(odd, ".git"), "not a pointer\n");
  await refusedWith([repo(odd)], guarded, /does not name a git folder/);
  const gone = dir("work", "gone");
  writeFileSync(join(gone, ".git"), `gitdir: ${join(root, "nowhere", "g")}\n`);
  await refusedWith([repo(gone)], guarded, /git folder .* cannot be checked: .*ENOENT/);
  // Only repositories have git folders: an output folder with a .git file is judged as a folder.
  assert.deepEqual(await judgeSeparate([repo(plain), { label: "out", kind: "output", locator: wt, write: true }], guarded), { separate: true });
});

// Second review: which mount is seen comes from the table's mount IDs, not its order; mounts held on both sides; git paths as the disk takes them; a .git that is not a plain file.
const mi = (...lines: string[]): MountEntry[] => parseMountInfo(lines.map((l) => `${l} rw - ext4 x rw`).join("\n"));
test("the mount seen is found by the table's mount IDs: a later mount above an earlier one hides it, whatever the table's order", async () => {
  // /mnt/pkg is a bind mount of /srv/nn/pkg (8:1), listed after /mnt, a mount of another disk made later and so on top: /mnt/pkg is then 8:2's /pkg, which is apart.
  const hidden = mi("1 0 8:1 / /", "3 1 8:1 /srv/nn/pkg /mnt/pkg", "4 1 8:2 / /mnt");
  assert.deepEqual(await judgeSeparate([repo("/mnt/pkg")], g1, { fs: fakeFs(bindTree, { mounts: hidden }), platform: "linux" }), { separate: true });
  // The other way round (/mnt/pkg made on top of /mnt): the bind mount is seen, even listed first.
  await refusedWith([repo("/mnt/pkg")], g1, /inside the running installation's program files/, { fs: fakeFs(bindTree, { mounts: mi("3 4 8:1 /srv/nn/pkg /mnt/pkg", "1 0 8:1 / /", "4 1 8:2 / /mnt") }), platform: "linux" });
  // Two at one folder: the one mounted on the other is on top, whatever the order.
  await refusedWith([repo("/mnt/pkg")], g1, /inside/, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "6 5 8:1 /srv/nn/pkg /mnt/pkg", "5 1 8:2 /ws /mnt/pkg") }), platform: "linux" });
  assert.deepEqual(await judgeSeparate([repo("/mnt/pkg")], g1, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "6 5 8:2 /ws /mnt/pkg", "5 1 8:1 /srv/nn/pkg /mnt/pkg") }), platform: "linux" }), { separate: true });
  // A table that does not say which is on top (two at one folder, mounted on the same mount) cannot tell.
  await refusedWith([repo("/mnt/pkg")], g1, /cannot be checked: the mount table does not say which/, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "5 1 8:2 /ws /mnt/pkg", "6 1 8:1 /srv/nn/pkg /mnt/pkg") }), platform: "linux" });
});

test("a mount inside the checkout and a mount inside the installation that show one folder are refused", async () => {
  const ids = { ...bindTree, "/work/dev/nm": "4:1", "/srv/nn/nm": "4:1", "/work/dev/other": "4:9" };
  // One volume (8:3's /vol) at /srv/nn/nm and at /work/dev/nm.
  await refusedWith([repo("/work/dev")], g1, /holds a mount \(\/work\/dev\/nm\) that shows what the running installation's program files .* holds at \/srv\/nn\/nm/, { fs: fakeFs(ids, { mounts: mi("1 0 8:1 / /", "7 1 8:3 /vol /srv/nn/nm", "8 1 8:3 /vol/sub /work/dev/nm") }), platform: "linux" });
  // Another folder of that volume: separate.
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fakeFs(ids, { mounts: mi("1 0 8:1 / /", "7 1 8:3 /vol /srv/nn/nm", "8 1 8:3 /other /work/dev/other") }), platform: "linux" }), { separate: true });
});

test("git's paths are taken as the disk takes them, a long .git file or a .git that is no plain file is refused, and a .git folder's commondir is followed", async () => {
  // gitdir "l/../g", with l a link into the installation's .git/worktrees: the disk leads to the installation's .git/worktrees/g, not to the checkout's own g.
  dir("srv", "nimblenewt", ".git", "worktrees", "g");
  const wt = dir("work", "dots");
  dir("work", "dots", "g");
  symlinkSync(join(install, ".git", "worktrees", "x"), join(wt, "l"));
  dir("srv", "nimblenewt", ".git", "worktrees", "x");
  writeFileSync(join(wt, ".git"), "gitdir: l/../g\n");
  if (posixDots) await refusedWith([repo(wt)], guarded, /git folder .* is inside the running installation's program files/);
  // A .git file longer than the limit is not judged by its start.
  const long = dir("work", "long");
  writeFileSync(join(long, ".git"), `gitdir: ${join(long, "own")}\n${"#".repeat(SEPARATE_LIMITS.gitFileBytes)}`);
  dir("work", "long", "own");
  await refusedWith([repo(long)], guarded, /its \.git file is longer than 4096 bytes/);
  // So is a commondir longer than the limit (third review).
  const longCommon = dir("work", "long-common");
  dir("work", "long-common", "g");
  writeFileSync(join(longCommon, ".git"), "gitdir: g\n");
  writeFileSync(join(longCommon, "g", "commondir"), `${join(longCommon, "g")}\n${"#".repeat(SEPARATE_LIMITS.gitFileBytes)}`);
  await refusedWith([repo(longCommon)], guarded, /its git folder's commondir is longer than 4096 bytes/);
  // A .git folder of its own that names the installation's as its common folder.
  const half = dir("work", "half-dir");
  dir("work", "half-dir", ".git");
  writeFileSync(join(half, ".git", "commondir"), `${join(install, ".git")}\n`);
  await refusedWith([repo(half)], guarded, /git folder .*\.git\) is inside the running installation's program files/);
  // A git folder reached through a link, whose commondir is relative: ".." is taken from where the link leads (the installation's .git), not from the link's own folder (a separate folder of that name).
  dir("srv", "side", "a");
  dir("nimblenewt", ".git");
  symlinkSync(join(root, "srv", "side", "a"), join(dir("work"), "lnk"));
  writeFileSync(join(root, "srv", "side", "a", "commondir"), `..${sep}..${sep}nimblenewt${sep}.git\n`);
  const viaLink = dir("work", "via-link");
  writeFileSync(join(viaLink, ".git"), `gitdir: ${join(root, "work", "lnk")}\n`);
  if (posixDots) await refusedWith([repo(viaLink)], guarded, /git folder .*nimblenewt.\.git\) is inside the running installation's program files/);
  // gitdir "l/../own" with l a link to a folder apart: the git folder is that folder's sibling own, and its commondir (the installation's .git) is read there, not in the checkout's own "own".
  writeFileSync(join(dir("srv", "side", "own"), "commondir"), `${join(install, ".git")}\n`);
  dir("srv", "side", "b");
  const dots2 = dir("work", "dots2");
  dir("work", "dots2", "own");
  symlinkSync(join(root, "srv", "side", "b"), join(dots2, "l"));
  writeFileSync(join(dots2, ".git"), "gitdir: l/../own\n");
  if (posixDots) await refusedWith([repo(dots2)], guarded, /git folder .*\.git\) is inside the running installation's program files/);
  if (posixFiles) {
    // A FIFO named .git is not waited on.
    const { execFileSync } = await import("node:child_process");
    const fifo = dir("work", "fifo");
    execFileSync("mkfifo", [join(fifo, ".git")]);
    await refusedWith([repo(fifo)], guarded, /its \.git could not be read \(ENOTFILE\)/);
  }
});

test("more mounts held on both sides than it compares is refused", async () => {
  const n = 1001;
  const lines = ["1 0 8:1 / /"];
  for (let i = 0; i < n; i++) lines.push(`${10 + i} 1 8:4 /a${i} /srv/nn/m${i}`, `${5000 + i} 1 8:5 /b${i} /work/dev/m${i}`);
  await refusedWith([repo("/work/dev")], g1, /hold too many mounts to compare/, { fs: fakeFs(bindTree, { mounts: mi(...lines) }), platform: "linux" });
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fakeFs(bindTree, { mounts: mi(...lines.slice(0, 1 + 2 * 999)) }), platform: "linux" }), { separate: true });
});

// Third review: mounts the walk from the roots does not reach, two roots on one way, and the pair limit for the whole judgement.
test("a mount whose parents go round in a circle, or a second root on the way, cannot tell", async () => {
  // A bind mount of /srv/nn at /work/dev whose parent IDs form a circle with /work's: not ignored.
  await refusedWith([repo("/work/dev")], g1, /cannot be checked: the mount table has mounts whose parents go round in a circle/, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "5 6 8:1 /srv/nn /work/dev", "6 5 8:2 / /work") }), platform: "linux" });
  // A circle elsewhere (not on the way) does not matter.
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "5 6 8:2 / /elsewhere", "6 5 8:3 / /elsewhere/x") }), platform: "linux" }), { separate: true });
  // A bind mount of /srv/nn at /work/dev whose parent is not listed, beside the root /: which is on top is not known.
  await refusedWith([repo("/work/dev")], g1, /cannot be checked: the mount table does not say which of two mounts whose parents it does not list/, { fs: fakeFs(bindTree, { mounts: mi("1 0 8:1 / /", "2 99 8:1 /srv/nn /work/dev") }), platform: "linux" });
  // A mount whose parent is not listed and whose folder is not on the way does not matter; a root that is its own parent is a root.
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g1, { fs: fakeFs(bindTree, { mounts: mi("1 1 8:1 / /", "2 99 8:2 / /elsewhere") }), platform: "linux" }), { separate: true });
});

test("the limit on mounts compared is for the whole judgement", async () => {
  // 999 mounts in the checkout, 999 in each of two guarded folders: each pair alone is under the limit, both together are over it.
  const lines = ["1 0 8:1 / /"];
  for (let i = 0; i < 999; i++) lines.push(`${10 + i} 1 8:4 /a${i} /srv/nn/m${i}`, `${5000 + i} 1 8:5 /b${i} /work/dev/m${i}`, `${9000 + i} 1 8:6 /c${i} /srv/other/m${i}`);
  const two = [...g1, { what: "the controller's data directory", path: "/srv/other" }];
  await refusedWith([repo("/work/dev")], two, /hold too many mounts to compare/, { fs: fakeFs({ ...bindTree, "/srv/other": "9:9" }, { mounts: mi(...lines) }), platform: "linux" });
});

// B06 fourth slice: when the installation itself runs from a checkout or a `git worktree`, its git folders are guarded too, followed as a place's are. Another worktree of the same repository writes the
// same refs, hooks and configuration (the common git folder), so it is not separate.
test("the installation's own git folders are guarded: another worktree of its repository is refused, an unrelated repository and a release without .git are not", async () => {
  const base = dir("b06d");
  const mk = (...p: string[]): string => { const f = join(base, ...p); mkdirSync(f, { recursive: true }); return f; };
  // The main checkout (with its .git folder) and two worktrees: the installation and another.
  const main = mk("repos", "nimblenewt");
  const instGit = mk("repos", "nimblenewt", ".git", "worktrees", "inst");
  writeFileSync(join(instGit, "commondir"), "../..\n");
  const otherGit = mk("repos", "nimblenewt", ".git", "worktrees", "other");
  writeFileSync(join(otherGit, "commondir"), "../..\n");
  const inst = mk("ai", "worktrees", "inst");
  writeFileSync(join(inst, ".git"), `gitdir: ${instGit}\n`);
  const other = mk("work", "other");
  writeFileSync(join(other, ".git"), `gitdir: ${otherGit}\n`);
  const g = installationGuards({ programRoot: inst });
  await refusedWith([repo(other)], g, /the git folder of the development project's repository "source" .* is inside the git folder of the running installation's program files/);
  // Without following the installation's .git this was judged separate (the gap the fourth slice closes).
  assert.deepEqual(await judgeSeparate([repo(other)], g.map((x) => ({ what: x.what, path: x.path }))), { separate: true });
  // The main checkout holds the common git folder.
  await refusedWith([repo(main)], g, /holds the git folder of the running installation's program files/);
  // A checkout inside the common git folder (or the installation's own worktree folder there) is inside it.
  await refusedWith([repo(mk("repos", "nimblenewt", ".git", "hooks"))], g, /inside the git folder of the running installation's program files/);
  // An unrelated repository, and a plain folder: separate.
  const unrelated = mk("work", "unrelated");
  mk("work", "unrelated", ".git", "refs");
  assert.deepEqual(await judgeSeparate([repo(unrelated), repo(mk("work", "plain"))], g), { separate: true });
  // A worktree of an unrelated repository, its common folder elsewhere: separate.
  const elseGit = mk("repos", "else", ".git", "worktrees", "w");
  writeFileSync(join(elseGit, "commondir"), "../..\n");
  const elseWt = mk("work", "else-wt");
  writeFileSync(join(elseWt, ".git"), `gitdir: ${elseGit}\n`);
  assert.deepEqual(await judgeSeparate([repo(elseWt)], g), { separate: true });
  // A release install with no .git: nothing more is guarded, and the same worktree is separate from it.
  const release = mk("opt", "nimblenewt", "releases", "1.2.3");
  assert.deepEqual(await judgeSeparate([repo(other), repo(main)], installationGuards({ programRoot: release })), { separate: true });
  // An installation that is the main checkout (a .git folder): its common folder is inside it already, and a worktree of it is refused through its commondir.
  await refusedWith([repo(other)], installationGuards({ programRoot: main }), /git folder .* inside the running installation's program files/);
});

test("the installation's git folders are followed as written and fail closed when they cannot be read", async () => {
  const base = dir("b06d-fc");
  const mk = (...p: string[]): string => { const f = join(base, ...p); mkdirSync(f, { recursive: true }); return f; };
  const commonGit = mk("repos", "nn", ".git");
  const instGit = mk("repos", "nn", ".git", "worktrees", "inst");
  writeFileSync(join(instGit, "commondir"), "../..\n");
  const otherGit = mk("repos", "nn", ".git", "worktrees", "other");
  writeFileSync(join(otherGit, "commondir"), "../..\n");
  const other = mk("work", "other");
  writeFileSync(join(other, ".git"), `gitdir: ${otherGit}\n`);
  const install = (body: string | undefined): string => {
    const at = mk("inst", String(Math.random()).slice(2));
    if (body !== undefined) writeFileSync(join(at, ".git"), body);
    return at;
  };
  // A .git file that names nothing, a git folder that is not there: cannot tell, even for a checkout far away.
  const far = mk("far", "away");
  await refusedWith([repo(far)], installationGuards({ programRoot: install("not a pointer\n") }), /program files \(.*\) cannot be checked: its \.git file does not name a git folder/);
  await refusedWith([repo(far)], installationGuards({ programRoot: install(`gitdir: ${join(base, "nowhere")}\n`) }), /git folder of the running installation's program files \(.*nowhere\) cannot be checked: it could not be read/);
  // A .git longer than the limit, a FIFO, and (not as root) a .git or commondir that cannot be read: cannot tell.
  await refusedWith([repo(far)], installationGuards({ programRoot: install(`gitdir: ${instGit}\n${"#".repeat(SEPARATE_LIMITS.gitFileBytes)}`) }), /longer than/);
  if (posixFiles) {
    const fifo = install(undefined);
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(fifo, ".git")]);
    await refusedWith([repo(far)], installationGuards({ programRoot: fifo }), /its \.git could not be read \(ENOTFILE\)/);
  }
  if (posixFiles && process.getuid?.() !== 0) {
    const shut = install(`gitdir: ${instGit}\n`);
    chmodSync(join(shut, ".git"), 0);
    try { await refusedWith([repo(far)], installationGuards({ programRoot: shut }), /its \.git could not be read \(EACCES\)/); } finally { chmodSync(join(shut, ".git"), 0o644); }
    const shutGit = mk("repos", "shut", ".git", "worktrees", "i");
    writeFileSync(join(shutGit, "commondir"), "../..\n");
    chmodSync(join(shutGit, "commondir"), 0);
    try { await refusedWith([repo(far)], installationGuards({ programRoot: install(`gitdir: ${shutGit}\n`) }), /commondir could not be read \(EACCES\)/); } finally { chmodSync(join(shutGit, "commondir"), 0o644); }
  }
  // A relative gitdir through a link: `l/../inst` leads where the link leads (the common folder's worktrees), not to a folder of the installation's named `inst`.
  const viaLink = install("gitdir: l/../inst\n");
  symlinkSync(join(commonGit, "worktrees", "other"), join(viaLink, "l"));
  mkdirSync(join(viaLink, "inst"));
  if (posixDots) await refusedWith([repo(other)], installationGuards({ programRoot: viaLink }), /inside the git folder of the running installation's program files/);
  // A .git link to the common folder: followed.
  const linked = install(undefined);
  symlinkSync(commonGit, join(linked, ".git"));
  await refusedWith([repo(other)], installationGuards({ programRoot: linked }), /inside the git folder of the running installation's program files/);
  // A port without `readText` (tests showing identities only) follows nothing, as for places.
  assert.deepEqual(await judgeSeparate([repo(other)], installationGuards({ programRoot: install(`gitdir: ${instGit}\n`) }), { fs: { realpath: nodeSeparationFs.realpath, stat: nodeSeparationFs.stat } }), { separate: true });
});

// First review of the fourth slice: like git, the nearest `.git` at a folder or above it is the one git uses there, for the installation and for a place.
test("the nearest .git above a folder is followed, as git finds it, for the installation and for a place", async () => {
  const base = dir("b06d-up");
  const mk = (...p: string[]): string => { const f = join(base, ...p); mkdirSync(f, { recursive: true }); return f; };
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The installation a worktree of `nn`; a folder with no .git of its own inside nn's main checkout: git there writes to the common folder and works on the main checkout.
  const main = mk("repos", "nn");
  gitFolder(join(main, ".git"));
  const instGit = mk("repos", "nn", ".git", "worktrees", "inst");
  writeFileSync(join(instGit, "commondir"), "../..\n");
  const inst = mk("ai", "inst");
  writeFileSync(join(inst, ".git"), `gitdir: ${instGit}\n`);
  const sub = mk("repos", "nn", "docs");
  await refusedWith([repo(sub)], installationGuards({ programRoot: inst }), new RegExp(`the work tree git uses for the development project's repository "source" \\(${esc(main)}\\) holds the git folder of the running installation's program files`));
  // A folder with no .git inside an unrelated checkout: still separate.
  gitFolder(mk("work", "else", ".git"));
  assert.deepEqual(await judgeSeparate([repo(mk("work", "else", "part"))], installationGuards({ programRoot: inst })), { separate: true });
  // An installation whose .git is above its program root (a workspace inside a larger repository): that repository's git folder is guarded, so a worktree of it is refused.
  const outerGit = mk("outer", ".git", "worktrees", "w");
  writeFileSync(join(outerGit, "commondir"), "../..\n");
  const nested = mk("outer", "tools", "nn");
  const wt = mk("work", "outer-wt");
  writeFileSync(join(wt, ".git"), `gitdir: ${outerGit}\n`);
  await refusedWith([repo(wt)], installationGuards({ programRoot: nested }), /the git folder of the development project's repository "source" .* is inside the git folder of the running installation's program files/);
  // A release with no .git inside a checkout (a home folder kept in git): a plain folder elsewhere in that checkout is worked on through it, and that checkout holds the installation.
  gitFolder(mk("home", ".git"));
  const rel = mk("home", "opt", "nn", "releases", "1");
  await refusedWith([repo(mk("home", "dev", "plain"))], installationGuards({ programRoot: rel }), new RegExp(`the work tree git uses for .* \\(${esc(join(base, "home"))}\\) holds the running installation's program files`));
  // A checkout with a .git of its own there is worked on through its own git folder: separate.
  gitFolder(mk("home", "dev", "own", ".git"));
  assert.deepEqual(await judgeSeparate([repo(join(base, "home", "dev", "own"))], installationGuards({ programRoot: rel })), { separate: true });
  // Second review: git passes over a `.git` folder it does not take as a git folder (here an empty one, one whose HEAD names no ref, one without `refs`, and one whose HEAD is a link) and goes on
  // up to the home folder's repository, whose work tree holds the installation; so the check goes on up too. A real git folder there still stops the walk (above).
  for (const [name, make] of [["empty", () => {}], ["bad-head", (g: string) => { gitFolder(g); writeFileSync(join(g, "HEAD"), "not a ref\n"); }], ["head-outside-refs", (g: string) => { gitFolder(g); writeFileSync(join(g, "HEAD"), "ref: heads/main\n"); }], ["no-refs", (g: string) => { gitFolder(g); rmSync(join(g, "refs"), { recursive: true }); }], ["no-objects", (g: string) => { gitFolder(g); rmSync(join(g, "objects"), { recursive: true }); }], ["objects-file", (g: string) => { gitFolder(g); rmSync(join(g, "objects"), { recursive: true }); writeFileSync(join(g, "objects"), ""); }], ["link-head", (g: string) => { gitFolder(g); rmSync(join(g, "HEAD")); writeFileSync(join(g, "head-file"), "ref: refs/heads/main\n"); symlinkSync(join(g, "head-file"), join(g, "HEAD")); }]] as const) {
    const g = mk("home", "dev", name, ".git");
    make(g);
    await refusedWith([repo(join(base, "home", "dev", name))], installationGuards({ programRoot: rel }), new RegExp(`the work tree git uses for .* \\(${esc(join(base, "home"))}\\) holds the running installation's program files`));
  }
  // An object ID as HEAD (a detached checkout) is a git folder too: separate.
  const detached = gitFolder(mk("home", "dev", "detached", ".git"));
  writeFileSync(join(detached, "HEAD"), `${"a".repeat(40)}\n`);
  assert.deepEqual(await judgeSeparate([repo(join(base, "home", "dev", "detached"))], installationGuards({ programRoot: rel })), { separate: true });
  // A `.git` file (a worktree of an unrelated repository) is where git stops, as is a `.git` link to such a worktree's git folder, whose objects and refs are in its common folder: separate.
  const elseGit = mk("repos", "else2", ".git", "worktrees", "w");
  gitFolder(join(base, "repos", "else2", ".git"));
  writeFileSync(join(elseGit, "commondir"), "../..\n");
  writeFileSync(join(elseGit, "HEAD"), "ref: refs/heads/w\n");
  const homeWt = mk("home", "dev", "wt");
  writeFileSync(join(homeWt, ".git"), `gitdir: ${elseGit}\n`);
  const homeLinked = mk("home", "dev", "linked");
  symlinkSync(elseGit, join(homeLinked, ".git"));
  assert.deepEqual(await judgeSeparate([repo(homeWt), repo(homeLinked)], installationGuards({ programRoot: rel })), { separate: true });
  // A `.git` passed over is still one of the place's folders: a link into the installation that git does not take as a git folder is refused, with no repository above it.
  const into = mk("work", "into");
  symlinkSync(mk("home", "opt", "nn", "releases", "1", "sub"), join(into, ".git"));
  await refusedWith([repo(into)], installationGuards({ programRoot: rel }), /the git folder of the development project's repository "source" .* is inside the running installation's program files/);
  // The same inside an unrelated repository: the work tree found above is apart, but the `.git` passed over leads into the installation.
  gitFolder(mk("work", "outer2", ".git"));
  const inner = mk("work", "outer2", "inner");
  symlinkSync(mk("home", "opt", "nn", "releases", "1", "sub2"), join(inner, ".git"));
  await refusedWith([repo(inner)], installationGuards({ programRoot: rel }), /the git folder of the development project's repository "source" .* is inside the running installation's program files/);
  // A `.git` file whose git folder git does not take (no HEAD): git stops there with an error, so it works on no folder above; the walk stops too.
  const badWtGit = mk("repos", "else3", "worktrees", "w");
  const homeBadWt = mk("home", "dev", "bad-wt");
  writeFileSync(join(homeBadWt, ".git"), `gitdir: ${badWtGit}\n`);
  assert.deepEqual(await judgeSeparate([repo(homeBadWt)], installationGuards({ programRoot: rel })), { separate: true });
  // An `objects` that is not a folder (a FIFO) is not a git folder either.
  if (posixFiles) {
    const fifoObjects = mk("home", "dev", "objects-fifo", ".git");
    gitFolder(fifoObjects);
    rmSync(join(fifoObjects, "objects"), { recursive: true });
    (await import("node:child_process")).execFileSync("mkfifo", [join(fifoObjects, "objects")]);
    await refusedWith([repo(join(base, "home", "dev", "objects-fifo"))], installationGuards({ programRoot: rel }), new RegExp(`the work tree git uses for .* \\(${esc(join(base, "home"))}\\) holds the running installation's program files`));
  }
  // For the installation too: an empty `.git` at its program root is passed over, and the repository above it is guarded (a worktree of that repository is refused).
  const upGit = mk("up", ".git", "worktrees", "w");
  gitFolder(join(base, "up", ".git"));
  writeFileSync(join(upGit, "commondir"), "../..\n");
  const upInst = mk("up", "tools", "nn");
  mk("up", "tools", "nn", ".git");
  const upWt = mk("work", "up-wt");
  writeFileSync(join(upWt, ".git"), `gitdir: ${upGit}\n`);
  await refusedWith([repo(upWt)], installationGuards({ programRoot: upInst }), /the git folder of the development project's repository "source" .* is inside the git folder of the running installation's program files/);
  // A broken installation git tells the owner that it is the installation's git that blocks every checkout.
  const broken = mk("broken");
  writeFileSync(join(broken, ".git"), `gitdir: ${join(base, "nowhere")}\n`);
  await refusedWith([repo(mk("far"))], installationGuards({ programRoot: broken }), /cannot be checked: it could not be read \(ENOENT\); no checkout can be confirmed separate until the installation's git can be read/);
  const named = mk("named");
  writeFileSync(join(named, ".git"), "nothing\n");
  await refusedWith([repo(mk("far"))], installationGuards({ programRoot: named }), /does not name a git folder; no checkout can be confirmed separate until the installation's git can be read/);
});

test("the guard limit counts the installation's git folders, and every guard a controller can be given fits it", async () => {
  const base = dir("b06d-lim");
  const commonGit = join(base, "repo", ".git"); mkdirSync(join(commonGit, "worktrees", "i"), { recursive: true });
  writeFileSync(join(commonGit, "worktrees", "i", "commondir"), "../..\n");
  const inst = join(base, "inst"); mkdirSync(inst);
  writeFileSync(join(inst, ".git"), `gitdir: ${join(commonGit, "worktrees", "i")}\n`);
  const own = join(base, "own"); mkdirSync(own);
  const filler = (n: number): GuardedPlace[] => Array.from({ length: n }, (_, i) => ({ what: `g${i}`, path: join(base, "g", String(i)) }));
  const ig = installationGuards({ programRoot: inst });
  // The program root and its two git folders: exactly the limit is judged, one past it is not.
  assert.deepEqual(await judgeSeparate([repo(own)], [...ig, ...filler(SEPARATE_LIMITS.guarded - 3)]), { separate: true });
  await refusedWith([repo(own)], [...ig, ...filler(SEPARATE_LIMITS.guarded - 2)], /more guarded folders than it checks/);
  // Every option a controller can be given, with real folders and the installation a worktree: within the limit and separate from a checkout of its own.
  const p = (n: string): string => join(base, "all", n);
  for (const n of ["bin", "d", "e", "s", "r", "i", "a", "b", "k", "m", "w", "h"]) mkdirSync(p(n), { recursive: true });
  const all = installationGuards({ programRoot: inst, runtime: p("bin"), dataDirectory: p("d"), databaseFile: p("e/c.sqlite"), stateDirectory: p("s"), releaseRoot: p("r"), releaseIncoming: p("i"), artifactDirectory: p("a"), backupDirectory: p("b"),
    backupKeyring: p("k/keyring"), backupPasscode: p("k/pass"), backupRecovery: p("k/rec"), recoveryManifests: p("m"), watchdogFile: p("w/wd.json"), heartbeatFile: p("h/beat") });
  assert.deepEqual(await judgeSeparate([repo(own)], all), { separate: true });
  await refusedWith([repo(join(base, "all"))], all, /holds the Node\.js runtime/);
  await refusedWith([repo(join(base, "all", "k"))], all, /holds the backup encryption's keyring file/);
  await refusedWith([repo(join(base, "all", "h"))], all, /holds the launcher's heartbeat file/);
});

// Windows (simulated: this runs on every host). The judge takes Windows path rules when it judges for win32, so a made-up Windows disk shows what a real one gives the controller there: drive letters,
// either separator, case kept on disk but not significant, UNC shares, short (8.3) names and junctions that the native realpath resolves to the long folder, `..` taken by its spelling before any link
// (as Windows does), no mount table, a `.git` file written with forward slashes and CRLF, and a file system that gives no file ID (inode 0, as some network shares and FAT drives may). Only a real Windows
// run shows the real disk; the CI's windows-latest jobs run the real-disk tests above on NTFS.
const ENOENT = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
const winFs = (ids: Record<string, string>, o: { readonly real?: Record<string, string>; readonly files?: Record<string, string>; readonly failStat?: string } = {}): SeparationFs => {
  const low = (p: string): string => p.toLowerCase();
  // The folder's own spelling on disk, whatever case it is asked in.
  const onDisk = (p: string): string | undefined => Object.keys(ids).find((k) => low(k) === low(p));
  // As the native realpath: `..` and `/` by spelling, then a short name or junction to the folder it names.
  const canon = (p: string): string => {
    let r = win32.resolve(p);
    for (const [from, to] of Object.entries(o.real ?? {})) if (low(r) === low(from) || low(r).startsWith(`${low(from)}\\`)) r = to + r.slice(from.length);
    return r;
  };
  return {
    realpath: async (p) => { const k = onDisk(canon(p)); if (k === undefined) throw ENOENT(); return k; },
    stat: async (p) => {
      if (o.failStat !== undefined && low(p) === low(o.failStat)) throw Object.assign(new Error("denied"), { code: "EPERM" });
      const k = onDisk(p);
      if (k === undefined) throw ENOENT();
      const [dev, ino] = ids[k]!.split(":");
      return { dev: BigInt(dev!), ino: BigInt(ino!) };
    },
    readText: async (p, max) => {
      const c = canon(p);
      const f = Object.keys(o.files ?? {}).find((k) => low(k) === low(c));
      if (f !== undefined) return o.files![f]!.slice(0, max);
      if (onDisk(c) !== undefined) throw Object.assign(new Error("it is a folder"), { code: "EISDIR" });
      throw ENOENT();
    },
  };
};
const winIds: Record<string, string> = {
  "C:\\": "5:1", "C:\\srv": "5:2", "C:\\srv\\nn": "5:3", "C:\\srv\\nn\\pkg": "5:4", "C:\\srv\\nn\\..x": "5:5", "C:\\srv\\nn-dev": "5:6",
  "C:\\srv\\nn\\.git": "5:20", "C:\\srv\\nn\\.git\\worktrees": "5:21", "C:\\srv\\nn\\.git\\worktrees\\dev": "5:22",
  "C:\\work": "5:10", "C:\\work\\dev": "5:11", "C:\\work\\wt": "5:12", "C:\\work\\wt2": "5:13", "C:\\work\\git-store": "5:14", "C:\\work\\git-store\\worktrees": "5:15", "C:\\work\\git-store\\worktrees\\dev": "5:16", "C:\\work\\fat": "5:0",
  "C:\\Program Files": "5:30", "C:\\Program Files\\NimbleNewt": "5:31", "C:\\Users": "5:40", "C:\\Users\\runneradmin": "5:41", "C:\\Users\\runneradmin\\dev": "5:42",
  "D:\\": "6:1", "D:\\srv": "6:2", "D:\\srv\\nn": "6:3",
  "\\\\box\\share\\": "7:1", "\\\\box\\share\\nn": "7:2", "\\\\box\\share\\nn\\x": "7:3", "\\\\box\\share\\dev": "7:4",
};
const winProgram = (path = "C:\\srv\\nn"): GuardedPlace[] => [{ what: "the running installation's program files", path, git: true }];

test("Windows, simulated: drive letters, either separator, case, UNC shares, short names and junctions are judged by Windows rules; what gives no file ID is refused", async () => {
  const win = (o: Parameters<typeof winFs>[1] = {}) => ({ fs: winFs(winIds, o), platform: "win32" });
  // Apart, and a sibling whose name starts with the installation's name.
  assert.deepEqual(await judgeSeparate([repo("C:\\work\\dev")], winProgram(), win()), { separate: true });
  assert.deepEqual(await judgeSeparate([repo("C:\\srv\\nn-dev")], winProgram(), win()), { separate: true });
  // The same folder in another case (drive letter too), with forward slashes, with "." and ".." and a trailing separator.
  await refusedWith([repo("c:\\SRV\\NN")], winProgram(), /is the same folder as the running installation's program files \(C:\\srv\\nn\)/, win());
  await refusedWith([repo("C:/srv/nn/pkg")], winProgram(), /inside the running installation's program files/, win());
  await refusedWith([repo("C:\\srv\\nn\\.\\pkg\\..\\pkg\\")], winProgram(), /inside/, win());
  await refusedWith([repo("C:\\srv\\nn\\..x")], winProgram(), /inside/, win());
  await refusedWith([repo("C:\\srv")], winProgram(), /holds the running installation's program files/, win());
  await refusedWith([repo("C:\\")], winProgram(), /holds/, win());
  // The same path on another drive is another folder.
  assert.deepEqual(await judgeSeparate([repo("D:\\srv\\nn")], winProgram(), win()), { separate: true });
  // A guarded folder given in another case or with forward slashes is the same guard.
  await refusedWith([repo("C:\\srv\\nn\\pkg")], winProgram("c:/SRV/nn"), /inside/, win());
  // A path relative to a drive's current folder ("C:srv") or to the working directory is not a full path: refused, never guessed.
  await refusedWith([repo("C:\\work\\dev"), repo("C:srv\\nn", "drive-relative")], winProgram(), /repository "drive-relative" is at C:srv\\nn, which is not a folder on the controller's machine/, win());
  await refusedWith([repo("C:\\work\\dev")], winProgram("srv\\nn"), /is not given as a full path/, win());
  // UNC shares: the share's root ends the way up; inside, the same folder in another case, and a folder beside it.
  const unc = winProgram("\\\\box\\share\\nn");
  await refusedWith([repo("\\\\box\\share\\nn\\x")], unc, /inside/, win());
  await refusedWith([repo("\\\\BOX\\Share\\NN")], unc, /same folder/, win());
  assert.deepEqual(await judgeSeparate([repo("\\\\box\\share\\dev")], unc, win()), { separate: true });
  // Short (8.3) names and a junction: the native realpath gives the long folder, so they are the folder they name.
  const real = { "C:\\PROGRA~1": "C:\\Program Files", "C:\\Users\\RUNNER~1": "C:\\Users\\runneradmin", "C:\\work\\junc": "C:\\srv\\nn" };
  await refusedWith([repo("C:\\Program Files\\NimbleNewt")], winProgram("C:\\PROGRA~1\\NimbleNewt"), /same folder/, win({ real }));
  await refusedWith([repo("c:\\progra~1\\nimblenewt")], winProgram("C:\\Program Files\\NimbleNewt"), /same folder/, win({ real }));
  await refusedWith([repo("C:\\Users\\RUNNER~1\\dev")], winProgram("C:\\Users\\runneradmin"), /inside/, win({ real }));
  await refusedWith([repo("C:\\work\\junc")], winProgram(), /same folder/, win({ real }));
  await refusedWith([repo("C:\\work\\junc\\pkg")], winProgram(), /inside/, win({ real }));
  // A file system that gives no file ID (inode 0) cannot tell a second spelling from another folder: refused, as on Linux (no fallback to paths alone).
  await refusedWith([repo("C:\\work\\fat")], winProgram(), /at C:\\work\\fat cannot be checked: its file system gives no folder identity/, win());
  // A folder that cannot be read on the way up: refused.
  await refusedWith([repo("C:\\work\\dev")], winProgram(), /cannot be checked: it could not be read on the controller's machine \(EPERM\)/, win({ failStat: "C:\\work" }));
});

test("Windows, simulated: git's .git files with forward slashes and CRLF are followed; a worktree whose git folder is in the installation's is refused, one of its own is not", async () => {
  const win = (files: Record<string, string>) => ({ fs: winFs(winIds, { files }), platform: "win32" });
  // As git for Windows writes it: a full path with forward slashes, CRLF line ends.
  await refusedWith([repo("C:\\work\\wt")], winProgram(), /the git folder of the development project's repository "source" \(C:\/srv\/nn\/\.git\/worktrees\/dev\) is inside the running installation's program files/,
    win({ "C:\\work\\wt\\.git": "gitdir: C:/srv/nn/.git/worktrees/dev\r\n" }));
  // A relative gitdir and commondir with forward slashes: its own git store beside it is separate; a commondir naming the installation's .git is refused.
  const own = { "C:\\work\\wt2\\.git": "gitdir: ../git-store/worktrees/dev\r\n", "C:\\work\\git-store\\worktrees\\dev\\commondir": "../..\r\n" };
  assert.deepEqual(await judgeSeparate([repo("C:\\work\\wt2")], winProgram(), win(own)), { separate: true });
  await refusedWith([repo("C:\\work\\wt2")], winProgram(), /git folder .*C:\/srv\/nn\/\.git\) is inside the running installation's program files/,
    win({ ...own, "C:\\work\\git-store\\worktrees\\dev\\commondir": "C:/srv/nn/.git\r\n" }));
  // The installation's own .git folder is guarded on Windows too: a checkout inside it is refused as inside its git folder's guard or the program files.
  await refusedWith([repo("C:\\srv\\nn\\.git\\worktrees\\dev")], winProgram(), /inside the running installation's program files/, win({}));
  // A .git file in another case of the drive letter and with a trailing CR only: followed the same.
  await refusedWith([repo("C:\\work\\wt")], winProgram(), /git folder .* is inside the running installation's program files/, win({ "C:\\work\\wt\\.git": "gitdir: c:\\SRV\\nn\\.git\\worktrees\\dev\r" }));
  // A .git file that names nothing: cannot tell.
  await refusedWith([repo("C:\\work\\wt")], winProgram(), /does not name a git folder/, win({ "C:\\work\\wt\\.git": "not a pointer\r\n" }));
});

test("the judge's path rules follow the platform it judges for, so a Linux judgement made on Windows is the Linux one", async () => {
  // The made-up POSIX disk of the tests above, judged for Linux: the same answer on every host (on Windows the host's own path rules would have put "/srv/nn" on the working directory's drive).
  const g: GuardedPlace[] = [{ what: "the running installation's program files", path: "/srv/nn" }];
  assert.deepEqual(await judgeSeparate([repo("/work/dev")], g, { fs: fakeFs(tree), platform: "linux" }), { separate: true });
  await refusedWith([repo("/mnt/live")], g, /same folder as the running installation's program files \(\/srv\/nn\)/, { fs: fakeFs(tree), platform: "linux" });
  // A backslash is part of a name on Linux, not a separator: "/srv/nn\\pkg" is a folder beside /srv/nn, not inside it.
  assert.deepEqual(await judgeSeparate([repo("/srv/nn\\pkg")], g, { fs: fakeFs({ ...tree, "/srv/nn\\pkg": "1:77" }), platform: "linux" }), { separate: true });
  // The same spelling judged for Windows is inside.
  await refusedWith([repo("C:\\srv\\nn\\pkg")], winProgram("C:/srv/nn"), /inside/, { fs: winFs(winIds), platform: "win32" });
});
