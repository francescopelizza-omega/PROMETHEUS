/**
 * remote.types.test.ts — remote path translation + launcher argv + gate guard (§3.7).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RemoteTarget,
  buildComposeArgv,
  buildDockerArgv,
  buildSshArgv,
  buildWslArgv,
  launcherArgv,
  remoteTargetAllowed,
  toLocalPath,
  toRemotePath,
} from "./remote.types.js";

function target(
  kind: RemoteTarget["kind"],
  spec: Record<string, string>,
  over: Partial<RemoteTarget> = {},
): RemoteTarget {
  return {
    id: `${kind}-1`,
    kind,
    label: kind,
    spec,
    pythonPath: "/usr/bin/python3",
    pathMap: [{ local: "/home/u/proj", remote: "/workspace" }],
    gate: { verdict: "allow", score: 0, signedAt: "2026-06-19T00:00:00Z" },
    ...over,
  };
}

// ---- path translation ------------------------------------------------------ //

test("toRemotePath / toLocalPath map via the path prefix", () => {
  const t = target("ssh", { host: "box" });
  assert.equal(toRemotePath(t, "/home/u/proj/src/app.py"), "/workspace/src/app.py");
  assert.equal(toRemotePath(t, "/home/u/proj"), "/workspace");
  assert.equal(toLocalPath(t, "/workspace/src/app.py"), "/home/u/proj/src/app.py");
  assert.equal(toRemotePath(t, "/etc/passwd"), undefined, "outside the map → undefined");
});

test("longest-prefix wins when maps overlap", () => {
  const t = target(
    "ssh",
    { host: "box" },
    {
      pathMap: [
        { local: "/home/u/proj", remote: "/workspace" },
        { local: "/home/u/proj/vendor", remote: "/opt/vendor" },
      ],
    },
  );
  assert.equal(toRemotePath(t, "/home/u/proj/vendor/x.py"), "/opt/vendor/x.py");
});

// ---- launcher argv --------------------------------------------------------- //

test("buildSshArgv: user@host + port + command after --", () => {
  const t = target("ssh", { host: "box", user: "deploy", port: "2222" });
  assert.deepEqual(buildSshArgv(t, ["python3", "-V"]), [
    "ssh",
    "-p",
    "2222",
    "deploy@box",
    "--",
    "python3",
    "-V",
  ]);
  const noUser = target("ssh", { host: "box" });
  assert.deepEqual(buildSshArgv(noUser, ["ls"]), ["ssh", "box", "--", "ls"]);
});

test("buildDockerArgv: docker exec [-w] container command", () => {
  const t = target("docker", { container: "web", workdir: "/app" });
  assert.deepEqual(buildDockerArgv(t, ["pytest"]), [
    "docker",
    "exec",
    "-w",
    "/app",
    "web",
    "pytest",
  ]);
});

test("buildComposeArgv: docker compose [-f] exec -T service command", () => {
  const t = target("compose", { service: "api", file: "docker-compose.yml" });
  assert.deepEqual(buildComposeArgv(t, ["python", "manage.py", "test"]), [
    "docker",
    "compose",
    "-f",
    "docker-compose.yml",
    "exec",
    "-T",
    "api",
    "python",
    "manage.py",
    "test",
  ]);
});

test("buildWslArgv: wsl -d distro --cd dir -- command", () => {
  const t = target("wsl", { distro: "Ubuntu", cwd: "/mnt/c/proj" });
  assert.deepEqual(buildWslArgv(t, ["python3", "x.py"]), [
    "wsl",
    "-d",
    "Ubuntu",
    "--cd",
    "/mnt/c/proj",
    "--",
    "python3",
    "x.py",
  ]);
});

test("launcherArgv dispatches by kind", () => {
  assert.equal(launcherArgv(target("ssh", { host: "h" }), ["x"])[0], "ssh");
  assert.equal(launcherArgv(target("docker", { container: "c" }), ["x"])[0], "docker");
  assert.equal(launcherArgv(target("wsl", { distro: "d" }), ["x"])[0], "wsl");
});

// ---- gate guard (C3/C5 fail-closed) ---------------------------------------- //

test("remoteTargetAllowed: airgapped disables all; block/error verdict refused", () => {
  const ok = target("ssh", { host: "h" });
  assert.equal(remoteTargetAllowed(ok, false), true);
  assert.equal(remoteTargetAllowed(ok, true), false, "airgapped disables remote (§3.7)");
  const blocked = target(
    "ssh",
    { host: "h" },
    { gate: { verdict: "block", score: 90, signedAt: "x" } },
  );
  assert.equal(remoteTargetAllowed(blocked, false), false, "a blocked target is fail-closed");
});
