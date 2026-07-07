import os, subprocess, sys, json

issue_val = os.environ.get("WORKFLOW_DISPATCH_ISSUE")
issue_num = issue_val if issue_val else os.environ.get("ACTUAL_ISSUE")

if not issue_num:
    print("Error: No issue number provided.")
    sys.exit(1)

with open(os.environ.get("GITHUB_ENV", "/dev/null"), "a") as f:
    f.write(f"ISSUE_NUMBER={issue_num}\n")

repository = os.environ.get("GITHUB_REPOSITORY", "")

# Read AGENTS.md as local context
agents_content = ""
try:
    if os.path.exists("AGENTS.md"):
        with open("AGENTS.md", "r") as f_in:
            agents_content = f_in.read()
        print("Successfully read AGENTS.md local context")
    else:
        print("CRITICAL: AGENTS.md not found")
        sys.exit(1)
except Exception as e:
    print(f"CRITICAL: Failed to read AGENTS.md locally: {e}")
    sys.exit(1)

# Read the learnings index (durable-knowledge catalog; full entries live one-per-file
# under docs/learnings/ and are pulled on demand via ripgrep, NOT loaded wholesale).
learnings_index = ""
try:
    if os.path.exists("docs/learnings/INDEX.md"):
        with open("docs/learnings/INDEX.md", "r", encoding="utf-8") as f_in:
            learnings_index = f_in.read()
        print("Successfully read docs/learnings/INDEX.md")
except Exception as e:
    print(f"Warning: could not read learnings index: {e}")

learnings_block = ""
if learnings_index.strip():
    learnings_block = (
        "\n--- Learnings index (durable knowledge; FULL entries in docs/learnings/, pull on demand) ---\n"
        + learnings_index
        + "\nBefore implementing, `rg` inside docs/learnings/ for the modules/APIs you will touch "
          "(src/*.ts file names, ZohoCliq.* scopes, /api/... paths) and read the matching entries.\n"
    )

# Fetch issue data (title, body, comments)
try:
    issue_json_str = subprocess.check_output(
        f"gh issue view {issue_num} --repo {repository} --json title,body,comments",
        shell=True,
        text=True
    ).strip()

    issue_data = json.loads(issue_json_str)
    title = issue_data.get("title", "")
    body = issue_data.get("body", "")
    comments = issue_data.get("comments", [])
except subprocess.CalledProcessError as e:
    print(f"Error fetching issue #{issue_num} from repo {repository} (GH CLI failed): {e}")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"Error parsing issue JSON: {e}")
    sys.exit(1)

# Build comments section
comments_section = ""
if comments:
    comments_section = "\n\n--- Issue Comments ---\n"
    for idx, c in enumerate(comments):
        author = c.get("author", {}).get("login", "Unknown")
        c_body = c.get("body", "").strip()
        comments_section += f"[{author}]:\n{c_body}\n\n"

prompt = f"""Issue #{issue_num}: {title}

--- Description ---
{body}{comments_section}

---
You MUST follow the contextual guidelines in AGENTS.md (project goal, conventions, Learnings).
{learnings_block}
HOW TO WORK:
1. Read ROADMAP.md (what's left), skim the existing code (what exists), and check recent `git log` (what just changed). Skim the learnings index above and `rg docs/learnings/` for entries about the modules/APIs you will touch; read the matches before coding.
2. Decide the scope from THIS issue:
   - If the issue names a concrete task or bug  -> do exactly that.
   - If the issue is empty or just says "iterate"/"next step" -> take the TOP open item of the highest open phase in ROADMAP.md.
3. Implement ONE coherent increment, with tests where applicable. For ANY user-facing change (new config field, new behavior, new required OAuth scope, new command, new capability), ALSO update README.md (setup/config/feature docs -- e.g. add a new scope to BOTH the section 3b scope table and the section 3c scope string) AND add a CHANGELOG.md [Unreleased] entry. The ClawHub publish workflow turns that CHANGELOG section into the release notes, so an undocumented user-facing change ships invisibly -- and a new scope silently fails for users who never consented to it.
4. Update ROADMAP.md, keeping every line FUTURE-TENSE:
   - If you finished an item entirely, DELETE its line. If you finished only PART of it, either delete it and add a fresh item for the remainder, OR rewrite the line down to just the remaining work. Editing a line to narrow its scope is fine.
   - Never leave a "X now works"/"implemented"/"done" status clause, never mark [x], never strike through, never add a "Done"/"History"/"State" section.
   - Add any newly discovered work to the right phase; reorder if priorities shifted.
   - No file records the past -- history lives in git and the issue comments, never in a tracked file.
5. If you learned a lasting TECHNICAL insight (SDK quirk, gotcha -- a fact about the world, not "what I did"), record it as AT MOST ONE new file docs/learnings/<slug>.md (frontmatter: title + `files:` / `apis:` grep anchors, then a 2-4 sentence fact) and add one line to docs/learnings/INDEX.md. Check the INDEX first and do NOT duplicate an existing entry. Do NOT append to AGENTS.md.
6. Run `npx tsc --noEmit`, `npx vitest run`, and `npm run smoke:gateway` yourself and make them ALL pass -- a CI hard gate blocks the push if any fails.
7. Commit the code + the ROADMAP edit with a conventional-commit message that ends with "Closes #{issue_num}". Do NOT push -- the workflow pushes after a hard gate re-runs typecheck + tests + smoke. Do NOT run `git push` and do NOT close the issue manually; it closes automatically via "Closes #{issue_num}" when the workflow pushes.

This is a HEADLESS run. You must modify all files yourself. Do not ask for human input."""

with open("/tmp/prompt.txt", "w") as f:
    f.write(prompt)

print(f"Prompt created for Issue #{issue_num} ({len(comments)} comments included)")
