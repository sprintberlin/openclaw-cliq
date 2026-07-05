import os, json, urllib.request, urllib.error, subprocess, sys, re, yaml

issue_num = os.environ.get("ISSUE_NUMBER")
if not issue_num:
    print("Error: ISSUE_NUMBER not set.")
    sys.exit(1)

repo = os.environ.get("GITHUB_REPOSITORY")

# Fetch the original issue body AND comments for context-aware verification
issue_body = ""
issue_comments_section = ""
try:
    result = subprocess.run(
        ["gh", "issue", "view", issue_num, "--repo", repo, "--json", "title,body,comments"],
        capture_output=True, text=True, check=True
    )
    issue_data = json.loads(result.stdout)
    issue_body = issue_data.get("body", "").strip()
    if not issue_body:
        issue_body = "(Issue has no body)"
    comments = issue_data.get("comments", [])
    if comments:
        issue_comments_section = "\n\n--- Issue Comments ---\n"
        for c in comments:
            author = c.get("author", {}).get("login", "Unknown")
            c_body = c.get("body", "").strip()
            issue_comments_section += f"[{author}]:\n{c_body}\n\n"
    print(f"[verify] Issue body fetched ({len(issue_body)} chars), {len(comments)} comments included")
except Exception as e:
    issue_body = f"(Issue body could not be loaded: {e})"
    print(f"[verify] Warning: Could not fetch issue body/comments: {e}")

changes_made_str = os.environ.get("CHANGES_MADE", "false")
changes_made = changes_made_str.lower() == "true"
log_path = "/tmp/opencode_run.log"

try:
    with open(log_path, "r", encoding="utf-8") as f:
        full_log_content = f.read()
except Exception:
    full_log_content = "OpenCode log file missing or not readable."

# Read verification configuration from opencode-models.yml
models_config_path = os.path.join(os.environ.get("GITHUB_WORKSPACE", "/"), ".github/opencode-models.yml")
verification_model = "minimax/minimax-m2.7"
max_log_chars = 16000

try:
    with open(models_config_path, "r") as f:
        models_config = yaml.safe_load(f)
        v_alias = models_config.get("verification", {}).get("alias")
        if v_alias and v_alias in models_config.get("models", {}):
            verification_model = models_config["models"][v_alias].get("id", verification_model)

        cfg_max_chars = models_config.get("verification", {}).get("max_log_chars")
        if cfg_max_chars:
            max_log_chars = int(cfg_max_chars)
except Exception as e:
    print(f"Warning: Could not parse opencode-models.yml cleanly (using fallbacks). Error: {e}")

log_content = full_log_content

if len(log_content) > max_log_chars:
    log_content = "[... TRUNCATED ...]\n" + log_content[-max_log_chars:]

prompt = f"""
You are the quality inspector "aidercx" for autonomous agents (OpenCode).
Analyze the following execution log and assess whether the agent successfully completed its task or failed / aborted.

CHECK CAREFULLY: You know the actual requirements from the original issue. Check whether ALL requirements were fully and correctly implemented. Go through the issue requirements point by point and check in the log whether the agent addressed each point. Be critical — superficial "looks good" assessments are not enough.

Important note: OpenCode acts as an autonomous developer at the terminal. If it executes commands like 'git add', 'git commit' or 'git push' in the log and signals that it's done (e.g. "All tasks completed"), that's a strong indicator of success, EVEN IF it crashes at the end of the log.

ALSO CHECK: Did the agent maintain ROADMAP.md correctly? If it completed a roadmap item it must have DELETED that line (not marked it [x] or added a "Done"/"History"/changelog section — the repo keeps NO history in tracked files; history lives in git and issue comments). Newly discovered work should be added as open items. If the agent wrote a changelog/history/"what I did" section into ROADMAP.md (or any tracked file), or ticked items instead of deleting them, flag the run as incomplete.

## Original Issue (requirements):
```
{issue_body}{issue_comments_section}
```

Was new code committed to the repository? (Changes committed): {changes_made}

Execution Log (Last {max_log_chars} chars):
```
{log_content}
```

Respond in JSON format according to the following schema:
{{
  "success": true_or_false,
  "comment": "A precise, short explanation of what was done or — if failed — what the problem was. Write from the perspective of the bot 'aidercx'. Refer specifically to the issue requirements.",
  "has_follow_up": true_or_false,
  "follow_up_comment": "If the agent pointed out open inconsistencies, technical debt, or follow-up tasks (that it did not complete), summarize that here. Otherwise leave empty."
}}
"""

payload = {
    "model": verification_model,
    "messages": [{"role": "user", "content": prompt}],
    "response_format": {"type": "json_object"}
}

data = json.dumps(payload).encode("utf-8")

req = urllib.request.Request(
    "https://openrouter.ai/api/v1/chat/completions",
    data=data,
    headers={
        "Authorization": f"Bearer {os.environ.get('OPENROUTER_API_KEY')}",
        "Content-Type": "application/json"
    }
)

success = changes_made
comment_body = f"OpenCode run finished. Changes committed: {changes_made}. (AI Verification via {verification_model})."

try:
    with urllib.request.urlopen(req) as res:
        resp_data = json.loads(res.read().decode())
        content_str = resp_data["choices"][0]["message"]["content"]
        content = json.loads(content_str)
        success = content.get("success", False)

        token_summary = ""
        try:
            with open("/tmp/token_summary.txt", "r", encoding="utf-8") as tf:
                token_summary = tf.read().strip()
        except FileNotFoundError:
            token_summary = "No token data available."
        except Exception as e:
            token_summary = f"Token summary could not be read: {e}"

        comment_body = content.get("comment", comment_body)
        comment_body += f"\n\n---\n**OpenCode Execution Data:**\n{token_summary}"

        has_follow_up = content.get("has_follow_up", False)
        follow_up_comment = content.get("follow_up_comment", "")
except urllib.error.URLError as e:
    err_body = e.read().decode() if hasattr(e, "read") else ""
    print(f"HTTP Error calling LLM: {e}\n{err_body}")
    comment_body += f"\n\n(LLM Error: {e})"
except Exception as e:
    print(f"Error parse/eval: {e}")
    comment_body += f"\n\n(Internal Script Error: {e})"

print(f"Evaluated success: {success}")
print(f"Comment generated: {comment_body}")

try:
    subprocess.run(["gh", "issue", "comment", issue_num, "--repo", repo, "-b", comment_body], check=True)

    has_follow_up_bool = 'has_follow_up' in locals() and has_follow_up and bool(follow_up_comment.strip())

    if has_follow_up_bool:
        follow_up_msg = f"**Agent Follow-up Note:**\n\n{follow_up_comment}"
        subprocess.run(["gh", "issue", "comment", issue_num, "--repo", repo, "-b", follow_up_msg], check=True)

    if success and changes_made and not has_follow_up_bool:
        subprocess.run(["gh", "issue", "close", issue_num, "--repo", repo], check=True)
    elif success and changes_made and has_follow_up_bool:
        subprocess.run(["gh", "issue", "edit", issue_num, "--repo", repo, "--add-label", "follow-up"], check=False)
        subprocess.run(["gh", "issue", "reopen", issue_num, "--repo", repo], check=False)
    else:
        subprocess.run(["gh", "issue", "edit", issue_num, "--repo", repo, "--add-label", "needs-human"], check=True)
        subprocess.run(["gh", "issue", "reopen", issue_num, "--repo", repo], check=False)

except subprocess.CalledProcessError as e:
    print(f"GH CLI Error communicating with GitHub: {e}")
    sys.exit(1)
