const fs = require("node:fs");
const path = require("node:path");

function isoNow() {
  return new Date().toISOString();
}

function isDirectory(target) {
  try {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function getRepoRoot() {
  if (process.env.AUTORESEARCH_REPO_ROOT) {
    return path.resolve(process.env.AUTORESEARCH_REPO_ROOT);
  }

  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    return cwd;
  }
  if (path.basename(cwd) === "experiment-atlas") {
    return path.resolve(cwd, "..");
  }
  return path.resolve(cwd);
}

class AtlasWatchHub {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.roots = [path.join(repoRoot, "experiment_logs"), path.join(repoRoot, "runpod_runs")];
    this.watchedRootNames = new Set(this.roots.map((root) => path.basename(root)));
    this.watchers = new Map();
    this.listeners = new Map();
    this.nextListenerId = 1;
    this.version = 0;
    this.emitTimer = null;
    this.rescanTimer = null;
    this.ensureRepoRootWatcher();
    this.rescan();
  }

  snapshot() {
    return {
      type: "ready",
      version: this.version,
      timestamp: isoNow(),
    };
  }

  subscribe(listener) {
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    return () => {
      this.listeners.delete(id);
    };
  }

  ensureRepoRootWatcher() {
    if (this.watchers.has(this.repoRoot)) {
      return;
    }
    this.watchDirectory(this.repoRoot, (filename) => {
      if (!filename || !this.watchedRootNames.has(filename)) {
        return;
      }
      this.scheduleRescan();
      this.scheduleEmit();
    });
  }

  watchDirectory(dir, onEvent) {
    if (this.watchers.has(dir) || !isDirectory(dir)) {
      return;
    }
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        if (typeof onEvent === "function") {
          onEvent(filename ? filename.toString() : null);
          return;
        }
        this.scheduleRescan();
        this.scheduleEmit();
      });
      watcher.on("error", () => {
        this.closeWatcher(dir);
        this.scheduleRescan();
        this.scheduleEmit();
      });
      this.watchers.set(dir, watcher);
    } catch {
      return;
    }
  }

  closeWatcher(dir) {
    const watcher = this.watchers.get(dir);
    if (!watcher) {
      return;
    }
    watcher.close();
    this.watchers.delete(dir);
  }

  listWatchedDirectories() {
    const seen = new Set();
    const queue = this.roots.filter((root) => isDirectory(root));

    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || seen.has(current)) {
        continue;
      }
      seen.add(current);
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        queue.push(path.join(current, entry.name));
      }
    }

    return [...seen];
  }

  rescan() {
    this.rescanTimer = null;
    const nextDirs = new Set(this.listWatchedDirectories());
    for (const dir of nextDirs) {
      this.watchDirectory(dir);
    }
    for (const dir of [...this.watchers.keys()]) {
      if (dir === this.repoRoot) {
        continue;
      }
      if (!nextDirs.has(dir)) {
        this.closeWatcher(dir);
      }
    }
  }

  scheduleRescan() {
    if (this.rescanTimer !== null) {
      return;
    }
    this.rescanTimer = setTimeout(() => {
      this.rescan();
    }, 75);
    this.rescanTimer.unref?.();
  }

  emit() {
    this.emitTimer = null;
    this.version += 1;
    const payload = {
      type: "disk-change",
      version: this.version,
      timestamp: isoNow(),
    };
    for (const listener of this.listeners.values()) {
      listener(payload);
    }
  }

  scheduleEmit() {
    if (this.emitTimer !== null) {
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emit();
    }, 150);
    this.emitTimer.unref?.();
  }
}

function getAtlasWatchHub() {
  if (!global.__atlasWatchHub) {
    global.__atlasWatchHub = new AtlasWatchHub(getRepoRoot());
  }
  return global.__atlasWatchHub;
}

module.exports = {
  getAtlasWatchHub,
};
