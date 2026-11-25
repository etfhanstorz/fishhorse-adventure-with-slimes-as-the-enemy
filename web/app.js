// Slime Forge 2D front-end: draws the world on a canvas and sends player
// actions to the engine. Mode 1 (server/Tailscale) posts to api/cmd.
// Mode 2 (GitHub Pages) runs the same Python engine in the browser via Pyodide.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
const PY_FILES = ["__init__.py", "art.py", "engine.py"];
const T = 32;                       // tile size in logical px
const COLS = 24, ROWS = 12;         // map size (matches engine)
const HUD_H = 48;                   // strip under the map
const CW = COLS * T, CH = ROWS * T + HUD_H;
// Draw at 1920x1080 for a sharp 1080p picture; layout stays in CW x CH units.
const OUT_W = 1920, OUT_H = 1080;
const SCALE = Math.min(OUT_W / CW, OUT_H / CH);

const SLIME_COLOR = { green: "#5ccc4a", blue: "#4a90e2", red: "#e2544a", black: "#3a3a52", king: "#ffb703" };
const SLIME_DARK = { green: "#2f8a2a", blue: "#2c63b0", red: "#a52e26", black: "#15151f", king: "#b76e00" };
const SLIME_GLOW = { green: "#b6ff9e", blue: "#9ed0ff", red: "#ffb0a8", black: "#8b8bff", king: "#fff1b0" };
const ORE_COLOR = { copper: "#cd7f32", iron: "#a9b4c2", silver: "#e5e7eb",
                    steel: "#7f8ea3", mithril: "#7ad7f0", obsidian: "#8d6bd6" };
const BATTLE_SKY = { T: ["#2f6b3a", "#9ad99a"], C: ["#1c1820", "#4a3f52"], N: ["#2a1038", "#8e4bb0"],
                     default: ["#7ec8ff", "#d7f1ff"] };

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
canvas.width = OUT_W; canvas.height = OUT_H;

const $ = (id) => document.getElementById(id);
const logEl = $("log"), panelEl = $("panel"), tabsEl = $("tabs"), padEl = $("pad"), modeEl = $("mode");

let V = null;                 // latest view from the engine
let tab = "inv";
let send = null;              // async (cmd) => {out, view, bar}
let saveNow = async () => {};
let token;
let chain = Promise.resolve();

// animation state
let fx = [];                  // floating text and particles
let lastFrame = 0;
let walkUntil = 0, facing = 1;
let hurtUntil = 0, heroHurtUntil = 0, deathFlash = 0, levelBanner = null;
let prevEnemyHp = null, prevEnemyColor = null, prevHeroHp = null;
let mineFlashUntil = 0;
let catLungeUntil = 0, catX = null, catY = null, lastPos = null, prevCatHp = null;
const FUR = { orange: ["#f29b38", "#c9731f"], gray: ["#9aa0a6", "#6b7078"], black: ["#2b2b30", "#111115"],
              white: ["#f5f5f5", "#c9c9d0"], calico: ["#f0b27a", "#2b2b30"] };

// ------------------------------------------------------------ helpers
function hash(x, y) { return (((x + 7) * 73856093) ^ ((y + 3) * 19349663)) >>> 0; }
function rnd(seed) { return ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1; }

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
  return el("button", { class: cls, text: label, disabled, on: ["click", () => run(cmd)] });
}

