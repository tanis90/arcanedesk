---
name: arcane-module-reader
description: Read and organize TRPG/D&D adventure PDFs into an Obsidian library split by real chapters with bidirectional navigation, answer questions about the module from that library, and after building it offer a few key Mermaid diagrams (plot skeleton / clue flow / NPC relations / location topology) so the DM can grasp the module structure fast. Use when the user asks to "read a module", import an adventure PDF, build an Obsidian module library, query an imported module's plot/NPCs/locations/encounters, check module text, or requests diagrams of characters/clues/maps. Not for one-off PDF conversion, OCR, or summarization.
---

# Reading and organizing TRPG modules

When you receive a module PDF, extract Markdown with MinerU, read the extracted content, divide it into the book's real chapters based on your own understanding, and organize it into a durable, queryable Obsidian library. When the user later asks about the module, search and read this library before answering.

## User interaction budget

The interaction budget is a fixed 2: "the One Question" (upload consent) + "the diagram offer" (asked with the final report after the library is built). Only two rules —

The One Question: if your context already contains the user's answer to the One Question, don't ask again — just proceed; if there's no such record, ask once before the first upload. After that, every later module PDF's extraction, chaptering, navigation, and conflict backups proceed with no further questions, confirmations, or choices — the user understood the deal the first time, and if they disagree they simply won't hand you another PDF. Re-asking is harassment.

The diagram offer: after each module's library is built, ask once at the end of the final report whether they want a few key diagrams (see the "Module diagrams" section). Ask once per new module; the answer does not carry over between modules — upload consent is a trust decision, informed once; diagrams are a per-module value question. Re-importing an already-imported module needs no question: handle conflicts per the "Re-importing" defaults and add a one-line afterthought about diagrams in the final report.

Before adding any new user interaction, first argue why it cannot be folded into these two questions.

## Creating the library

