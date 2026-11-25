"""Slime Forge game engine.

Every command goes through Game.handle(line) and returns text, so the same
engine drives the terminal, the Tailscale web server and the GitHub Pages
build (via Pyodide).
"""
import json
import random

from . import art

MAP_W, MAP_H = 24, 12
DIRS = {"n": (0, -1), "s": (0, 1), "e": (1, 0), "w": (-1, 0)}
TILE_NAMES = {
    ".": "grassland", "T": "forest", "^": "rocky mountain", "C": "cave",
    "V": "village", "N": "slime nest", "~": "lake",
}
TILE_WEIGHTS = {".": 40, "T": 20, "^": 18, "~": 10}
MIN_TIER_FOR_TILE = {"^": 1, "C": 3}  # minimum ore tier per diggable tile

# name: (base damage, crit chance, (special name, hits, damage mult, effect))
WEAPON_TYPES = {
    "sword":   (6, 0.10, ("Riposte", 1, 2.0, "")),
    "spear":   (5, 0.12, ("Lunge", 1, 1.5, "crit")),
    "axe":     (8, 0.08, ("Cleave", 1, 1.5, "bleed")),
    "bow":     (5, 0.15, ("Volley", 3, 0.6, "")),
    "mace":    (7, 0.05, ("Crush", 1, 1.8, "stun")),
    "dagger":  (3, 0.25, ("Flurry", 2, 0.7, "")),
    "halberd": (10, 0.06, ("Sweep", 1, 1.4, "")),
    "scythe":  (7, 0.10, ("Reap", 1, 1.2, "heal")),
}
# material: (ore tier, damage multiplier)
MATERIALS = {
    "copper": (1, 1.0), "iron": (2, 1.3), "silver": (3, 1.5),
    "steel": (4, 1.8), "mithril": (5, 2.2), "obsidian": (6, 2.6),
}
# modifier: (damage multiplier, crit bonus)
MODS = {
    "Rusty": (0.85, 0.0), "Keen": (1.0, 0.08), "Heavy": (1.15, 0.0),
    "Ancient": (1.3, 0.0), "Jagged": (1.0, 0.05), "Cursed": (1.4, -0.03),
}
SUFFIXES = [
    "of Embers", "of Storms", "of the Deep", "of Ruin", "of the Slime Queen",
    "of Frost", "of Dawn", "of Echoes", "of Thorns", "of the Miner",
    "of Wolves", "of Ashes",
]
# color: stats at level 1
SLIMES = {
    "green": {"hp": 10, "atk": 2, "xp": 5, "gold": 3},
    "blue": {"hp": 18, "atk": 3, "xp": 9, "gold": 6},
    "red": {"hp": 28, "atk": 5, "xp": 15, "gold": 10},
    "black": {"hp": 45, "atk": 7, "xp": 28, "gold": 18},
}
ENCHANTS = {
    "sharpness": "+3 damage on every hit",
    "fire": "sets the slime on fire for 2 damage a turn",
    "frost": "20% chance to freeze the slime for a turn",
    "vampiric": "heals you for 10% of damage dealt",
    "lucky": "+50% gold from fights",
}
ENCHANT_GOLD = 30
ENCHANT_ESSENCE = 1
POTION_HEAL = 25
POTION_PRICE = 10

SKILLS = {
    "brawn":      {"cost": 1, "req": [], "desc": "+2 damage on every hit"},
    "toughness":  {"cost": 1, "req": [], "desc": "+10 max HP"},
    "keen":       {"cost": 1, "req": [], "desc": "+5% crit chance"},
    "greed":      {"cost": 1, "req": [], "desc": "+25% gold from slimes"},
    "miner1":     {"cost": 1, "req": [], "desc": "+1 mining tier"},
    "miner2":     {"cost": 2, "req": ["miner1"], "desc": "+1 mining tier"},
    "miner3":     {"cost": 3, "req": ["miner2"], "desc": "+1 mining tier, +1 ore per dig"},
    "smith":      {"cost": 2, "req": [], "desc": "forging costs 25% less gold"},
    "enchanter":  {"cost": 2, "req": ["smith"], "desc": "enchanting costs 25% less, +1 enchant slot"},
    "healer":     {"cost": 2, "req": ["toughness"], "desc": "rest fully heals, +3 HP per level up"},
    "berserker":  {"cost": 3, "req": ["brawn", "keen"], "desc": "+25% damage below half HP"},
    "tactician":  {"cost": 3, "req": ["keen"], "desc": "special moves recharge 1 turn faster"},
}
MINER_SKILLS = ("miner1", "miner2", "miner3")


