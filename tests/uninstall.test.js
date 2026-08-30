const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture, executable } = require("./support/fixture");

const uninstaller = path.join(
  __dirname,
  "..",
  "scripts",
  "uninstall-session-tracker.sh",
);

function withUninstallFixture(callback) {
  return withFixture({ root: "uninstall" }, (f) => {
    const plugin = path.join(f.root, "plugin");
    const config = path.join(f.root, "config");
    const units = path.join(config, "systemd", "user");
    const state = path.join(f.root, "state");
    const bin = path.join(f.root, "bin");
    fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(plugin, "service"), { recursive: true });
    fs.mkdirSync(units, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });

    fs.writeFileSync(path.join(plugin, "manifest.json"), "{}\n");
    fs.writeFileSync(path.join(units, "battery-session-tracker.service"), "");
    fs.writeFileSync(path.join(state, "state"), "previous_state=on-battery\n");
    fs.writeFileSync(
      path.join(state, "discharge-history.tsv"),
      "# battery-discharge-history\tv1\n",
    );
    fs.mkdirSync(path.join(state, "metrics"));
    fs.writeFileSync(path.join(state, "metrics", "future-data"), "retained\n");
    executable(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
    executable(path.join(bin, "omarchy-shell"), "#!/usr/bin/env bash\nexit 0\n");

    return callback({ ...f, plugin, config, state, bin });
  });
}

function runUninstaller(f, args = []) {
  return spawnSync(uninstaller, args, {
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      PLUGIN_DIR: f.plugin,
      XDG_CONFIG_HOME: f.config,
      BATTERY_SESSION_STATE_DIR: f.state,
    },
    encoding: "utf8",
  });
}

test("uninstall --keep-data retains all collected data", () => {
  withUninstallFixture((f) => {
    const result = runUninstaller(f, ["--keep-data"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.plugin), false);
    assert.equal(fs.existsSync(path.join(f.state, "state")), true);
    assert.equal(
      fs.existsSync(path.join(f.state, "discharge-history.tsv")),
      true,
    );
    assert.equal(
      fs.readFileSync(path.join(f.state, "metrics", "future-data"), "utf8"),
      "retained\n",
    );
    assert.match(result.stdout, /data retained at/);
  });
});

test("uninstall without --keep-data purges all collected data", () => {
  withUninstallFixture((f) => {
    const result = runUninstaller(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.plugin), false);
    assert.equal(fs.existsSync(f.state), false);
    assert.match(result.stdout, /session and intelligence data removed/);
  });
});

test("make lifecycle targets restart the shell", () => {
  const repository = path.join(__dirname, "..");
  function dryRun(target) {
    return spawnSync("make", ["--no-print-directory", "-n", target], {
      cwd: repository,
      encoding: "utf8",
    });
  }

  const installed = dryRun("install");
  const retained = dryRun("uninstall");
  const purged = dryRun("uninstall-purge-data");
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /^scripts\/install-session-tracker\.sh$/m);
  assert.match(installed.stdout, /omarchy restart shell/);
  assert.equal(retained.status, 0, retained.stderr);
  assert.match(
    retained.stdout,
    /^scripts\/uninstall-session-tracker\.sh --keep-data$/m,
  );
  assert.match(retained.stdout, /omarchy restart shell/);
  assert.equal(purged.status, 0, purged.stderr);
  assert.match(purged.stdout, /^scripts\/uninstall-session-tracker\.sh$/m);
  assert.match(purged.stdout, /omarchy restart shell/);
});

test("uninstall rejects unknown options before removing anything", () => {
  withUninstallFixture((f) => {
    const result = runUninstaller(f, ["--unknown"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: .* \[--keep-data\]/);
    assert.equal(fs.existsSync(path.join(f.plugin, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(f.state, "state")), true);
  });
});
