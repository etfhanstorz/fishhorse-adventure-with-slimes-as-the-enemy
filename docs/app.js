// Slime Forge 2D front-end: draws the world on a canvas and sends player
// actions to the engine. Mode 1 (server/Tailscale) posts to api/cmd.
// Mode 2 (GitHub Pages) runs the same Python engine in the browser via Pyodide.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
const PY_FILES = ["__init__.py", "art.py", "engine.py"];
const T = 32;                       // tile size in px
const COLS = 24, ROWS = 12;         // map size (matches engine)
const HUD_H = 48;                   // strip under the map
const CW = COLS * T, CH = ROWS * T + HUD_H;

const SLIME_COLOR = { green: "#5ccc4a", blue: "#4a90e2", red: "#e2544a", black: "#3a3a52" };
const SLIME_DARK = { green: "#2f8a2a", blue: "#2c63b0", red: "#a52e26", black: "#15151f" };
const ORE_COLOR = { copper: "#cd7f32", iron: "#a9b4c2", silver: "#e5e7eb",
                    steel: "#7f8ea3", mithril: "#7ad7f0", obsidian: "#8d6bd6" };

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
// Draw at 1920x1080 for a sharp 1080p picture; the game layout stays in CW x CH units.
const OUT_W = 1920, OUT_H = 1080;
const SCALE = Math.min(OUT_W / CW, OUT_H / CH);
canvas.width = OUT_W; canvas.height = OUT_H;

const $ = (id) => document.getElementById(id);
const logEl = $("log"), panelEl = $("panel"), tabsEl = $("tabs"), padEl = $("pad"), modeEl = $("mode");

let V = null;                 // latest view from the engine
let tab = "inv";
let send = null;              // async (cmd) => {out, view, bar}
let saveNow = async () => {};
let token;
let chain = Promise.resolve();
let flashUntil = 0, prevEnemyHp = null, prevEnemyColor = null;

// ------------------------------------------------------------ helpers
function hash(x, y) { return ((x * 73856093) ^ (y * 19349663)) >>> 0; }

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

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (k === "text") n.textContent = v;
    else if (k === "on") n.addEventListener(v[0], v[1]);
    else n[k] = v;
  }
  for (const c of children) n.append(c);
  return n;
}

function button(label, cmd, cls = "btn", disabled = false) {
  return el("button", {
    class: cls, text: label, disabled,
    on: ["click", () => run(cmd)],
  });
}