class Game:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.grid = self._generate_map()
        self.pos = (MAP_W // 2, MAP_H // 2)
        self.explored = set()
        self._reveal()
        self.level = 1
        self.xp = 0
        self.max_hp = 30
        self.hp = 30
        self.gold = 25
        self.points = 0
        self.skills = []
        self.weapons = []
        self.equipped = None
        self.next_id = 1
        self.potions = 2
        self.ores = {}          # ore name -> count, bars are "<ore> bar"
        self.essence = 0
        self.kills = {}
        self.mined = {}
        self.forged = {}
        self.active = []        # accepted quests (max 3)
        self.board = [self._new_quest() for _ in range(3)]
        self.battle = None
        self.cool = 0

    # ------------------------------------------------------------------ save
    def to_dict(self):
        d = dict(self.__dict__)
        d.pop("rng")
        d["explored"] = sorted([list(t) for t in self.explored])
        d["pos"] = list(self.pos)
        return d

    @classmethod
    def from_dict(cls, d):
        g = cls.__new__(cls)
        g.rng = random.Random()
        data = dict(d)
        data["explored"] = {tuple(t) for t in data["explored"]}
        data["pos"] = tuple(data["pos"])
        g.__dict__.update(data)
        return g

    def dumps(self):
        return json.dumps(self.to_dict())

    @classmethod
    def loads(cls, text):
        return cls.from_dict(json.loads(text))

    # --------------------------------------------------------------- helpers
    def has(self, skill):
        return skill in self.skills

    def mining_tier(self):
        return 1 + sum(1 for s in MINER_SKILLS if self.has(s))

    def xp_needed(self):
        return int(25 * self.level ** 1.4)

    def weapon(self):
        return self.get_weapon(self.equipped)

    def get_weapon(self, wid):
        if wid is None:
            return None
        return next((w for w in self.weapons if w["id"] == wid), None)

    def tile(self, pos=None):
        x, y = pos or self.pos
        return self.grid[y][x]

    def bar(self):
        return (f"HP {self.hp}/{self.max_hp} | Lv {self.level} | "
                f"XP {self.xp}/{self.xp_needed()} | Gold {self.gold} | "
                f"{TILE_NAMES[self.tile()]}")

    def _generate_map(self):
        chars, weights = zip(*TILE_WEIGHTS.items())
        grid = [[self.rng.choices(chars, weights)[0] for _ in range(MAP_W)]
                for _ in range(MAP_H)]
        cx, cy = MAP_W // 2, MAP_H // 2
        for y in range(cy - 1, cy + 2):
            for x in range(cx - 1, cx + 2):
                grid[y][x] = "."
        grid[cy][cx] = "V"
        for ch, count in (("C", 3), ("N", 4)):
            placed = 0
            while placed < count:
                x, y = self.rng.randrange(MAP_W), self.rng.randrange(MAP_H)
                if abs(x - cx) <= 1 and abs(y - cy) <= 1:
                    continue
                if grid[y][x] != "V" and grid[y][x] not in "CN":
                    grid[y][x] = ch
                    placed += 1
        return ["".join(row) for row in grid]

    def _reveal(self):
        x0, y0 = self.pos
        for y in range(y0 - 2, y0 + 3):
            for x in range(x0 - 2, x0 + 3):
                if 0 <= x < MAP_W and 0 <= y < MAP_H:
                    self.explored.add((x, y))

    def _progress(self, kind, key, amount, out):
        for idx, q in enumerate(self.active, 1):
            if q["have"] >= q["target"]:
                continue
            if kind == "kill":
                match = q["kind"] == "kill_any" or (
                    q["kind"] == "kill_color" and q["key"] == key)
            else:
                match = q["kind"] == kind and q["key"] == key
            if match:
                q["have"] = min(q["target"], q["have"] + amount)
                if q["have"] >= q["target"]:
                    out.append(f"Quest complete: {q['text']}! "
                               f"Return to the village and 'claim {idx}'.")

    def _new_quest(self):
        kind = self.rng.choice(["kill_color", "mine", "forge", "kill_any"])
        key = None
        if kind == "kill_color":
            key = self.rng.choice(list(SLIMES))
            target = self.rng.randint(3, 6)
            text = f"Slay {target} {key} slimes"
        elif kind == "mine":
            key = self.rng.choice(["copper", "iron", "silver", "steel"])
            target = self.rng.randint(3, 6)
            text = f"Mine {target} {key} ore"
        elif kind == "forge":
            key = self.rng.choice(list(WEAPON_TYPES))
            target = self.rng.randint(1, 2)
            text = f"Forge {target} {key}(s)"
        else:
            target = self.rng.randint(8, 12)
            text = f"Defeat {target} slimes of any color"
        return {"kind": kind, "key": key, "target": target, "have": 0,
                "text": text, "gold": target * 8, "xp": target * 8}

    def generate_weapon(self, wtype, material, quality=None):
        if quality is None:
            quality = min(100, max(1, int(self.rng.triangular(1, 100, 35))))
        base, crit, _special = WEAPON_TYPES[wtype]
        mat_mult = MATERIALS[material][1]
        mod = self.rng.choice(list(MODS) + [""] * 4)
        mod_dmg, mod_crit = MODS.get(mod, (1.0, 0.0))
        damage = round(base * mat_mult * (0.6 + quality / 125) * mod_dmg, 1)
        crit_chance = round(crit + mod_crit + quality / 1000, 3)
        if quality < 30:
            rarity = "Crude"
        elif quality < 55:
            rarity = "Fine"
        elif quality < 75:
            rarity = "Superior"
        elif quality < 92:
            rarity = "Masterwork"
        else:
            rarity = "Legendary"
        suffix = self.rng.choice(SUFFIXES) if self.rng.random() < 0.5 else ""
        name = " ".join(p for p in (rarity, mod, material.title(),
                                    wtype.title(), suffix) if p)
        w = {"id": self.next_id, "type": wtype, "material": material,
             "mod": mod, "quality": quality, "damage": damage,
             "crit": crit_chance, "enchants": [],
             "slots": 1 + quality // 35, "name": name}
        self.next_id += 1
        return w

    def describe_weapon(self, w):
        ench = ", ".join(w["enchants"]) or "none"
        special = WEAPON_TYPES[w["type"]][2][0]
        return (f"  #{w['id']:<3} {w['name']}\n"
                f"       dmg {w['damage']}  crit {w['crit'] * 100:.1f}%  "
                f"special {special}  enchants [{ench}] "
                f"({len(w['enchants'])}/{w['slots'] + (1 if self.has('enchanter') else 0)})")

    # ------------------------------------------------------------ dispatch
    def handle(self, line):
        parts = line.strip().lower().split()
        if not parts:
            return ""
        cmd, args = parts[0], parts[1:]
        if cmd in ("go", "move") and args:
            cmd, args = args[0], args[1:]
        if cmd in ("north", "south", "east", "west"):
            cmd = cmd[0]
        try:
            out = self._dispatch(cmd, args)
        except (ValueError, IndexError, KeyError):
            out = ["Could not understand that. Type 'help'."]
        return "\n".join(out)

    def _dispatch(self, cmd, args):
        battle_cmds = {
            "attack": self.cmd_attack, "a": self.cmd_attack,
            "special": self.cmd_special, "sp": self.cmd_special,
            "flee": self.cmd_flee, "run": self.cmd_flee,
        }
        if cmd in ("n", "s", "e", "w"):
            return self.cmd_move(cmd)
        if self.battle and cmd not in battle_cmds and cmd not in (
                "use", "status", "help", "inv", "weapons", "bar"):
            return ["You are in a fight! attack, special, use potion, or flee."]
        if cmd in battle_cmds:
            if not self.battle:
                return ["There is no fight right now."]
            return battle_cmds[cmd]()
        if cmd == "use" and args[:1] == ["potion"]:
            return self.cmd_use_potion()
        if cmd == "use":
            return ["Use what? Try 'use potion'."]
        if cmd == "help":
            return [art.HELP, "", art.LEGEND]
        if cmd in ("status", "look"):
            return self.cmd_status()
        if cmd == "bar":
            return [self.bar()]
        if cmd == "map":
            return self.cmd_map()
        if cmd == "mine":
            return self.cmd_mine()
        if cmd == "inv":
            return self.cmd_inv()
        if cmd == "weapons":
            return self.cmd_weapons()
        if cmd == "equip":
            return self.cmd_equip(self._int(args))
        if cmd == "sell":
            return self.cmd_sell(self._int(args))
        if cmd == "smelt" and args:
            return self.cmd_smelt(args[0])
        if cmd == "forge" and len(args) >= 2:
            return self.cmd_forge(args[0], args[1])
        if cmd == "types":
            return self.cmd_types()
        if cmd == "materials":
            return [", ".join(f"{m} (tier {t})" for m, (t, _) in MATERIALS.items())]
        if cmd == "enchants":
            return [f"{k}: {v}" for k, v in ENCHANTS.items()]
        if cmd == "enchant" and len(args) >= 2:
            return self.cmd_enchant(int(args[0]), args[1])
        if cmd == "shop":
            return [f"Shop: potion (heal {POTION_HEAL}) costs {POTION_PRICE} gold. "
                    "Type 'buy potion'."]
        if cmd == "buy" and args[:1] == ["potion"]:
            return self.cmd_buy_potion()
        if cmd == "rest":
            return self.cmd_rest()
        if cmd == "board":
            return self.cmd_board()
        if cmd == "accept":
            return self.cmd_accept(self._int(args))
        if cmd == "quests":
            return self.cmd_quests()
        if cmd == "claim":
            return self.cmd_claim(self._int(args))
        if cmd == "skills":
            return self.cmd_skills()
        if cmd == "learn" and args:
            return self.cmd_learn(args[0])
        if cmd == "save":
            return ["Game saved."]
        return ["Unknown command. Type 'help'."]

    def _int(self, args):
        return int(args[0])

    def _at_village(self):
        return self.tile() == "V"

    # --------------------------------------------------------- exploration
    def cmd_move(self, d):
        if self.battle:
            return ["You are in a fight! Use attack, special, use potion, or flee."]
        dx, dy = DIRS[d]
        nx, ny = self.pos[0] + dx, self.pos[1] + dy
        if not (0 <= nx < MAP_W and 0 <= ny < MAP_H):
            return ["The edge of the world. Only void lies beyond."]
        tile = self.grid[ny][nx]
        if tile == "~":
            return ["A lake blocks the way."]
        self.pos = (nx, ny)
        self._reveal()
        out = [f"You walk {d}. You enter the {TILE_NAMES[tile]}."]
        rng = self.rng
        if tile == "V":
            out.append(art.VILLAGE)
            out.append("Village: shop, rest, board, accept, claim, smelt, forge, enchant.")
            return out
        if tile == "N":
            out += self._start_battle(rng.choices(["red", "black"], [7, 3])[0])
        elif tile == "C" and rng.random() < 0.35:
            out += self._start_battle("black")
        elif tile == "T" and rng.random() < 0.25:
            out += self._start_battle(rng.choices(["blue", "green"], [7, 3])[0])
        elif tile == "." and rng.random() < 0.18:
            weights = [65, 35] if self.level >= 3 else [100, 0]
            out += self._start_battle(rng.choices(["green", "blue"], weights)[0])
        return out

    def cmd_map(self):
        rows = []
        for y in range(MAP_H):
            row = ""
            for x in range(MAP_W):
                if (x, y) == self.pos:
                    row += "@"
                elif (x, y) in self.explored:
                    row += self.grid[y][x]
                else:
                    row += " "
            rows.append("|" + row + "|")
        border = "+" + "-" * MAP_W + "+"
        return [border] + rows + [border, art.LEGEND]

    def cmd_status(self):
        w = self.weapon()
        return [
            "=== Adventurer ===",
            f"Level {self.level}   XP {self.xp}/{self.xp_needed()}",
            f"HP {self.hp}/{self.max_hp}   Gold {self.gold}   Potions {self.potions}",
            f"Mining tier {self.mining_tier()}   Skill points {self.points}",
            f"Weapon: {w['name'] if w else 'none (fists)'}",
            f"Location: {TILE_NAMES[self.tile()]} at {self.pos}",
        ]

    # -------------------------------------------------------------- mining
    def cmd_mine(self):
        tile = self.tile()
        if tile not in MIN_TIER_FOR_TILE:
            return ["Nothing to mine here. Find a ^ mountain or a C cave."]
        tier = self.mining_tier()
        low = MIN_TIER_FOR_TILE[tile]
        cands = [o for o, (t, _) in MATERIALS.items() if low <= t <= tier]
        if not cands:
            return [f"Your pick (mining tier {tier}) is too weak for this rock. "
                    "Learn a mining skill."]
        ore = self.rng.choices(cands, [7 - MATERIALS[o][0] for o in cands])[0]
        n = 2 if self.has("miner3") else 1
        self.ores[ore] = self.ores.get(ore, 0) + n
        self.mined[ore] = self.mined.get(ore, 0) + n
        out = [art.PICKAXE, f"You dig up {n} {ore} ore."]
        self._progress("mine", ore, n, out)
        if tile == "C" and self.rng.random() < 0.3:
            out += self._start_battle("black")
        elif tile == "^" and self.rng.random() < 0.1:
            out += self._start_battle("green")
        return out

    def cmd_smelt(self, ore):
        if not self._at_village():
            return ["Smelt in the village furnace."]
        if ore not in MATERIALS:
            return ["Unknown ore. Try: " + ", ".join(MATERIALS)]
        if self.ores.get(ore, 0) < 2:
            return [f"Smelting one bar needs 2 {ore} ore."]
        self.ores[ore] -= 2
        bar = f"{ore} bar"
        self.ores[bar] = self.ores.get(bar, 0) + 1
        return [f"You smelt a {bar}."]

    def cmd_forge(self, wtype, mat):
        if not self._at_village():
            return ["Forge in the village."]
        if wtype not in WEAPON_TYPES:
            return ["Unknown weapon type. See 'types'."]
        if mat not in MATERIALS:
            return ["Unknown material. See 'materials'."]
        bar = f"{mat} bar"
        if self.ores.get(bar, 0) < 2:
            return [f"Forging needs 2 {bar}s."]
        cost = 20 * MATERIALS[mat][0]
        if self.has("smith"):
            cost = int(cost * 0.75)
        if self.gold < cost:
            return [f"Forging costs {cost} gold. You have {self.gold}."]
        self.gold -= cost
        self.ores[bar] -= 2
        w = self.generate_weapon(wtype, mat)
        self.weapons.append(w)
        self.forged[wtype] = self.forged.get(wtype, 0) + 1
        out = [art.ANVIL, f"You forged: {w['name']}", self.describe_weapon(w)]
        self._progress("forge", wtype, 1, out)
        return out

    def cmd_types(self):
        out = []
        for name, (dmg, crit, special) in WEAPON_TYPES.items():
            out.append(f"{name}  dmg {dmg}  crit {crit * 100:.0f}%  "
                       f"special {special[0]}")
            out.append(art.WEAPON_ICON[name])
        return out

    def cmd_enchant(self, wid, ench):
        if not self._at_village():
            return ["Enchant at the village enchanter."]
        w = self.get_weapon(wid)
        if w is None:
            return ["No weapon with that number. See 'weapons'."]
        if ench not in ENCHANTS:
            return ["Unknown enchant. See 'enchants'."]
        if ench in w["enchants"]:
            return [f"{w['name']} already has {ench}."]
        slots = w["slots"] + (1 if self.has("enchanter") else 0)
        if len(w["enchants"]) >= slots:
            return ["No free enchant slots on that weapon."]
        cost = ENCHANT_GOLD * (0.75 if self.has("enchanter") else 1)
        cost = int(cost)
        if self.gold < cost or self.essence < ENCHANT_ESSENCE:
            return [f"Enchanting costs {cost} gold and {ENCHANT_ESSENCE} essence."]
        self.gold -= cost
        self.essence -= ENCHANT_ESSENCE
        w["enchants"].append(ench)
        return [f"{w['name']} is now enchanted with {ench}: {ENCHANTS[ench]}."]

    # ----------------------------------------------------------- inventory
    def cmd_inv(self):
        ores = {k: v for k, v in self.ores.items() if v}
        lines = [f"Gold {self.gold}   Potions {self.potions}   Essence {self.essence}",
                 "Materials: " + (", ".join(f"{k} x{v}" for k, v in ores.items()) or "none"),
                 f"Weapons: {len(self.weapons)} (see 'weapons')"]
        return lines

    def cmd_weapons(self):
        if not self.weapons:
            return ["No weapons yet. Mine ore, smelt bars, and forge one."]
        out = []
        for w in self.weapons:
            tag = " [equipped]" if w["id"] == self.equipped else ""
            out.append(self.describe_weapon(w) + tag)
        return out

    def cmd_equip(self, wid):
        w = self.get_weapon(wid)
        if w is None:
            return ["No weapon with that number."]
        self.equipped = wid
        return [f"Equipped {w['name']}.", art.WEAPON_ICON[w["type"]]]

    def cmd_sell(self, wid):
        w = self.get_weapon(wid)
        if w is None:
            return ["No weapon with that number."]
        value = int(w["damage"] * 5 + w["quality"] / 2 + len(w["enchants"]) * 10)
        self.weapons.remove(w)
        if self.equipped == wid:
            self.equipped = None
        self.gold += value
        return [f"Sold {w['name']} for {value} gold."]

    def cmd_buy_potion(self):
        if not self._at_village():
            return ["Shops are in the village."]
        if self.gold < POTION_PRICE:
            return ["Not enough gold."]
        self.gold -= POTION_PRICE
        self.potions += 1
        return [f"Bought a potion. You have {self.potions}."]

    def cmd_use_potion(self):
        if self.potions <= 0:
            return ["No potions left."]
        self.potions -= 1
        healed = min(POTION_HEAL, self.max_hp - self.hp)
        self.hp += healed
        out = [f"You drink a potion and heal {healed} HP."]
        if self.battle:
            out += self._enemy_turn()
        return out

    def cmd_rest(self):
        if not self._at_village():
            return ["You can only rest in the village."]
        self.hp = self.max_hp
        return ["You rest at the inn and feel refreshed. HP full."]

    # -------------------------------------------------------------- quests
    def cmd_board(self):
        out = ["Quest board:"]
        for i, q in enumerate(self.board, 1):
            out.append(f"  {i}. {q['text']}   reward {q['gold']} gold, {q['xp']} XP")
        out.append("Type 'accept <n>' in the village to take a quest (max 3 active).")
        return out

    def cmd_accept(self, n):
        if not self._at_village():
            return ["Quests are taken at the village board."]
        if not 1 <= n <= len(self.board):
            return ["No such quest on the board."]
        if len(self.active) >= 3:
            return ["You already have 3 active quests."]
        q = self.board.pop(n - 1)
        self.active.append(q)
        self.board.append(self._new_quest())
        return [f"Accepted: {q['text']}."]

    def cmd_quests(self):
        if not self.active:
            return ["No active quests. Visit the village board."]
        out = ["Active quests:"]
        for i, q in enumerate(self.active, 1):
            out.append(f"  {i}. {q['text']}  [{q['have']}/{q['target']}]")
        return out

    def cmd_claim(self, n):
        if not self._at_village():
            return ["Claim quest rewards in the village."]
        if not 1 <= n <= len(self.active):
            return ["No such active quest."]
        q = self.active[n - 1]
        if q["have"] < q["target"]:
            return [f"Not finished yet [{q['have']}/{q['target']}]."]
        self.active.pop(n - 1)
        self.gold += q["gold"]
        out = [f"Quest done! +{q['gold']} gold."]
        self._gain_xp(q["xp"], out)
        return out

    # --------------------------------------------------------------- skills
    def cmd_skills(self):
        out = [f"Skill points: {self.points}"]
        for name, s in SKILLS.items():
            if name in self.skills:
                state = "[learned]"
            elif all(r in self.skills for r in s["req"]):
                state = "[available]"
            else:
                state = "[locked: " + ", ".join(s["req"]) + "]" if s["req"] else "[locked]"
            out.append(f"  {name:<11} cost {s['cost']}  {state:<22} {s['desc']}")
        return out

    def cmd_learn(self, name):
        s = SKILLS.get(name)
        if s is None:
            return ["No such skill. See 'skills'."]
        if name in self.skills:
            return ["You already know that skill."]
        if not all(r in self.skills for r in s["req"]):
            return ["You need the prerequisites first."]
        if self.points < s["cost"]:
            return [f"Need {s['cost']} skill points (you have {self.points})."]
        self.points -= s["cost"]
        self.skills.append(name)
        if name == "toughness":
            self.max_hp += 10
            self.hp += 10
        return [f"Learned {name}: {s['desc']}."]

    # --------------------------------------------------------------- combat
    def _start_battle(self, color):
        st = SLIMES[color]
        scale = 1 + 0.04 * (self.level - 1)
        hp = round(st["hp"] * scale)
        self.battle = {"color": color, "hp": hp, "max": hp,
                       "atk": round(st["atk"] * scale), "xp": st["xp"],
                       "gold": st["gold"], "burn": 0, "bleed": 0, "stun": 0}
        return [art.SLIME[color], f"A {color} slime attacks! ({hp} HP)",
                "Actions: attack | special | use potion | flee"]

    def cmd_attack(self):
        out = self._hit(1, 1.0)
        if self.battle:
            out += self._enemy_turn()
        return out

    def cmd_special(self):
        w = self.weapon()
        if w is None:
            return ["Specials need a weapon. Equip one first."]
        if self.cool > 0:
            return [f"Special recharging: {self.cool} turn(s) left."]
        name, hits, mult, effect = WEAPON_TYPES[w["type"]][2]
        out = [f"{name}!"] + self._hit(hits, mult, effect)
        self.cool = 3 - (1 if self.has("tactician") else 0)
        if self.battle:
            out += self._enemy_turn()
        return out

    def cmd_flee(self):
        if self.rng.random() < 0.5:
            self.battle = None
            return ["You escape into the grass."]
        out = ["You fail to escape!"]
        return out + self._enemy_turn()

    def _hit(self, hits, mult, effect=""):
        b = self.battle
        w = self.weapon()
        base = (w["damage"] if w else 2.0)
        if w and "sharpness" in w["enchants"]:
            base += 3
        if self.has("brawn"):
            base += 2
        if self.has("berserker") and self.hp < self.max_hp / 2:
            base *= 1.25
        crit = (w["crit"] if w else 0.05) + (0.05 if self.has("keen") else 0)
        enchants = w["enchants"] if w else []
        out = []
        total = 0
        for _ in range(hits):
            dmg = base * mult * self.rng.uniform(0.85, 1.15)
            is_crit = self.rng.random() < crit or effect == "crit"
            if is_crit:
                dmg *= 2
                out.append("Critical hit!")
            dmg = max(1, round(dmg))
            total += dmg
            b["hp"] -= dmg
            out.append(f"You hit the {b['color']} slime for {dmg}.")
            if "vampiric" in enchants:
                heal = max(1, dmg // 10)
                self.hp = min(self.max_hp, self.hp + heal)
            if "fire" in enchants:
                b["burn"] = 3
            if "frost" in enchants and self.rng.random() < 0.2:
                b["stun"] = max(b["stun"], 1)
                out.append("The slime is frozen!")
            if b["hp"] <= 0:
                break
        if effect == "bleed" and b["hp"] > 0:
            b["bleed"] = 3
            out.append("The slime starts bleeding.")
        if effect == "stun" and b["hp"] > 0 and self.rng.random() < 0.7:
            b["stun"] = max(b["stun"], 1)
            out.append("The slime is stunned!")
        if effect == "heal" and w:
            healed = max(1, total // 2)
            self.hp = min(self.max_hp, self.hp + healed)
            out.append(f"Reap heals you for {healed}.")
        if b["hp"] <= 0:
            return out + self._win()
        return out

    def _enemy_turn(self):
        b = self.battle
        out = []
        if b["burn"] > 0:
            b["burn"] -= 1
            b["hp"] -= 2
            out.append("Burning! The slime takes 2 damage.")
        if b["bleed"] > 0:
            b["bleed"] -= 1
            b["hp"] -= 2
            out.append("Bleeding! The slime takes 2 damage.")
        if b["hp"] <= 0:
            return out + self._win()
        if b["stun"] > 0:
            b["stun"] -= 1
            out.append("The slime is stunned and can't attack.")
        else:
            dmg = b["atk"] + self.rng.randint(0, 2)
            self.hp -= dmg
            out.append(f"The {b['color']} slime hits you for {dmg}.")
            if self.hp <= 0:
                return out + self._die()
        if self.cool > 0:
            self.cool -= 1
        out.append(f"You: {self.hp}/{self.max_hp} HP   Slime: {max(0, b['hp'])}/{b['max']} HP")
        return out

    def _win(self):
        b = self.battle
        w = self.weapon()
        gold = b["gold"] * (1.25 if self.has("greed") else 1.0)
        if w and "lucky" in w["enchants"]:
            gold *= 1.5
        gold = int(gold)
        self.gold += gold
        self.kills[b["color"]] = self.kills.get(b["color"], 0) + 1
        out = [art.VICTORY, f"You defeated the {b['color']} slime. +{gold} gold."]
        self._progress("kill", b["color"], 1, out)
        if self.rng.random() < 0.35:
            self.essence += 1
            out.append("The slime leaves behind essence (+1 essence).")
        if self.rng.random() < 0.08:
            wtype = self.rng.choice(list(WEAPON_TYPES))
            mats = [m for m, (t, _) in MATERIALS.items() if t <= self.mining_tier()]
            loot = self.generate_weapon(wtype, self.rng.choice(mats))
            self.weapons.append(loot)
            out.append(f"Loot! You found: {loot['name']} (#{loot['id']}).")
        self.battle = None
        self.cool = 0
        self._gain_xp(b["xp"], out)
        return out

    def _die(self):
        out = [art.DEFEAT]
        self.gold //= 2
        self.hp = max(1, self.max_hp // 2)
        self.pos = (MAP_W // 2, MAP_H // 2)
        self.battle = None
        self.cool = 0
        out.append("You wake up in the village and lost half your gold.")
        return out

    def _gain_xp(self, amount, out):
        self.xp += amount
        out.append(f"+{amount} XP.")
        while self.xp >= self.xp_needed():
            self.xp -= self.xp_needed()
            self.level += 1
            self.max_hp += 5
            self.hp += 5 + (3 if self.has("healer") else 0)
            self.points += 1
            out.append(f"LEVEL UP! You are now level {self.level}. +1 skill point.")

    # ------------------------------------------------------------- UI data
    def view(self):
        """Plain-dict snapshot of everything the 2D front-end needs."""
        return {
            "grid": self.grid,
            "pos": list(self.pos),
            "explored": [list(t) for t in self.explored],
            "tile": self.tile(),
            "hp": self.hp, "max_hp": self.max_hp,
            "level": self.level, "xp": self.xp, "xp_need": self.xp_needed(),
            "gold": self.gold, "potions": self.potions, "essence": self.essence,
            "points": self.points, "mining_tier": self.mining_tier(),
            "ores": {k: v for k, v in self.ores.items() if v},
            "weapons": self.weapons, "equipped": self.equipped,
            "battle": self.battle, "cool": self.cool,
            "active": self.active, "board": self.board,
            "skills": self.skills,
            "skill_defs": SKILLS,
            "weapon_types": {k: {"dmg": v[0], "crit": v[1], "special": v[2][0]}
                             for k, v in WEAPON_TYPES.items()},
            "materials": {k: v[0] for k, v in MATERIALS.items()},
            "enchants": ENCHANTS,
            "tile_names": TILE_NAMES,
        }
