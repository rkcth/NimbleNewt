import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkWindowsHostPath, foldWin, isWindowsDeviceName, overlapsWin } from "./windows-paths.js";

// The Windows path rules the native launcher's recipe check uses (moved from windows.test.ts when the Windows Sandbox backend was removed). Pure; any OS.
describe("Windows path rules", () => {
  test("a shared host path must be a local, normalised path that is not the system", () => {
    const env = (n: string): string | undefined => ({ SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" })[n];
    for (const good of ["C:\\Jobs\\a", "D:\\x y\\z", "C:\\ProgramData\\NimbleNewt\\job1", "C:\\Users\\robert\\checkout"]) assert.equal(checkWindowsHostPath("p", good, env), good);
    for (const badPath of ["work", "\\\\server\\share", "\\\\?\\C:\\x", "C:\\x\\..\\y", "C:\\x\\", "C:\\x:stream", "C:\\x\\PROGRA~1", "C:\\x.", "C:", "C:\\a|b", "C:\\Windows", "C:\\windows\\system32", "C:\\Program Files\\x", "C:\\ProgramData", "C:\\Users", "C:\\x//y", "C:\\Jobs\\NUL", "C:\\Jobs\\com1.txt"]) {
      assert.throws(() => checkWindowsHostPath("p", badPath, env), /./, badPath);
    }
  });

  test("paths compare without regard to case, including letters whose upper case is plain ASCII; device names are recognised", () => {
    assert.equal(foldWin("C:\\Program F\u0131les"), foldWin("c:\\program files"));
    assert.ok(overlapsWin("C:\\Jobs\\A", "c:\\jobs"));
    assert.ok(overlapsWin("c:\\jobs", "C:\\Jobs\\A\\b"));
    assert.ok(!overlapsWin("C:\\Jobs2", "C:\\Jobs"));
    for (const d of ["CON", "nul", "COM1", "lpt9.log", "CONIN$", "clock$"]) assert.ok(isWindowsDeviceName(d), d);
    for (const n of ["console", "nullable", "com", "a.txt"]) assert.ok(!isWindowsDeviceName(n), n);
  });
});
