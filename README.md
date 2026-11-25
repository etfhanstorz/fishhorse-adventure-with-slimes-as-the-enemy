# Slime Forge

A text RPG with ASCII art. Fight slimes, mine ore, smelt bars, forge weapons
(8 types, 6 materials, random modifiers, quality rolls and enchant slots),
enchant gear, walk an open map, take quests, and spend points on a skill tree.

Pure Python 3.10+ standard library. No installs.

## Play in the terminal

```powershell
python play.py          # continue (autosaves to savegame.json)
python play.py --new    # fresh game
```

Type `help` for commands. Common ones: `n s e w`, `map`, `mine`, `smelt iron`,
`forge sword iron`, `weapons`, `equip 1`, `enchant 1 fire`, `board`, `accept 1`,
`claim 1`, `skills`, `learn brawn`, `attack`, `special`, `flee`.

## Play in the browser (Tailscale)

```powershell
python server.py --port 8000
tailscale serve --bg 8000
```

Then open your machine's Tailscale URL (for example `https://<machine>.<tailnet>.ts.net`)
from any device on your tailnet. Each browser keeps its own save, using a token
stored in localStorage.

## GitHub Pages backup

If Tailscale is down, the same game runs entirely in the browser through Pyodide:

```powershell
python build_pages.py   # writes docs/
git add docs
git commit -m "Build Pages"
git push
```

Then in the repo go to Settings > Pages > Deploy from a branch > `main` / `/docs`.
The page detects whether the server is reachable. If not, it loads the engine
in the browser and saves to that browser's localStorage.

## Layout

| Path | What |
| --- | --- |
| `slimeforge/engine.py` | All game logic (`Game.handle(text) -> text`) |
| `slimeforge/art.py` | ASCII art and help text |
| `play.py` | Terminal front-end |
| `server.py` | Web server for Tailscale (JSON API + static files) |
| `web/` | Browser front-end source (`index.html`, `app.js`) |
| `build_pages.py` | Builds `docs/` for GitHub Pages |

## Editing game balance

Weapon types, materials, modifiers, suffixes, slimes, enchants and skills are
plain dicts at the top of `slimeforge/engine.py`.
