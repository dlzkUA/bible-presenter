# Bible Presenter — User Guide

The user guide in two forms, built from one source (`build_manual.py`).

| Folder | For |
|---|---|
| `notion/` | Notion-flavored Markdown for the Notion API. Callouts, toggles and tables stay native Notion blocks. |
| `import/` | Plain Markdown with an `images/` folder, for Notion's **Import → Markdown & CSV**. |
| `images/` | Screenshots used by both. |

## Option A — publish through the Notion API (full formatting)

Notion's markdown format references images by URL, so the screenshots are served from this repository on GitHub.

1. Push the project to GitHub. The repository must be public.
2. Create an integration at notion.so/profile/integrations → **New integration**, and copy its secret.
3. In Notion, open the page that should hold the guide: **•••** → **Connections** → add your integration.
4. From the project folder (Node 18 or newer):

   Windows (PowerShell)
   ```
   $env:NOTION_TOKEN="secret"; $env:NOTION_PARENT="page link"; node docs/manual/publish-to-notion.js
   ```
   macOS
   ```
   NOTION_TOKEN=secret NOTION_PARENT="page link" node docs/manual/publish-to-notion.js
   ```

The script creates "Bible Presenter — User Guide" with 15 sub-pages. Before creating anything it checks that the screenshots are reachable.

## Option B — Notion import (no GitHub, no API)

1. Zip the contents of `import/` (the `.md` files and the `images` folder).
2. In Notion: **Settings → Import → Text & Markdown** (or **Markdown & CSV**), select the zip.

Callouts become quotes and toggles become plain paragraphs in this mode.

## Editing the guide

Edit the articles in `build_manual.py`, then run `python3 docs/manual/build_manual.py` to regenerate both folders.