function addLog(text) {
  if (!text) return;
  for (const line of text.split("\n")) {
    let cls = "";
    if (/defeat|Victory|LEVEL UP|Quest done|Quest complete|Loot|forged/i.test(line)) cls = "me";
    else if (/hits you|lost|defeated|can't|too weak|Unknown|fail|no |Not |need/i.test(line)) cls = "warn";
    const span = el("span", { class: cls, text: line + "\n" });
    logEl.append(span);
  }
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

// ------------------------------------------------------------ drawing
function drawGrass(px, py, h) {
  ctx.fillStyle = "#5fb84a";
  ctx.fillRect(px, py, T, T);
  ctx.fillStyle = "#4ea23b";
  for (let i = 0; i < 4; i++) {
    const sx = px + ((h >> (i * 3)) % (T - 4)) + 2;
    const sy = py + ((h >> (i * 3 + 7)) % (T - 4)) + 2;
    ctx.fillRect(sx, sy, 2, 2);
  }
}

function drawTile(ch, x, y) {
  const px = x * T, py = y * T, h = hash(x, y);
  switch (ch) {
    case "~": {
      ctx.fillStyle = "#2f6fbf"; ctx.fillRect(px, py, T, T);
      ctx.strokeStyle = "#7fb3f0"; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(px + 6, py + 12); ctx.quadraticCurveTo(px + 10, py + 8, px + 16, py + 12);
      ctx.quadraticCurveTo(px + 22, py + 16, px + 26, py + 12); ctx.stroke();
      return;
    }
    case "^": {
      ctx.fillStyle = "#5c626d"; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = "#8c939f"; ctx.beginPath();
      ctx.moveTo(px + 2, py + T - 2); ctx.lineTo(px + T / 2, py + 4); ctx.lineTo(px + T - 2, py + T - 2);
      ctx.fill();
      ctx.fillStyle = "#e8eef5"; ctx.beginPath();
      ctx.moveTo(px + T / 2 - 5, py + 10); ctx.lineTo(px + T / 2, py + 4); ctx.lineTo(px + T / 2 + 5, py + 10);
      ctx.fill();
      return;
    }
    case "C": {
      ctx.fillStyle = "#4a3a30"; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = "#1f1712"; ctx.beginPath();
      ctx.ellipse(px + T / 2, py + T / 2 + 2, 11, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(px + 6 + (h % 8), py + 6 + (h % 5), 3, 3);
      ctx.fillRect(px + 20 - (h % 6), py + 20 + (h % 3), 3, 3);
      return;
    }
    case "N": {
      ctx.fillStyle = "#5b2c6f"; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = "#b07cc6";
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(px + 8 + ((h >> (i * 4)) % 16), py + 10 + ((h >> (i * 4 + 2)) % 14), 4, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case "V": {
      drawGrass(px, py, h);
      ctx.fillStyle = "#f1d9a6"; ctx.fillRect(px + 7, py + 14, 18, 14);
      ctx.fillStyle = "#c0392b"; ctx.beginPath();
      ctx.moveTo(px + 4, py + 15); ctx.lineTo(px + 16, py + 4); ctx.lineTo(px + 28, py + 15); ctx.fill();
      ctx.fillStyle = "#6b4423"; ctx.fillRect(px + 14, py + 20, 5, 8);
      ctx.fillStyle = "#4cc9f0"; ctx.fillRect(px + 9, py + 17, 3, 3); ctx.fillRect(px + 20, py + 17, 3, 3);
      return;
    }
    case "T": {
      drawGrass(px, py, h);
      ctx.fillStyle = "#6b4423"; ctx.fillRect(px + 14, py + 18, 4, 10);
      ctx.fillStyle = "#2e7d32"; ctx.beginPath();
      ctx.arc(px + 16, py + 13, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3f9a45"; ctx.beginPath();
      ctx.arc(px + 13, py + 10, 5, 0, Math.PI * 2); ctx.fill();
      return;
    }
    default:
      drawGrass(px, py, h);
  }
}

function drawHero(px, py, scale = 1) {
  ctx.save();
  ctx.translate(px, py); ctx.scale(scale, scale);
  ctx.fillStyle = "#2d7ff9"; ctx.fillRect(9, 14, 14, 12);        // body
  ctx.fillStyle = "#ffd7a8"; ctx.beginPath(); ctx.arc(16, 10, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#7a4a1f"; ctx.fillRect(8, 3, 16, 4);          // hat
  ctx.fillStyle = "#1b2233"; ctx.fillRect(13, 9, 2, 2); ctx.fillRect(18, 9, 2, 2);
  ctx.fillStyle = "#6b3d1c"; ctx.fillRect(9, 26, 5, 4); ctx.fillRect(18, 26, 5, 4);
  const w = V && V.weapon_types && V.weapons.find(x => x.id === V.equipped);
  if (w) {
    ctx.strokeStyle = ORE_COLOR[w.material] || "#ccc"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(24, 16); ctx.lineTo(30, 4); ctx.stroke();
  }
  ctx.restore();
}

function drawMap() {
  ctx.fillStyle = "#0b0f1a"; ctx.fillRect(0, 0, CW, CH);
  const explored = new Set(V.explored.map(([x, y]) => x + "," + y));
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (explored.has(x + "," + y)) drawTile(V.grid[y][x], x, y);
      else { ctx.fillStyle = "#0b0f1a"; ctx.fillRect(x * T, y * T, T, T); }
    }
  }
  const [px, py] = V.pos;
  drawHero(px * T, py * T - 2, 1);
  ctx.fillStyle = "#0b1020"; ctx.fillRect(0, ROWS * T, CW, HUD_H);
  ctx.fillStyle = "#eef2ff"; ctx.font = "bold 14px Segoe UI, sans-serif";
  ctx.fillText(`${(V.tile_names[V.tile] || "")}  -  mining tier ${V.mining_tier}`, 12, ROWS * T + 20);
  ctx.fillStyle = "#9aa6c7"; ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillText("Walk over ^ mountains or C caves and press E to mine. Enter V for the village.", 12, ROWS * T + 38);
}

function drawBar(x, y, w, h, ratio, color) {
  ctx.fillStyle = "#000"; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = "#3b3b52"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, Math.max(0, Math.min(1, ratio)) * w, h);
}

function drawSlime(cx, cy, color, t, hurt) {
  const bounce = Math.sin(t / 260) * 6;
  const shake = hurt ? (Math.random() - 0.5) * 10 : 0;
  cx += shake; cy += bounce;
  const base = SLIME_COLOR[color], dark = SLIME_DARK[color];
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(cx, cy + 62, 62 - bounce, 10, 0, 0, Math.PI * 2); ctx.fill();
  // body
  const g = ctx.createRadialGradient(cx - 20, cy - 30, 10, cx, cy, 80);
  g.addColorStop(0, base); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(cx, cy, 70, 52, 0, 0, Math.PI * 2); ctx.fill();
  // gloss
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath(); ctx.ellipse(cx - 28, cy - 28, 14, 8, -0.5, 0, Math.PI * 2); ctx.fill();
  // eyes
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(cx - 24, cy - 6, 14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 24, cy - 6, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#111";
  const angry = hurt ? 2 : 0;
  ctx.beginPath(); ctx.arc(cx - 22, cy - 4 + angry, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 26, cy - 4 + angry, 6, 0, Math.PI * 2); ctx.fill();
  // mouth
  ctx.strokeStyle = "#111"; ctx.lineWidth = 3; ctx.beginPath();
  if (hurt) ctx.arc(cx, cy + 26, 10, Math.PI * 1.1, Math.PI * 1.9);
  else ctx.arc(cx, cy + 20, 10, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();
}

function drawBattle(t) {
  const b = V.battle;
  const hurt = performance.now() < flashUntil;
  // sky and ground
  const sky = ctx.createLinearGradient(0, 0, 0, ROWS * T);
  sky.addColorStop(0, "#7ec8ff"); sky.addColorStop(1, "#cfeeff");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, CW, ROWS * T);
  ctx.fillStyle = "#6fbf5a"; ctx.fillRect(0, 300, CW, ROWS * T - 300);
  ctx.fillStyle = "#5aa64a";
  for (let i = 0; i < 20; i++) ctx.fillRect((i * 97) % CW, 320 + ((i * 37) % 90), 6, 3);
  // hero
  drawHero(110, 150, 3);
  drawBar(60, 100, 180, 14, V.hp / V.max_hp, "#ef476f");
  ctx.fillStyle = "#fff"; ctx.font = "bold 14px Segoe UI"; ctx.fillText(`You  ${V.hp}/${V.max_hp} HP`, 60, 92);
  // slime
  drawSlime(520, 210, b.color, t, hurt);
  drawBar(420, 96, 200, 14, b.hp / b.max, SLIME_COLOR[b.color]);
  ctx.fillStyle = "#fff"; ctx.font = "bold 14px Segoe UI";
  ctx.fillText(`${b.color} slime  ${Math.max(0, b.hp)}/${b.max} HP`, 420, 88);
  // status line
  ctx.fillStyle = "#0b1020"; ctx.fillRect(0, ROWS * T, CW, HUD_H);
  ctx.fillStyle = "#eef2ff"; ctx.font = "13px Segoe UI";
  const w = V.weapons.find(x => x.id === V.equipped);
  const special = w ? V.weapon_types[w.type].special : "none";
  ctx.fillText(`Weapon: ${w ? w.name : "fists"}   Special: ${special}` +
               (V.cool > 0 ? `  (ready in ${V.cool})` : "  (ready)"), 12, ROWS * T + 20);
  ctx.fillStyle = "#9aa6c7";
  ctx.fillText("Keys: 1 attack   2 special   3 potion   4 flee", 12, ROWS * T + 38);
}

function render(t) {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  if (V) {
    if (V.battle) drawBattle(t);
    else drawMap();
  } else {
    ctx.fillStyle = "#0b0f1a"; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = "#eef2ff"; ctx.font = "20px Segoe UI";
    ctx.fillText("Loading...", 20, 40);
  }
  requestAnimationFrame(render);
}

// ------------------------------------------------------------ HUD / panels
function renderStats() {
  $("s-hp").textContent = `HP ${V.hp}/${V.max_hp}`;
  $("s-lv").textContent = `Lv ${V.level}`;
  $("s-xp").textContent = `XP ${V.xp}/${V.xp_need}`;
  $("s-gold").textContent = `Gold ${V.gold}`;
  $("s-pot").textContent = `Potions ${V.potions}`;
}

function renderPad() {
  padEl.innerHTML = "";
  if (V.battle) {
    padEl.style.gridTemplateColumns = "repeat(4, 110px)";
    padEl.append(
      button("1 Attack", "attack", "btn good"),
      button(`2 Special${V.cool ? " (" + V.cool + ")" : ""}`, "special", "btn", V.cool > 0),
      button(`3 Potion (${V.potions})`, "use potion", "btn", V.potions <= 0),
      button("4 Flee", "flee", "btn bad"),
    );
  } else {
    padEl.style.gridTemplateColumns = "repeat(3, 52px)";
    padEl.append(
      el("span"), button("N", "n"), el("span"),
      button("W", "w"), button("Mine", "mine"), button("E", "e"),
      el("span"), button("S", "s"), el("span"),
    );
  }
}

function renderTabs() {
  tabsEl.innerHTML = "";
  const list = [["inv", "Inventory (I)"], ["forge", "Forge (F)"], ["quests", "Quests (Q)"], ["skills", "Skills (K)"]];
  for (const [id, label] of list) {
    tabsEl.append(el("button", {
      class: "btn" + (tab === id ? " on" : ""), text: label,
      on: ["click", () => { tab = id; renderPanel(); renderTabs(); }],
    }));
  }
}

function renderPanel() {
  if (!V) return;
  panelEl.innerHTML = "";
  const inVillage = V.tile === "V";
  if (tab === "inv") {
    panelEl.append(
      el("div", { class: "item", text: `Gold ${V.gold}  |  Potions ${V.potions}  |  Essence ${V.essence}` }),
      button(`Drink potion (${V.potions})`, "use potion", "btn", V.potions <= 0),
    );
    const ores = Object.entries(V.ores).map(([k, v]) => `${k} x${v}`).join(", ") || "none";
    panelEl.append(el("div", { class: "item muted", text: "Materials: " + ores }));
    if (!V.weapons.length) panelEl.append(el("div", { class: "muted", text: "No weapons yet. Mine ore, smelt bars, forge one in the village." }));
    for (const w of V.weapons) {
      const info = V.weapon_types[w.type];
      const enc = w.enchants.map(e => el("span", { class: "pill", text: e }));
      panelEl.append(el("div", { class: "item" }, [
        el("div", { style: `color:${ORE_COLOR[w.material] || "#fff"};font-weight:700`, text: `#${w.id} ${w.name}` }),
        el("div", { class: "muted", text: `dmg ${w.damage} · crit ${(w.crit * 100).toFixed(1)}% · special ${info.special} · slots ${w.enchants.length}/${w.slots + (V.skills.includes("enchanter") ? 1 : 0)}` }),
        el("div", {}, enc),
        el("div", { class: "row" }, [
          w.id === V.equipped
            ? el("span", { class: "pill", text: "equipped" })
            : button("Equip", `equip ${w.id}`),
          button("Sell", `sell ${w.id}`, "btn bad"),
        ]),
      ]));
    }
  } else if (tab === "forge") {
    if (!inVillage) panelEl.append(el("div", { class: "item", text: "Walk into the village (V) to smelt, forge and enchant." }));
    panelEl.append(el("div", { class: "muted", text: "Smelt: 2 ore → 1 bar" }));
    for (const mat of Object.keys(V.materials)) {
      const ore = V.ores[mat] || 0, bars = V.ores[mat + " bar"] || 0;
      panelEl.append(el("div", { class: "row item" }, [
        el("span", { style: `color:${ORE_COLOR[mat]};font-weight:700;min-width:80px`, text: mat }),
        el("span", { class: "muted", text: `ore ${ore}  bars ${bars}` }),
        button("Smelt", `smelt ${mat}`, "btn", !inVillage || ore < 2),
      ]));
    }
    panelEl.append(el("div", { class: "muted", text: "Forge: 2 bars + gold" }));
    const smith = V.skills.includes("smith");
    for (const [type, info] of Object.entries(V.weapon_types)) {
      const row = el("div", { class: "item" }, [
        el("div", { text: `${type}  dmg ${info.dmg} · crit ${(info.crit * 100).toFixed(0)}% · ${info.special}`, style: "font-weight:600" }),
      ]);
      const mats = el("div", { class: "row" });
      for (const [mat, tier] of Object.entries(V.materials)) {
        const bars = V.ores[mat + " bar"] || 0;
        let cost = 20 * tier; if (smith) cost = Math.floor(cost * 0.75);
        mats.append(button(`${mat} ${cost}g`, `forge ${type} ${mat}`, "btn", !inVillage || bars < 2));
      }
      row.append(mats);
      panelEl.append(row);
    }
    panelEl.append(el("div", { class: "muted", text: "Enchant: 30 gold + 1 essence (you have " + V.essence + ")" }));
    for (const w of V.weapons) {
      const free = w.slots + (V.skills.includes("enchanter") ? 1 : 0) - w.enchants.length;
      const row = el("div", { class: "item" }, [el("div", { text: `#${w.id} ${w.name}`, style: "font-weight:600" })]);
      const btns = el("div", { class: "row" });
      for (const name of Object.keys(V.enchants)) {
        if (w.enchants.includes(name)) continue;
        btns.append(button(name, `enchant ${w.id} ${name}`, "btn", !inVillage || free <= 0));
      }
      row.append(btns);
      panelEl.append(row);
    }
  } else if (tab === "quests") {
    panelEl.append(el("div", { class: "muted", text: "Quest board (accept in the village)" }));
    V.board.forEach((q, i) => {
      panelEl.append(el("div", { class: "item" }, [
        el("div", { text: q.text, style: "font-weight:600" }),
        el("div", { class: "muted", text: `reward ${q.gold} gold, ${q.xp} XP` }),
        button("Accept", `accept ${i + 1}`, "btn", !inVillage || V.active.length >= 3),
      ]));
    });
    panelEl.append(el("div", { class: "muted", text: "Active (max 3)" }));
    if (!V.active.length) panelEl.append(el("div", { class: "muted", text: "None." }));
    V.active.forEach((q, i) => {
      const done = q.have >= q.target;
      panelEl.append(el("div", { class: "item" }, [
        el("div", { text: q.text, style: "font-weight:600" }),
        el("div", { class: "muted", text: `progress ${q.have}/${q.target}` }),
        button("Claim", `claim ${i + 1}`, done ? "btn good" : "btn", !inVillage || !done),
      ]));
    });
  } else if (tab === "skills") {
    panelEl.append(el("div", { class: "item", text: `Skill points: ${V.points}` }));
    for (const [name, s] of Object.entries(V.skill_defs)) {
      const learned = V.skills.includes(name);
      const available = !learned && s.req.every(r => V.skills.includes(r));
      const state = learned ? "learned" : available ? "available" : "locked (" + s.req.join(", ") + ")";
      panelEl.append(el("div", { class: "item" }, [
        el("div", { style: "font-weight:600", text: `${name}  ·  cost ${s.cost}` }),
        el("div", { class: "muted", text: s.desc + "  [" + state + "]" }),
        learned ? el("span", { class: "pill", text: "learned" })
                : button("Learn", `learn ${name}`, "btn", !available || V.points < s.cost),
      ]));
    }
  }
}

function applyView(view) {
  const now = performance.now();
  if (view.battle && prevEnemyColor === view.battle.color && prevEnemyHp !== null && view.battle.hp < prevEnemyHp) {
    flashUntil = now + 350;
  }
  prevEnemyHp = view.battle ? view.battle.hp : null;
  prevEnemyColor = view.battle ? view.battle.color : null;
  V = view;
  renderStats();
  renderPad();
  renderPanel();
  renderTabs();
}

// ------------------------------------------------------------ commands
function run(cmd) {
  if (!cmd || !cmd.trim()) return;
  chain = chain.then(async () => {
    try {
      const res = await send(cmd);
      addLog(res.out);
      if (res.view) applyView(res.view);
      await saveNow();
    } catch (e) {
      addLog("Error: " + e.message);
    }
  });
  return chain;
}

const KEYMAP = {
  arrowup: "n", w: "n", arrowdown: "s", s: "s", arrowleft: "w", a: "w", arrowright: "e", d: "e",
};

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (V && V.battle) {
    if (k === "1" || k === " ") { e.preventDefault(); run("attack"); }
    else if (k === "2") run("special");
    else if (k === "3") run("use potion");
    else if (k === "4") run("flee");
    return;
  }
  if (KEYMAP[k]) { e.preventDefault(); run(KEYMAP[k]); }
  else if (k === "e") run("mine");
  else if (k === "i") { tab = "inv"; renderTabs(); renderPanel(); }
  else if (k === "f") { tab = "forge"; renderTabs(); renderPanel(); }
  else if (k === "q") { tab = "quests"; renderTabs(); renderPanel(); }
  else if (k === "k") { tab = "skills"; renderTabs(); renderPanel(); }
});

// ------------------------------------------------------------ backends
async function serverAvailable() {
  try { return (await fetch("api/ping", { cache: "no-store" })).ok; }
  catch (e) { return false; }
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
}

async function setupPyodide() {
  modeEl.textContent = "offline mode (Pyodide, saved in this browser)";
  addLog("Loading the Python engine in your browser (first time takes a moment)...");
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PYODIDE_URL; s.onload = resolve;
    s.onerror = () => reject(new Error("could not load Pyodide"));
    document.head.appendChild(s);
  });
  const py = await loadPyodide();
  py.FS.mkdirTree("/home/pyodide/slimeforge");
  for (const f of PY_FILES) {
    py.FS.writeFile("/home/pyodide/slimeforge/" + f, await (await fetch("slimeforge/" + f)).text());
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')\nfrom slimeforge.engine import Game\n");
  let saved = null;
  try { saved = localStorage.getItem("slimeforge-save"); } catch (e) {}
  if (saved) { py.globals.set("saved", saved); py.runPython("game = Game.loads(saved)"); }
  else py.runPython("game = Game()");
  send = async (cmd) => {
    py.globals.set("cmd", cmd);
    const out = py.runPython("game.handle(cmd)");
    const view = JSON.parse(py.runPython("__import__('json').dumps(game.view())"));
    return { out, view };
  };
  saveNow = async () => {
    const data = py.runPython("game.dumps()");
    try { localStorage.setItem("slimeforge-save", data); } catch (e) {}
  };
}

(async function main() {
  token = getToken();
  requestAnimationFrame(render);
  try {
    if (await serverAvailable()) await setupServer();
    else await setupPyodide();
  } catch (e) {
    addLog("Could not start: " + e.message);
    return;
  }
  addLog("Welcome to Slime Forge! Walk with WASD or the arrow keys.");
  await run("status");
})();
