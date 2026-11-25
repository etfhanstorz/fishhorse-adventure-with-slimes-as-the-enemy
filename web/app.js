// Slime Forge front-end.
// Mode 1 (server, Tailscale): commands go to /api/cmd on server.py.
// Mode 2 (offline, GitHub Pages): the same Python engine runs in the browser via Pyodide.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
const PY_FILES = ["__init__.py", "art.py", "engine.py"];
const QUICK = ["n", "s", "e", "w", "map", "status", "mine", "inv", "weapons",
  "types", "board", "quests", "skills", "attack", "special", "flee", "use potion", "help"];

const termEl = document.getElementById("term");
const barEl = document.getElementById("bar");
const modeEl = document.getElementById("mode");
const form = document.getElementById("f");
const input = document.getElementById("in");
const quick = document.getElementById("quick");

let send;        // async (cmd) => {out, bar}
let saveNow;     // async () => void, persists the game in offline mode
let token;

function getToken() {
  try {
    let t = localStorage.getItem("slimeforge-token");
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("slimeforge-token", t);
    }
    return t;
  } catch (e) {
    return "anon" + Math.random().toString(16).slice(2).padEnd(12, "0");
  }
}

function print(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  termEl.appendChild(span);
  termEl.scrollTop = termEl.scrollHeight;
}

async function serverAvailable() {
  try {
    const r = await fetch("api/ping", { cache: "no-store" });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function setupServer() {
  modeEl.textContent = "server mode (Tailscale)";
  send = async (cmd) => {
    const r = await fetch("api/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, cmd }),
    });
    if (!r.ok) throw new Error("server error " + r.status);
    return r.json();
  };
  saveNow = async () => {};
}

async function setupPyodide() {
  modeEl.textContent = "offline mode (Pyodide, saved in this browser)";
  print("Loading the Python engine in your browser (first time takes a moment)...", "cmd");
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PYODIDE_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load Pyodide"));
    document.head.appendChild(s);
  });
  const py = await loadPyodide();
  py.FS.mkdirTree("/home/pyodide/slimeforge");
  for (const f of PY_FILES) {
    const text = await (await fetch("slimeforge/" + f)).text();
    py.FS.writeFile("/home/pyodide/slimeforge/" + f, text);
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')\nfrom slimeforge.engine import Game\n");
  let saved = null;
  try { saved = localStorage.getItem("slimeforge-save"); } catch (e) {}
  if (saved) {
    py.globals.set("saved", saved);
    py.runPython("game = Game.loads(saved)");
  } else {
    py.runPython("game = Game()");
  }
  send = async (cmd) => {
    py.globals.set("cmd", cmd);
    const out = py.runPython("game.handle(cmd)");
    const bar = py.runPython("game.bar()");
    return { out, bar };
  };
  saveNow = async () => {
    const data = py.runPython("game.dumps()");
    try { localStorage.setItem("slimeforge-save", data); } catch (e) {}
  };
}

async function run(cmd) {
  if (!cmd.trim()) return;
  print("> " + cmd, "cmd");
  try {
    const res = await send(cmd);
    if (res.out) print(res.out);
    barEl.textContent = res.bar;
    await saveNow();
  } catch (e) {
    print("Error: " + e.message);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const cmd = input.value;
  input.value = "";
  run(cmd);
});

QUICK.forEach((c) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = c;
  b.addEventListener("click", () => { run(c); input.focus(); });
  quick.appendChild(b);
});

(async function main() {
  token = getToken();
  print("Welcome to Slime Forge. Type 'help' for commands.");
  try {
    if (await serverAvailable()) {
      await setupServer();
    } else {
      await setupPyodide();
    }
  } catch (e) {
    print("Could not start: " + e.message, "cmd");
    return;
  }
  await run("status");
})();
