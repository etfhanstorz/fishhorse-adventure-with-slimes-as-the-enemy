"""Build the GitHub Pages backup into docs/.

    python build_pages.py

Copies web/index.html, web/app.js and the slimeforge/ package into docs/.
Commit docs/ and enable GitHub Pages (Settings > Pages > Deploy from branch > /docs).
The Pages site runs the same Python engine in the browser through Pyodide.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")


def main():
    if os.path.isdir(DOCS):
        shutil.rmtree(DOCS)
    os.makedirs(os.path.join(DOCS, "slimeforge"))
    for name in ("index.html", "app.js"):
        shutil.copy(os.path.join(ROOT, "web", name), os.path.join(DOCS, name))
    src = os.path.join(ROOT, "slimeforge")
    for name in os.listdir(src):
        if name.endswith(".py"):
            shutil.copy(os.path.join(src, name), os.path.join(DOCS, "slimeforge", name))
    # Stop GitHub from running Jekyll, so files are served as-is.
    open(os.path.join(DOCS, ".nojekyll"), "w").close()
    print("Built", DOCS)


if __name__ == "__main__":
    main()
