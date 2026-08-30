const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = path.join(
  os.homedir(),
  ".cache",
  "omarchy-battery-monitor-plugin-tests",
);
fs.mkdirSync(testRoot, { recursive: true });

// dirs: { key: mkdtemp-prefix, ... }. Creates one temp dir per key, passes
// { key: path, ... } to callback, and removes every created dir afterward
// regardless of whether callback throws.
function withFixture(dirs, callback) {
  const paths = {};
  for (const [key, prefix] of Object.entries(dirs)) {
    paths[key] = fs.mkdtempSync(path.join(testRoot, `${prefix}-`));
  }
  try {
    return callback(paths);
  } finally {
    for (const dir of Object.values(paths)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function executable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o700 });
}

module.exports = { testRoot, withFixture, executable };
