"""Terminal front-end for Slime Forge.

    python play.py              play (autosaves to savegame.json)
    python play.py --new        start a fresh game
"""
import os
import sys

from slimeforge import art
from slimeforge.engine import Game

SAVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "savegame.json")


def load_or_new(fresh):
    if not fresh and os.path.exists(SAVE):
        with open(SAVE, encoding="utf-8") as f:
            return Game.loads(f.read())
    return Game()


def autosave(game):
    with open(SAVE, "w", encoding="utf-8") as f:
        f.write(game.dumps())


def main():
    game = load_or_new("--new" in sys.argv)
    print(art.TITLE)
    print("Type 'help' for commands. 'quit' to exit.\n")
    print(game.handle("status"))
    while True:
        try:
            line = input(f"\n[{game.bar()}]\n> ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if line.strip().lower() in ("quit", "exit"):
            break
        print(game.handle(line))
        autosave(game)
    autosave(game)
    print("Saved. See you, adventurer.")


if __name__ == "__main__":
    main()
