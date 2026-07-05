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
1. Read ROADMAP.md (what's left), skim the existing code (what exists), and check recent `git log` (what just changed).
2. Decide the scope from THIS issue:
   - If the issue names a concrete task or bug  -> do exactly that.
   - If the issue is empty or just says "iterate"/"next step" -> take the TOP open item of the highest open phase in ROADMAP.md.
3. Implement ONE coherent increment, with tests where applicable.
4. Update ROADMAP.md by editing OPEN WORK ONLY:
   - DELETE the line(s) you completed. Never mark [x], never strike through, never add a "Done"/"History"/"State" section.
   - Add any newly discovered work to the right phase; reorder if priorities shifted.
   - No file records the past -- history lives in git and the issue comments, never in a tracked file.
5. Record any lasting TECHNICAL insight (SDK quirks, gotchas -- facts about the world, not "what I did") in the Learnings section of AGENTS.md.
6. Commit the code + the ROADMAP edit. Reference this issue and close it (e.g. "Closes #{issue_num}") when the work is complete.

This is a HEADLESS run. You must modify all files yourself. Do not ask for human input."""

with open("/tmp/prompt.txt", "w") as f:
    f.write(prompt)

print(f"Prompt created for Issue #{issue_num} ({len(comments)} comments included)")