Use the output location the user specified; when unspecified, use `module-library/<module-name>/` under the current prep working directory (the agent session's cwd). Always resolve to an absolute path and state it in the One Question and in the final report:

```text
module-library/<module-name>/
├── 00-Contents.md
├── chapters/
│   ├── 01-preface.md
│   ├── 02-chapter-one.md
│   └── ...
└── _raw-extract/
    ├── p001-020.md
    ├── p021-040.md
    └── ...
```

Do not write module content into this skill or the Arcane Desktop installation directory. Keep the MinerU output in `_raw-extract` for inspection and re-organization. Do not commit or publish commercial module text to Git unless the user explicitly asks and confirms they have the right to do so.

## Preparing the MinerU CLI (autonomous, don't ask the user)

Run `mineru-open-api version` first. If the command works, skip ahead to the One Question.

If the command is missing, install it with the official MinerU install script (zero-dependency single binary; no Python or Node required), and only ever from these two official URLs. Installation is tool preparation (a technical detail): the agent verifies the machine result and reports afterwards; do not show the user script contents or hash strings for approval.

- macOS / Linux: `https://cdn-mineru.openxlab.org.cn/open-api-cli/install.sh`
- Windows PowerShell: `https://cdn-mineru.openxlab.org.cn/open-api-cli/install.ps1`

Never pipe any network response directly into a shell or script interpreter. Download to a temp directory first:

```bash
# macOS / Linux
curl -fsSL -o /tmp/mineru-install.sh "https://cdn-mineru.openxlab.org.cn/open-api-cli/install.sh"
```

```powershell
# Windows PowerShell
Invoke-WebRequest -Uri "https://cdn-mineru.openxlab.org.cn/open-api-cli/install.ps1" -OutFile "$env:TEMP\mineru-install.ps1"
```

Before executing, verify the final HTTPS hostname is `cdn-mineru.openxlab.org.cn`, and read the downloaded script yourself (it's plain text) to confirm it only downloads the binary and adds it to PATH. After execution, unconditionally compute the SHA256 of both script and binary — the CDN provides no publisher checksum, so record the computed values in the report as this installation's fingerprint without claiming they match any official hash. The script installs the binary into `$HOME/.mineru/bin` and adds that directory to the user PATH; explain this in one plain sentence in the report. After installation, re-check with `mineru-open-api version` using the absolute path. On Windows always invoke the binary by absolute path; running the exe directly in Git Bash or other Unix-like terminals may fail with Permission denied — invoke it via PowerShell, e.g.
`powershell.exe -NoProfile -Command '& "C:\Users\<user>\.mineru\bin\mineru-open-api.exe" version'`.

Do not use third-party mirrors or any source other than these two official URLs. Do not ask the user to install Python or another Node just to install the CLI. If installation fails, report the actual command output and the remaining blocker; do not silently switch to another cloud PDF service.

## The One Question

Once the CLI is ready and before any module content is uploaded, check your context: if the user's answer to the One Question is already on record, skip this section and extract. If not, run `mineru-open-api auth --show` first (a purely local query — nothing is uploaded), then ask the single question based on the result:

- **Token configured** (form A, upload confirmation): "<Module name> needs to be uploaded to MinerU's servers for parsing; the recipient is MinerU, and the content may include commercial/personal information. You have a token configured, so I'll parse the whole book in precise mode. Shall I start?"
- **No token configured** (form B, disclosure + choice in one sentence): "<Module name> needs to be uploaded to MinerU's servers for parsing; the recipient is MinerU, and the content may include commercial/personal information. MinerU has a free precise mode: better recovery of images, tables, and stat blocks, and the whole book parses in one pass without splitting — but it requires a free token from mineru.net. Do you want me to walk you through registration, or start in token-free mode right away (images and tables become placeholders, split every 20 pages)?"

One answer from the user is the go-ahead; later documents reuse this answer without re-asking. Never upload without the user's explicit consent; a user who only says "import" has not consented to a third-party cloud upload. If the user refuses the upload, stop and leave local files unchanged.

If the user chooses to register a token, give exact click steps (open <https://mineru.net/apiManage/token> in a browser → register/sign in → create and copy the token). Registration guidance is a continuation of the One Question, not a new interaction point. When the user sends you the token, store it in the local config and verify it works — don't just use it for this one task, or the user will have to register again in the next conversation:

1. If `~/.mineru/config.yaml` already exists, copy it to a timestamped backup first: `auth` overwrites the old token without keeping a copy.
2. Write via a stdin pipe so the token never appears in command-line arguments or the process list:
   `printf '<token>\n' | mineru-open-api auth`.
3. Read back with `mineru-open-api auth --show` (a purely local query) and confirm it shows `Token source: config`, with the masked head/tail characters matching the token the user gave.
4. Then run `extract` directly; the CLI reads the config automatically, no `MINERU_TOKEN` environment variable needed.

After verification, tell the user explicitly: the token is stored on this machine and will work directly in future conversations — no need to register again. Never echo the token itself, write it into reports, or commit it to Git; at most, note the masked head/tail in the report for identification.

## Extracting the PDF

**Precise mode** (token configured or newly registered): `mineru-open-api extract "module.pdf" -o "<library>/_raw-extract/"` parses the whole book in one pass (limits: 600 pages / 200 MB per run). If it returns HTTP 401 or `msgCode A0211` mid-run, the token has expired: don't interrupt the flow — fall back to the token-free segmented mode below to finish, and note in the report that the token expired with a suggestion to reconfigure it.

**Token-free mode**: use `flash-extract --pages` in segments of at most 20 pages (there is also a 10 MB per-file limit; if a segment fails for size, narrow that segment's page range and retry). Start at pages 1-20, and give every segment a distinct, complete output filename:

```text
mineru-open-api flash-extract "module.pdf" --pages 1-20 -o "module-library/module-name/_raw-extract/p001-020.md"
mineru-open-api flash-extract "module.pdf" --pages 21-40 -o "module-library/module-name/_raw-extract/p021-040.md"
```

Continue in 20-page steps. After at least one successful result, if the next segment returns empty content or explicitly reports the page range is out of bounds, extraction is complete. If it returns any other error, do not pretend you've finished reading; explain the error and handle the actual cause. If two consecutive segments return identical content, stop and report the anomaly — do not loop forever.

In the final report, state: the mode used (precise / token-free) and the segment count; in token-free mode, list the page ranges where images and tables were replaced by placeholders, plus one line — "precise mode can improve these sections; tell me if you want it". That's an afterthought, not a question; don't interrupt the flow waiting for an answer.

## MinerU troubleshooting

- When an API request fails for unclear reasons, add `-v` for request/response details, e.g. `mineru-open-api flash-extract "module.pdf" -v`.
- When `extract` returns an auth error (HTTP 401 / `msgCode A0211`), follow the fallback rules in "Extracting the PDF"; after updating the token per the persistence flow in "The One Question", re-run the failed segments.
- On large-file processing timeouts, raise the timeout to 600 seconds, e.g. append `--timeout 600`.
- On language detection errors, set `--language` explicitly — for an English module use `--language en`; keep the default `ch` only for mixed Chinese-English layout.
- After troubleshooting, only retry failures that the new information could reasonably fix; never blindly repeat the same command.

## Reading and chaptering

You must read all extracted content and judge chapter boundaries yourself. If the content is too long, read it in sequential segments; understand the table of contents and the book's main structure first, then decide the final filenames and chapter ranges.

- Use the table of contents and body text to identify the preface, main chapters, and appendices.
- Do not split automatically by Markdown `#` levels, and do not write a heading-parser program. Tables of contents, page headers, scene titles, and sidebars may all be recognized by MinerU as same-level headings.
- Keep scenes, subsections, sidebars, tables, and stat blocks inside the chapter they belong to.
- Use the module's actual chapter names, with a stable two-digit ordering prefix.
- Only fix transcription noise you are certain about; when unsure, keep the extraction as-is and never invent missing content.
- Chapter files preserve the original text; never replace body text with an overview or summary.

When done, review once in `_raw-extract` order to confirm body text, sidebars, tables, and appendices all landed in the right chapters — nothing omitted, duplicated, or replaced by a summary.

## Building the Obsidian navigation

In `00-Contents.md`, list all chapters in reading order, using full Wikilinks from the vault root so identically-named chapters from different modules never collide:

```markdown
- [[module-library/module-name/chapters/01-preface|Preface]]
- [[module-library/module-name/chapters/02-chapter-one|Chapter One: Title]]
```

At the top of each chapter, place a link back to the contents, plus previous/next chapter links where they exist. This gives explicit navigation in both directions, and Obsidian will also show backlinks automatically.

On import, generate only the contents and chapters. Do not pre-create character, location, quest, encounter, or relationship indexes; generate those from the chapter content when the user asks.

## Showing documents to the DM

When showing the DM any document from the library (contents, chapters, indexes), ALWAYS use open_document to open it in the App's right-side reader; never use the system `open`/`start` to hand the file to Obsidian — Obsidian is the tool for building and editing the library, not the way to present it to the DM. Printing a .md path in your reply gives the user a clickable link that opens the same reader.

Before delivery, confirm:

- every Wikilink in the contents points to an existing file;
- every chapter appears in the contents exactly once;
- every chapter can navigate back to the contents;
- previous/next links match the actual order.

## Module diagrams

After the library is built and reviewed, send the final report as usual, and at the end ask once: "Want me to draw a few key diagrams so you can grasp this module's structure quickly?" That's the second interaction. The report does not hang waiting for an answer — the library is the finished deliverable; diagrams are an independent follow-up. If the user says yes, post the Mermaid diagrams as code blocks into the conversation (the App's chat view renders them) in a separate message, not crammed into the report; don't write files unless asked — save them into the library when the user wants that. If the user says no, there's no follow-up.

You read the whole text while building the library; whether to re-read and which chapter files to consult is your own judgment based on the diagram you're drawing — this skill does not prescribe a reading method.

### Which diagrams to draw

Pick 3–5 by module type; each diagram answers exactly one question:

| Diagram | Mermaid type | Question it answers |
|---|---|---|
| One-page overview | `mindmap` | What's in the module (contents-like; no deeper than two levels) |
| Plot skeleton | `flowchart` | Event order, where it branches/joins, where the gates are (level-up, unlock) |
| Clue flow | `flowchart` | Where you can learn what, and where it points |
| NPC relations | `graph` | Who is what to whom |
| Location topology | `graph` | Where you can go from where, and what blocks the way |

The lead diagram depends on type: investigation modules lead with clue flow; linear/combat modules lead with the plot skeleton; sandboxes lead with location topology. For campaign-length multi-chapter modules, layer the skeleton — one top-level diagram plus per-chapter sub-diagrams, never crammed into one. If a cross-chapter conspiracy runs underneath, the clue diagram can be drawn as an attribution chain "surface events → direct causes → the mastermind", marking the points players can investigate.

### Diagram quality rules

These rules exist because a DM only uses diagrams they can trust:

- Every edge needs textual evidence. Never invent relationships the module doesn't state — especially choices deliberately left to players (e.g. friend/rival chosen by the player): rather leave it blank or mark it "player's choice". Mark uncertain items as inference, distinct from textual fact.
- No more than 15 nodes per diagram. If it doesn't fit, layer it (overview + sub-diagrams) instead of piling everything into one. Use short labels matching the names used in the chapter files.
- Same entity, same name across diagrams, so the DM can cross-reference.
- Accuracy beats quantity. 3 trustworthy diagrams beat 8 stitched-together ones.

## Answering module questions

When the user asks about an already-imported module:

1. Read that module's `00-Contents.md` first, then search all chapters. Never answer from prior conversation memory.
2. Read the context around each hit; consult adjacent chapters when needed.
3. Quote or paraphrase the original text faithfully, stating which chapter and section it comes from. Do not maintain or report PDF page numbers; the DM can search the PDF with the quoted text.
4. Clearly distinguish module text, DM notes, and your inferences. If the library has no answer, say so — never invent plot or rules facts.

Handle an after-the-fact diagram request ("draw an NPC relationship chart") the same way: draw from the library, following the quality rules in "Module diagrams". That counts as answering a question, not asking one.

## Re-importing

Re-importing an existing module needs 0 questions. First check chapters for user edits or DM notes; always make a timestamped backup before updating, and state the backup location in the report. Never silently overwrite, and never push the conflict decision back to the user.

## Final report

State clearly: the library's absolute path, the parsing mode and segment count used, this installation's fingerprint (if the CLI was newly installed), backup locations (if any), and quality notes (placeholder sections and the precise-mode suggestion). Never print tokens, full CLI config, or any credentials.
