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

HOW TO WORK:
1. Read PROGRESS.md (State + Plan) and skim the existing code.
2. Decide the scope from THIS issue:
   - If the issue names a concrete task or bug  -> do exactly that.
   - If the issue is empty or just says "iterate"/"next step" -> take the TOP open item from the Plan in PROGRESS.md.
3. Implement ONE coherent increment, with tests where applicable.
4. REWRITE PROGRESS.md IN PLACE (do NOT append):
   - Update the State (2-3 sentences on where we are now).
   - Maintain the Plan: check off / remove done items, add newly discovered work, reorder so the top item is the next concrete step. Keep ~5-7 open items.
   - Do NOT keep a per-run changelog or history here -- git and the issue comments already hold that.
5. Record any lasting insight (SDK quirks, gotchas) in the Learnings section of AGENTS.md, NOT in PROGRESS.md.
6. Commit everything (code + PROGRESS.md, plus AGENTS.md if you learned something).

This is a HEADLESS run. You must modify all files yourself. Do not ask for human input."""

with open("/tmp/prompt.txt", "w") as f:
    f.write(prompt)

print(f"Prompt created for Issue #{issue_num} ({len(comments)} comments included)")
