"""ASCII art and static text for Slime Forge."""

TITLE = r"""
  ____  _ _                 _____
 / ___|| (_)_ __ ___   ___ |  ___|__  _ __ __ _  ___
 \___ \| | | '_ ` _ \ / _ \| |_ / _ \| '__/ _` |/ _ \
  ___) | | | | | | | |  __/|  _| (_) | | | (_| |  __/
 |____/|_|_|_| |_| |_|\___||_|  \___/|_|  \__, |\___|
                                          |___/
"""

SLIME = {
    "green": r"""
     .--.
    ( o o )   green slime
    (  ~~  )
     '----'
""",
    "blue": r"""
     .--.
    ( ^ ^ )   blue slime
    ( ~~~~ )
     '----'
""",
    "red": r"""
     .-''-.
    ( >  < )  red slime
    ( /**\ )
    '------'
""",
    "black": r"""
    .~~~~~~.
   ( x    x )  black slime
   ( ~~~~~~ )
    '------'
""",
}

VILLAGE = r"""
         /\
        /  \      ___  ___
   ____/____\____ |_| |_|_|  VILLAGE
  |  [ ]  [ ]  |  ___________
  |______ ____|  |_|_|_|_|_|
"""

PICKAXE = r"""
    ___
   /   \___
  |  ^  ^  |  *  *  *
   \_______/      clink!
"""

ANVIL = r"""
        ___________
       |___________|
          |     |
         _|_____|_
        |_________|    *CLANG*
"""

VICTORY = r"""
   \o/  VICTORY!  \o/
"""

DEFEAT = r"""
     x_x   You have been defeated...
"""

WEAPON_ICON = {
    "sword":   "  /|\n /_|\n[==|==>",
    "spear":   "   /\\\n  |  |\n  |  |\n  |  |\n  '--'",
    "axe":     " ____\n|    |\\\n|____|/\n  ||",
    "bow":     " )\n(  )-->\n )",
    "mace":    "  ___\n (___)\n   |\n   |",
    "dagger":  "  /\\\n [==]\n  ''",
    "halberd": " ___/\\\n|_ __|\n  |\n  |",
    "scythe":  "  _____\n /     )\n/_____/\n  |",
}

HELP = """\
MOVE       n s e w  (or: go n)      map          look at surroundings
STATUS     status                   bar          quick stats line
FIGHT      attack  special  flee  use potion
MINING     mine (on ^ mountain or C cave)   inv   weapons
SMITHING   smelt <ore>   forge <type> <material>   types   materials
ENCHANT    enchants   enchant <weapon#> <name>
EQUIP      equip <weapon#>   sell <weapon#>
VILLAGE    shop   buy potion   buy cat (60g)   rest   board   accept <n>   quests   claim <n>
PET        pet   use potion cat
SKILLS     skills   learn <name>
SAVE       save   (also autosaves)
HELP       help"""

LEGEND = """\
  @ you   V village   . grass   T forest   ^ mountain
  C cave  N slime nest   ~ lake   ' ' unexplored"""