function addLog(text) {
  if (!text) return;
  for (const line of text.split("\n")) {
    let cls = "";
    if (/defeat|Victory|LEVEL UP|Quest done|Quest complete|Loot|forged/i.test(line)) cls = "me";
    else if (/hits you|lost|can't|too weak|Unknown|fail|no |Not |need/i.test(line)) cls = "warn";
    logEl.append(el("span", { class: cls, text: line + "\n" }));
  }
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

// ------------------------------------------------------------ effects
function spawnText(text, x, y, color = "#fff", size = 22, life = 1) {
  fx.push({ kind: "text", text, x, y, vy: -0.9, life, color, size });
}
function spawnSparks(x, y, color, n = 10, speed = 3) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random());
    fx.push({ kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2, life: 1, color });
  }
}
function updateFx(dt) {
  for (const p of fx) {
    p.life -= dt * (p.kind === "text" ? 0.8 : 1.6);
    if (p.kind === "text") p.y += p.vy * 60 * dt;
    else { p.x += p.vx * 60 * dt; p.y += p.vy * 60 * dt; p.vy += 12 * dt; }
  }
  fx = fx.filter(p => p.life > 0);
}
function drawFx() {
  for (const p of fx) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    if (p.kind === "text") {
      ctx.font = `bold ${p.size}px Segoe UI, sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y);
    } else {
      ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 3, 3);
    }
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ tiles
function drawGrass(px, py, h) {
  const g = ctx.createLinearGradient(px, py, px, py + T);
  g.addColorStop(0, "#6cc553"); g.addColorStop(1, "#4fa63f");
  ctx.fillStyle = g; ctx.fillRect(px, py, T, T);
  ctx.fillStyle = "#3f8f34";
  for (let i = 0; i < 3; i++) {
    const sx = px + (((h >> (i * 5)) & 31) % (T - 6)) + 2;
    const sy = py + (((h >> (i * 5 + 2)) & 31) % (T - 6)) + 2;
    ctx.beginPath(); ctx.moveTo(sx, sy + 3); ctx.lineTo(sx + 2, sy); ctx.lineTo(sx + 4, sy + 3); ctx.fill();
  }
  if ((h & 15) === 0) {  // flower
    ctx.fillStyle = (h & 16) ? "#ffe066" : "#ff7aa2";
    ctx.beginPath(); ctx.arc(px + 8 + ((h >> 6) & 15), py + 8 + ((h >> 10) & 15), 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function drawTile(ch, x, y, time) {
  const px = x * T, py = y * T, h = hash(x, y);
  switch (ch) {
    case "~": {
      const g = ctx.createLinearGradient(px, py, px, py + T);
      g.addColorStop(0, "#3d8be0"); g.addColorStop(1, "#245fa8");
      ctx.fillStyle = g; ctx.fillRect(px, py, T, T);
      ctx.strokeStyle = "rgba(190,230,255,0.8)"; ctx.lineWidth = 2;
      const off = Math.sin(time / 500 + x) * 3;
      ctx.beginPath(); ctx.moveTo(px + 4, py + 12 + off); ctx.quadraticCurveTo(px + 10, py + 8 + off, px + 16, py + 12 + off);
      ctx.quadraticCurveTo(px + 22, py + 16 + off, px + 28, py + 12 + off); ctx.stroke();
      return;
    }
    case "^": {
      ctx.fillStyle = "#5a606b"; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = "#7d8593";
      ctx.beginPath(); ctx.moveTo(px - 2, py + T); ctx.lineTo(px + T / 2, py + 3); ctx.lineTo(px + T + 2, py + T); ctx.fill();
      ctx.fillStyle = "#4b515c";
      ctx.beginPath(); ctx.moveTo(px + T / 2, py + 3); ctx.lineTo(px + T + 2, py + T); ctx.lineTo(px + T / 2 + 3, py + T); ctx.fill();
      ctx.fillStyle = "#eef4fb";
      ctx.beginPath(); ctx.moveTo(px + T / 2 - 6, py + 11); ctx.lineTo(px + T / 2, py + 3); ctx.lineTo(px + T / 2 + 6, py + 11); ctx.fill();
      return;
    }
    case "C": {
      ctx.fillStyle = "#3f3128"; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = "#24191a";
      ctx.beginPath(); ctx.ellipse(px + T / 2, py + T / 2 + 2, 12, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5b4a3f";
      ctx.beginPath(); ctx.moveTo(px + 6, py + 2); ctx.lineTo(px + 9, py + 8); ctx.lineTo(px + 12, py + 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px + 24, py + 2); ctx.lineTo(px + 21, py + 8); ctx.lineTo(px + 18, py + 2); ctx.fill();
      const glint = 0.5 + 0.5 * Math.sin(time / 300 + h);
      ctx.fillStyle = `rgba(255,209,102,${0.5 + glint * 0.5})`;
      ctx.fillRect(px + 8 + (h % 10), py + 20 + (h % 4), 3, 3);
      ctx.fillRect(px + 20 - (h % 6), py + 24 + (h % 3), 2, 2);
      return;
    }
    case "N": {
      const g = ctx.createRadialGradient(px + 16, py + 20, 4, px + 16, py + 16, 22);
      g.addColorStop(0, "#c77ddb"); g.addColorStop(1, "#4b1f63");
      ctx.fillStyle = g; ctx.fillRect(px, py, T, T);
      const pulse = 0.6 + 0.4 * Math.sin(time / 350 + x);
      ctx.fillStyle = `rgba(255,200,255,${pulse})`;
      ctx.beginPath(); ctx.arc(px + 16, py + 17, 5 + pulse * 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e7b5ff";
      ctx.beginPath(); ctx.arc(px + 9 + (h % 14), py + 24, 3, 0, Math.PI * 2); ctx.fill();
      return;
    }
    case "V": {
      drawGrass(px, py, h);
      ctx.fillStyle = "#c8a673"; ctx.fillRect(px + 13, py + 22, 6, 10);  // path
      ctx.fillStyle = "#f4dfae"; ctx.fillRect(px + 6, py + 13, 20, 14);
      ctx.fillStyle = "#e8cc92"; ctx.fillRect(px + 6, py + 24, 20, 3);
      ctx.fillStyle = "#c0392b"; ctx.beginPath();
      ctx.moveTo(px + 3, py + 14); ctx.lineTo(px + 16, py + 3); ctx.lineTo(px + 29, py + 14); ctx.fill();
      ctx.fillStyle = "#8b1e14"; ctx.fillRect(px + 16, py + 4, 2, 6);
      ctx.fillStyle = "#6b4423"; ctx.fillRect(px + 14, py + 19, 5, 8);
      ctx.fillStyle = "#4cc9f0"; ctx.fillRect(px + 8, py + 16, 4, 4); ctx.fillRect(px + 21, py + 16, 4, 4);
      return;
    }
    case "T": {
      drawGrass(px, py, h);
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.beginPath(); ctx.ellipse(px + 16, py + 28, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#6b4423"; ctx.fillRect(px + 14, py + 18, 4, 10);
      ctx.fillStyle = "#2a6b2e"; ctx.beginPath(); ctx.arc(px + 16, py + 13, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3f9a45"; ctx.beginPath(); ctx.arc(px + 13, py + 10, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#63b869"; ctx.beginPath(); ctx.arc(px + 11, py + 8, 2.5, 0, Math.PI * 2); ctx.fill();
      return;
    }
    default:
      drawGrass(px, py, h);
  }
}

// ------------------------------------------------------------ sprites
function drawShadow(cx, cy, rx) {
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, rx * 0.25, 0, 0, Math.PI * 2); ctx.fill();
}

function drawWeapon(w, hx, hy) {
  // hand at (hx, hy) in hero-local units; shape depends on weapon type
  const c = ORE_COLOR[w.material] || "#ccc";
  ctx.save(); ctx.translate(hx, hy); ctx.rotate(-0.6);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 2;
  switch (w.type) {
    case "spear": ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -26); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2, -26); ctx.lineTo(0, -32); ctx.lineTo(2, -26); ctx.fill(); break;
    case "axe": case "halberd":
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(7, -24); ctx.lineTo(7, -14); ctx.closePath(); ctx.fill(); break;
    case "mace": ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -16); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -20, 5, 0, Math.PI * 2); ctx.fill(); break;
    case "bow": ctx.strokeStyle = "#8b5a2b"; ctx.beginPath(); ctx.arc(-4, -8, 12, -1.2, 1.2); ctx.stroke(); break;
    case "dagger": ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -12); ctx.stroke(); break;
    case "scythe": ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -24); ctx.stroke();
      ctx.beginPath(); ctx.arc(-2, -24, 9, -0.2, 1.6); ctx.stroke(); break;
    default: // sword
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -22); ctx.stroke();
      ctx.fillStyle = "#6b4423"; ctx.fillRect(-4, -1, 8, 3);
  }
  ctx.restore();
}

function drawHero(px, py, scale = 1, time = 0, moving = false) {
  const bob = moving ? Math.abs(Math.sin(time / 70)) * -2 : Math.sin(time / 500) * -0.6;
  ctx.save();
  ctx.translate(px, py); ctx.scale(scale, scale);
  if (facing < 0) { ctx.translate(16, 0); ctx.scale(-1, 1); ctx.translate(-16, 0); }
  drawShadow(16, 30, 9);
  ctx.translate(0, bob);
  // legs (alternate while walking)
  const step = moving ? Math.sin(time / 70) * 2 : 0;
  ctx.fillStyle = "#4a2f16";
  ctx.fillRect(10, 24, 4, 6 + step); ctx.fillRect(18, 24, 4, 6 - step);
  // body with tunic shading
  ctx.fillStyle = "#2d7ff9"; ctx.fillRect(8, 13, 16, 13);
  ctx.fillStyle = "#1d5fd0"; ctx.fillRect(8, 20, 16, 6);
  ctx.fillStyle = "#ffd166"; ctx.fillRect(15, 13, 2, 13);           // belt stripe
  // arms
  ctx.fillStyle = "#ffd7a8"; ctx.fillRect(5, 15, 3, 8); ctx.fillRect(24, 15, 3, 8);
  // head
  ctx.fillStyle = "#ffd7a8"; ctx.beginPath(); ctx.arc(16, 10, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#7a4a1f"; ctx.fillRect(8, 2, 16, 4); ctx.fillRect(10, 0, 12, 3);     // hat
  ctx.fillStyle = "#1b2233";
  const blink = (time % 3200) < 120;
  if (blink) ctx.fillRect(12, 10, 3, 1), ctx.fillRect(18, 10, 3, 1);
  else { ctx.fillRect(12, 9, 2, 2); ctx.fillRect(18, 9, 2, 2); }
  ctx.fillStyle = "#c46a4a"; ctx.fillRect(14, 13, 4, 1);
  const w = V && V.weapons ? V.weapons.find(x => x.id === V.equipped) : null;
  if (w) drawWeapon(w, 26, 19);
  ctx.restore();
}

function drawCat(x, y, scale, c, time, flip = false) {
  const [main, dark] = FUR[c.fur] || FUR.orange;
  const knocked = c.hp <= 0;
  const bob = knocked ? 0 : Math.sin(time / 300) * -1;
  ctx.save();
  ctx.translate(x, y); ctx.scale(scale, scale);
  if (flip) { ctx.translate(16, 0); ctx.scale(-1, 1); ctx.translate(-16, 0); }
  drawShadow(16, 24, 10);
  ctx.translate(0, bob);
  // tail
  ctx.strokeStyle = dark; ctx.lineWidth = 3; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(6, 18); ctx.quadraticCurveTo(-2, 14, 3, 8 + Math.sin(time / 200) * 2); ctx.stroke();
  ctx.lineCap = "butt";
  // body, legs, head, ears
  ctx.fillStyle = main;
  ctx.beginPath(); ctx.ellipse(16, 18, 10, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = dark; ctx.fillRect(9, 22, 3, 4); ctx.fillRect(19, 22, 3, 4);
  ctx.fillStyle = main;
  ctx.beginPath(); ctx.arc(24, 12, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(19, 8); ctx.lineTo(20, 2); ctx.lineTo(23, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(25, 7); ctx.lineTo(28, 2); ctx.lineTo(29, 8); ctx.fill();
  if (c.fur === "calico") {
    ctx.fillStyle = "#2b2b30";
    ctx.beginPath(); ctx.ellipse(12, 16, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(27, 9, 2, 0, Math.PI * 2); ctx.fill();
  }
  // eyes
  if (knocked) {
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(21, 10); ctx.lineTo(23, 12); ctx.moveTo(23, 10); ctx.lineTo(21, 12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(25, 10); ctx.lineTo(27, 12); ctx.moveTo(27, 10); ctx.lineTo(25, 12); ctx.stroke();
  } else {
    const blink = (time % 4000) < 120;
    ctx.fillStyle = "#7fe08a";
    if (blink) { ctx.fillRect(21, 11, 3, 1); ctx.fillRect(25, 11, 3, 1); }
    else {
      ctx.beginPath(); ctx.ellipse(22, 11, 1.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(27, 11, 1.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = "#ff8fa3"; ctx.fillRect(24.5, 14, 2, 1.2);
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(30, 13); ctx.lineTo(36, 12); ctx.moveTo(30, 14.5); ctx.lineTo(36, 15); ctx.stroke();
  ctx.restore();
}

function drawSlime(cx, cy, color, time, hurt, shadowW = 62) {
  const beat = Math.sin(time / 230);
  const squash = hurt ? 0.25 : 0.08;
  const sx = 1 + beat * squash, sy = 1 - beat * squash;
  drawShadow(cx, cy + 58 - beat * 3, shadowW - beat * 4);
  ctx.save();
  ctx.translate(cx, cy + 40); ctx.scale(sx, sy); ctx.translate(-cx, -(cy + 40));
  const base = SLIME_COLOR[color], dark = SLIME_DARK[color], glow = SLIME_GLOW[color];
  const g = ctx.createRadialGradient(cx - 22, cy - 34, 8, cx, cy, 82);
  g.addColorStop(0, glow); g.addColorStop(0.35, base); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  // blob with a wobbling bottom edge
  ctx.beginPath();
  ctx.moveTo(cx - 72, cy + 40);
  ctx.bezierCurveTo(cx - 74, cy - 60, cx + 74, cy - 60, cx + 72, cy + 40);
  for (let i = 0; i <= 8; i++) {
    const x = cx + 72 - i * 18;
    ctx.lineTo(x, cy + 40 + Math.sin(time / 180 + i) * 4);
  }
  ctx.closePath(); ctx.fill();
  // gloss
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath(); ctx.ellipse(cx - 30, cy - 30, 14, 8, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 36, cy - 14, 4, 0, Math.PI * 2); ctx.fill();
  // eyes (blink)
  const blink = (time % 2900) < 110;
  ctx.fillStyle = "#fff";
  if (!blink) {
    ctx.beginPath(); ctx.ellipse(cx - 24, cy - 4, 14, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 24, cy - 4, 14, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111";
    const look = hurt ? 0 : Math.sin(time / 900) * 3;
    ctx.beginPath(); ctx.arc(cx - 22 + look, cy - 2 + (hurt ? 3 : 0), 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 26 + look, cy - 2 + (hurt ? 3 : 0), 6, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "#111"; ctx.fillRect(cx - 36, cy - 4, 24, 3); ctx.fillRect(cx + 12, cy - 4, 24, 3);
  }
  // mouth
  ctx.strokeStyle = "#111"; ctx.lineWidth = 3; ctx.beginPath();
  if (hurt) ctx.arc(cx, cy + 28, 9, Math.PI * 1.1, Math.PI * 1.9);
  else ctx.arc(cx, cy + 20, 11, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  // king crown
  if (color === "king") {
    ctx.fillStyle = "#ffd166"; ctx.strokeStyle = "#b76e00"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy - 46); ctx.lineTo(cx - 30, cy - 72); ctx.lineTo(cx - 14, cy - 56);
    ctx.lineTo(cx, cy - 78); ctx.lineTo(cx + 14, cy - 56); ctx.lineTo(cx + 30, cy - 72);
    ctx.lineTo(cx + 30, cy - 46); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawBar(x, y, w, h, ratio, color, label) {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 3, y - 3, w + 6, h + 6, 6) : ctx.rect(x - 3, y - 3, w + 6, h + 6); ctx.fill();
  ctx.fillStyle = "#2b2f40"; ctx.fillRect(x, y, w, h);
  const r = Math.max(0, Math.min(1, ratio));
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = g; ctx.fillRect(x, y, r * w, h);
  ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(x, y, r * w, h / 3);
  if (label) {
    ctx.fillStyle = "#fff"; ctx.font = "bold 14px Segoe UI, sans-serif";
    ctx.fillText(label, x, y - 8);
  }
}

// ------------------------------------------------------------ scenes
function drawMap(time) {
  // ground
  ctx.fillStyle = "#0b0f1a"; ctx.fillRect(0, 0, CW, CH);
  const explored = new Set(V.explored.map(([x, y]) => x + "," + y));
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (explored.has(x + "," + y)) drawTile(V.grid[y][x], x, y, time);
      else {
        ctx.fillStyle = "#0b0f1a"; ctx.fillRect(x * T, y * T, T, T);
        ctx.fillStyle = "rgba(255,255,255,0.03)"; ctx.fillRect(x * T + 14, y * T + 14, 2, 2);
      }
    }
  }
  // soft darkening at map edges
  const vg = ctx.createRadialGradient(CW / 2, ROWS * T / 2, 200, CW / 2, ROWS * T / 2, CW * 0.6);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vg; ctx.fillRect(0, 0, CW, ROWS * T);

  const [px, py] = V.pos;
  const moving = time < walkUntil;
  if (V.cat && catX !== null) drawCat(catX * T - 6, catY * T + 2, 0.8, V.cat, time, facing < 0);
  drawHero(px * T + 0, py * T - 2, 1, time, moving);

  // HUD strip
  ctx.fillStyle = "#0b1020"; ctx.fillRect(0, ROWS * T, CW, HUD_H);
  ctx.fillStyle = "#eef2ff"; ctx.font = "bold 14px Segoe UI, sans-serif";
  ctx.fillText(`${V.tile_names[V.tile] || ""}  ·  mining tier ${V.mining_tier}`, 12, ROWS * T + 20);
  ctx.fillStyle = "#9aa6c7"; ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillText("Walk over ^ mountains or C caves and press E to mine. V = village. King slimes lurk in purple nests.", 12, ROWS * T + 38);
}

function drawBattleBackdrop(tile, time) {
  const [top, bottom] = BATTLE_SKY[tile] || BATTLE_SKY.default;
  const sky = ctx.createLinearGradient(0, 0, 0, 300);
  sky.addColorStop(0, top); sky.addColorStop(1, bottom);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, CW, ROWS * T);
  // hills
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath(); ctx.moveTo(0, 280); ctx.quadraticCurveTo(200, 230, 420, 280); ctx.quadraticCurveTo(600, 320, 768, 260); ctx.lineTo(768, 384); ctx.lineTo(0, 384); ctx.fill();
  // ground
  const gg = ctx.createLinearGradient(0, 300, 0, 384);
  gg.addColorStop(0, tile === "C" ? "#3d2e28" : tile === "N" ? "#4a2360" : "#6fbf5a");
  gg.addColorStop(1, tile === "C" ? "#1f1614" : tile === "N" ? "#2a1038" : "#4a9a3a");
  ctx.fillStyle = gg; ctx.fillRect(0, 300, CW, ROWS * T - 300);
  // drifting clouds or cave dust
  ctx.fillStyle = tile === "C" ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.6)";
  for (let i = 0; i < 4; i++) {
    const x = ((time / 40 + i * 230) % (CW + 120)) - 60;
    ctx.beginPath(); ctx.ellipse(x, 60 + i * 12, 36, 12, 0, 0, Math.PI * 2); ctx.fill();
  }
}

function drawBattle(time) {
  const b = V.battle;
  const tile = V.tile;
  drawBattleBackdrop(tile, time);
  const heroHurt = time < heroHurtUntil;
  drawHero(120, 110, 3, time, false);
  if (heroHurt) { ctx.fillStyle = "rgba(255,80,80,0.25)"; ctx.beginPath(); ctx.arc(150, 150, 60, 0, Math.PI * 2); ctx.fill(); }
  drawBar(60, 104, 200, 16, V.hp / V.max_hp, "#ef476f", `You  ${V.hp}/${V.max_hp}`);
  if (V.cat) {
    const lunge = time < catLungeUntil ? 26 : 0;
    drawCat(232 + lunge, 150, 2.6, V.cat, time);
    drawBar(200, 252, 130, 12, V.cat.hp / V.cat.max_hp, "#f7a072",
            `${V.cat.name} Lv${V.cat.level}  ${V.cat.hp}/${V.cat.max_hp}`);
  }

  const hurt = time < hurtUntil;
  const shakeX = hurt ? (Math.random() - 0.5) * 10 : 0;
  drawSlime(520 + shakeX, 200, b.color, time, hurt, b.color === "king" ? 78 : 62);
  drawBar(420, 110, 220, 16, b.hp / b.max, SLIME_COLOR[b.color], `${b.color} slime  ${Math.max(0, b.hp)}/${b.max}`);

  // status line
  ctx.fillStyle = "#0b1020"; ctx.fillRect(0, ROWS * T, CW, HUD_H);
  ctx.fillStyle = "#eef2ff"; ctx.font = "13px Segoe UI, sans-serif";
  const w = V.weapons.find(x => x.id === V.equipped);
  const special = w ? V.weapon_types[w.type].special : "none";
  ctx.fillText(`Weapon: ${w ? w.name : "fists"}   Special: ${special}` +
               (V.cool > 0 ? `  (ready in ${V.cool})` : "  (ready)"), 12, ROWS * T + 20);
  ctx.fillStyle = "#9aa6c7";
  ctx.fillText("Keys: 1 attack   2 special   3 potion   4 flee", 12, ROWS * T + 38);
}

function drawLevelBanner(time) {
  if (!levelBanner) return;
  const age = (time - levelBanner.t) / 1000;
  if (age > 2.2) { levelBanner = null; return; }
  const scale = age < 0.25 ? age / 0.25 : 1;
  ctx.save();
  ctx.globalAlpha = age > 1.8 ? 1 - (age - 1.8) / 0.4 : 1;
  ctx.translate(CW / 2, ROWS * T / 2 - 40); ctx.scale(scale, scale);
  ctx.textAlign = "center";
  ctx.font = "bold 44px Segoe UI, sans-serif";
  ctx.lineWidth = 6; ctx.strokeStyle = "#000"; ctx.strokeText(levelBanner.text, 0, 0);
  ctx.fillStyle = "#ffd166"; ctx.fillText(levelBanner.text, 0, 0);
  ctx.restore();
}

function render(time) {
  const dt = Math.min(0.05, (time - lastFrame) / 1000 || 0);
  lastFrame = time;
  updateFx(dt);
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  if (V) {
    if (V.battle) drawBattle(time);
    else drawMap(time);
    drawFx();
    drawLevelBanner(time);
  } else {
    ctx.fillStyle = "#0b0f1a"; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = "#eef2ff"; ctx.font = "20px Segoe UI, sans-serif";
    ctx.fillText("Loading...", 20, 40);
  }
  if (deathFlash > 0) {
    ctx.fillStyle = `rgba(200,30,40,${deathFlash * 0.5})`; ctx.fillRect(0, 0, CW, CH);
    deathFlash = Math.max(0, deathFlash - dt * 0.8);
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

let tabsKey = "";
function renderTabs() {
  const key = tab;
  if (key === tabsKey && tabsEl.childNodes.length) return;
  tabsKey = key;
  tabsEl.innerHTML = "";
  const list = [["inv", "Inventory (I)"], ["forge", "Forge (F)"], ["quests", "Quests (Q)"], ["skills", "Skills (K)"]];
  for (const [id, label] of list) {
    tabsEl.append(el("button", {
      class: "btn" + (tab === id ? " on" : ""), text: label,
      on: ["click", () => { tab = id; tabsKey = ""; renderPanel(); renderTabs(); }],
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
    if (V.cat) {
      const c = V.cat;
      panelEl.append(el("div", { class: "item" }, [
        el("div", { style: "font-weight:700;color:#ffd166", text: `Pet: ${c.name} the ${c.fur} cat · Lv ${c.level}` }),
        el("div", { class: "muted", text: `HP ${c.hp}/${c.max_hp} · Attack ${c.atk} · XP ${c.xp}/${12 * c.level}` }),
        el("div", { class: "row" }, [
          button("Heal cat (potion)", "use potion cat", "btn", V.potions <= 0),
        ]),
      ]));
    } else {
      panelEl.append(el("div", { class: "item" }, [
        el("div", { class: "muted", text: "No pet yet. A cat follows you and fights beside you." }),
        button("Buy a cat (60 gold)", "buy cat", "btn", !inVillage || V.gold < 60),
      ]));
    }
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
          w.id === V.equipped ? el("span", { class: "pill", text: "equipped" }) : button("Equip", `equip ${w.id}`),
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
      const pct = Math.round(100 * q.have / q.target);
      panelEl.append(el("div", { class: "item" }, [
        el("div", { text: q.text, style: "font-weight:600" }),
        el("div", { style: "height:8px;background:#2b2f40;border-radius:4px;margin:6px 0;overflow:hidden" }, [
          el("div", { style: `height:100%;width:${pct}%;background:linear-gradient(90deg,#06d6a0,#4cc9f0)` }),
        ]),
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

// Compare the old and new state and create effects for what just happened.
function reactTo(view, out, prevHp, nowT) {
  const b = view.battle;
  const heroX = 120, heroY = 90, slimeX = 520, slimeY = 150;
  if (prevEnemyColor && b && b.color === prevEnemyColor && prevEnemyHp !== null && b.hp < prevEnemyHp) {
    const dmg = prevEnemyHp - b.hp;
    hurtUntil = nowT + 280;
    const crit = /Critical/.test(out);
    spawnText(`-${dmg}`, slimeX + (Math.random() * 60 - 30), slimeY, crit ? "#ffd166" : "#ffffff", crit ? 34 : 24);
    if (crit) spawnText("CRIT!", slimeX, slimeY - 50, "#ffd166", 22);
    spawnSparks(slimeX, 200, crit ? "#ffd166" : SLIME_GLOW[b.color] || "#fff", crit ? 22 : 12, 4);
  }
  if (b && prevHp !== null && view.hp < prevHp) {
    heroHurtUntil = nowT + 280;
    spawnText(`-${prevHp - view.hp}`, heroX + 40, heroY, "#ff6b8a", 24);
  } else if (prevHp !== null && view.hp > prevHp && b) {
    spawnText(`+${view.hp - prevHp}`, heroX + 40, heroY, "#06d6a0", 22);
  }
  if (/pounces/.test(out)) catLungeUntil = nowT + 260;
  if (/knocked out/.test(out)) spawnText("KO!", 250, 120, "#ff6b8a", 30);
  if (view.cat && prevCatHp !== null && view.cat.hp < prevCatHp && b) {
    spawnText(`-${prevCatHp - view.cat.hp}`, 250, 130, "#ffb3d1", 22);
  }
  if (/You dig up/.test(out)) {
    mineFlashUntil = nowT + 200;
    const [px, py] = view.pos;
    spawnSparks(px * T + T / 2, py * T + T / 2, "#ffd166", 14, 3);
    const m = out.match(/dig up \d+ (\w+) ore/);
    if (m) spawnText(`+ ${m[1]} ore`, px * T + T / 2 - 30, py * T - 4, ORE_COLOR[m[1]] || "#fff", 16);
  }
  if (/defeated the/.test(out)) {
    spawnSparks(slimeX, 200, "#ffffff", 30, 5);
    spawnSparks(slimeX, 200, SLIME_COLOR[prevEnemyColor] || "#ffd166", 20, 4);
  }
  if (/LEVEL UP/.test(out)) {
    const m = out.match(/level (\d+)/);
    levelBanner = { t: nowT, text: "LEVEL " + (m ? m[1] : "UP") + "!" };
    spawnSparks(CW / 2, ROWS * T / 2, "#ffd166", 30, 5);
  }
  if (/wake up in the village/.test(out)) {
    deathFlash = 1;
    walkUntil = 0;
  }
  if (/Quest complete|Quest done/.test(out)) spawnSparks(CW / 2, ROWS * T / 2, "#06d6a0", 24, 4);
}

function applyView(view, out) {
  const now = performance.now();
  reactTo(view, out || "", prevHeroHp, now);
  const np = view.pos;
  if (!lastPos) { catX = np[0]; catY = np[1]; }
  else if (lastPos[0] !== np[0] || lastPos[1] !== np[1]) { catX = lastPos[0]; catY = lastPos[1]; }
  lastPos = np;
  prevCatHp = view.cat ? view.cat.hp : null;
  prevEnemyHp = view.battle ? view.battle.hp : null;
  prevEnemyColor = view.battle ? view.battle.color : null;
  prevHeroHp = view.hp;
  V = view;
  renderStats();
  renderPad();
  renderPanel();
  renderTabs();
}

// ------------------------------------------------------------ commands
function run(cmd) {
  if (!cmd || !cmd.trim()) return;
  if (["n", "s", "e", "w"].includes(cmd.trim()) || /^move/.test(cmd)) {
    walkUntil = performance.now() + 320;
    if (cmd.trim() === "w") facing = -1;
    if (cmd.trim() === "e") facing = 1;
  }
  chain = chain.then(async () => {
    try {
      const res = await send(cmd);
      addLog(res.out);
      if (res.view) applyView(res.view, res.out);
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
  else if (k === "i") { tab = "inv"; tabsKey = ""; renderPanel(); renderTabs(); }
  else if (k === "f") { tab = "forge"; tabsKey = ""; renderPanel(); renderTabs(); }
  else if (k === "q") { tab = "quests"; tabsKey = ""; renderPanel(); renderTabs(); }
  else if (k === "k") { tab = "skills"; tabsKey = ""; renderPanel(); renderTabs(); }
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
