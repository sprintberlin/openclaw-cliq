#!/usr/bin/env python3
"""
💰 OpenRouter Token Cost Report (oh-my-tokens integration)

Liest die vom oh-my-tokens OpenCode-Plugin (https://github.com/wooseungw/oh-my-tokens)
angelegte SQLite-Datenbank aus und schreibt einen strukturierten Token-/Kosten-Report
in den GitHub Step Summary ($GITHUB_STEP_SUMMARY).

Datenquelle:
  ~/.local/share/opencode/oh-my-tokens/oh-my-tokens.db

Die Datenbank wird während des OpenCode-Laufs automatisch über die Plugin-Hooks
(message.updated, session.idle) befüllt. Wir filtern die Events dieses Laufs
anhand eines Zeitfensters (process start time +/- Puffer).

Zusätzlich wird (optional) der Live-Kreditstand via OpenRouter API abgefragt,
falls OPENROUTER_API_KEY gesetzt ist.

Ausfallsicherheit: Jeder Schritt ist in try/except gekapselt; schlägt die
Report-Generierung fehl, wird lediglich ein Hinweis ausgegeben - der Workflow
selbst bricht nicht ab.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def find_db_path() -> Path | None:
    """Finde den oh-my-tokens SQLite-Pfad analog zu paths.ts des Plugins."""
    home = Path.home()
    candidates = [
        home / ".local" / "share" / "opencode" / "oh-my-tokens" / "oh-my-tokens.db",
        home / ".config" / "opencode" / "oh-my-tokens" / "oh-my-tokens.db",
    ]
    xdg_data = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data:
        candidates.insert(
            0, Path(xdg_data) / "opencode" / "oh-my-tokens" / "oh-my-tokens.db"
        )
    for c in candidates:
        if c.exists():
            return c
    return None


def human_tokens(n: int | float | None) -> str:
    """Formatiere Token-Zahl als K/M/B."""
    if n is None:
        return "0"
    n = float(n)
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.2f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return f"{int(n)}"


def human_cost(cost: float | None) -> str:
    """Formatiere Kosten in USD."""
    if cost is None or cost == 0:
        return "$0.0000"
    if cost < 0.01:
        return f"${cost:.6f}"
    if cost < 1:
        return f"${cost:.4f}"
    return f"${cost:.2f}"


def fetch_openrouter_credits(api_key: str) -> dict[str, Any] | None:
    """OpenRouter Credit Balance via offizielle API."""
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/credits",
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "crypto-millionaire-opencode-ci/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as exc:
        print(f"[token-report] OpenRouter credits fetch failed: {exc}", file=sys.stderr)
        return None


# --------------------------------------------------------------------------- #
# DB Queries                                                                  #
# --------------------------------------------------------------------------- #

def query_run_totals(conn: sqlite3.Connection) -> dict[str, Any]:
    """Aggregate alle Events des heutigen Laufs (UTC-Tag).

    Wir nutzen 'events' direkt statt 'rollups', weil die Rollups auch Daten
    vergangener Läufe des gleichen Tages enthalten könnten. Einschränkung auf
    die letzten 6 Stunden ist für einen GH-Actions-Job (timeout 30min) mehr
    als großzügig.
    """
    cur = conn.cursor()
    # Fenster: letzte 6 Stunden (ms-Timestamps)
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    cutoff_ms = now_ms - (6 * 60 * 60 * 1000)

    # Gesamt-Aggregate
    cur.execute(
        """
        SELECT
          COALESCE(SUM(inp), 0)       AS inp,
          COALESCE(SUM(out), 0)       AS out,
          COALESCE(SUM(reasoning), 0) AS reasoning,
          COALESCE(SUM(cache_r), 0)   AS cache_r,
          COALESCE(SUM(cache_w), 0)   AS cache_w,
          COALESCE(SUM(think), 0)     AS think,
          COALESCE(SUM(chat), 0)      AS chat,
          COALESCE(SUM(code), 0)      AS code,
          COALESCE(SUM(total), 0)     AS total,
          COALESCE(SUM(cost), 0.0)    AS cost,
          COUNT(*)                    AS event_count,
          MIN(ts)                     AS first_ts,
          MAX(ts)                     AS last_ts
        FROM events
        WHERE ts >= ?
        """,
        (cutoff_ms,),
    )
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    totals = dict(zip(cols, row))

    # Breakdown nach Provider
    cur.execute(
        """
        SELECT
          provider,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(cost), 0.0) AS cost,
          COALESCE(SUM(inp), 0) AS inp,
          COALESCE(SUM(out), 0) AS out,
          COALESCE(SUM(cache_r), 0) AS cache_r,
          COALESCE(SUM(cache_w), 0) AS cache_w,
          COUNT(*) AS event_count
        FROM events
        WHERE ts >= ?
        GROUP BY provider
        ORDER BY total DESC
        """,
        (cutoff_ms,),
    )
    providers = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]

    # Breakdown nach Model
    cur.execute(
        """
        SELECT
          provider,
          model,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(cost), 0.0) AS cost,
          COALESCE(SUM(inp), 0) AS inp,
          COALESCE(SUM(out), 0) AS out,
          COUNT(*) AS event_count
        FROM events
        WHERE ts >= ?
        GROUP BY provider, model
        ORDER BY total DESC
        LIMIT 10
        """,
        (cutoff_ms,),
    )
    models = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]

    # Breakdown nach Agent
    cur.execute(
        """
        SELECT
          COALESCE(agent, '(unknown)') AS agent,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(cost), 0.0) AS cost,
          COUNT(*) AS event_count
        FROM events
        WHERE ts >= ?
        GROUP BY agent
        ORDER BY total DESC
        """,
        (cutoff_ms,),
    )
    agents = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]

    return {
        "totals": totals,
        "providers": providers,
        "models": models,
        "agents": agents,
    }


# --------------------------------------------------------------------------- #
# Report Rendering                                                            #
# --------------------------------------------------------------------------- #

def render_report(data: dict[str, Any], meta: dict[str, Any]) -> str:
    lines: list[str] = []
    t = data["totals"]

    lines.append("## 💰 OpenRouter Token Cost Report")
    lines.append("")
    lines.append(
        "_Erzeugt durch das [oh-my-tokens](https://github.com/wooseungw/oh-my-tokens) "
        "OpenCode-Plugin. Daten stammen aus der lokalen SQLite-DB, befüllt während "
        "des OpenCode-Laufs._"
    )
    lines.append("")

    # --- Übersicht ---
    lines.append("### 📊 Gesamt-Verbrauch (dieser Lauf)")
    lines.append("")
    lines.append("| Metrik | Wert |")
    lines.append("|---|---|")
    lines.append(f"| 💵 **Gesamtkosten** | **{human_cost(t.get('cost', 0))}** |")
    lines.append(f"| 🎯 Total Tokens | {human_tokens(t.get('total', 0))} |")
    lines.append(f"| 📥 Input Tokens | {human_tokens(t.get('inp', 0))} |")
    lines.append(f"| 📤 Output Tokens | {human_tokens(t.get('out', 0))} |")
    lines.append(f"| 🧠 Reasoning Tokens | {human_tokens(t.get('reasoning', 0))} |")
    lines.append(f"| 📦 Cache Read | {human_tokens(t.get('cache_r', 0))} |")
    lines.append(f"| 📝 Cache Write | {human_tokens(t.get('cache_w', 0))} |")
    lines.append(f"| 🔢 Events | {int(t.get('event_count') or 0)} |")
    if meta.get("model_name"):
        lines.append(f"| 🤖 Aktives Modell | `{meta['model_name']}` |")
    lines.append("")

    # --- Provider-Breakdown ---
    providers = data.get("providers") or []
    if providers:
        lines.append("### 🔌 Breakdown nach Provider")
        lines.append("")
        lines.append("| Provider | Tokens | Kosten | Events |")
        lines.append("|---|---:|---:|---:|")
        for p in providers:
            lines.append(
                f"| `{p['provider']}` | {human_tokens(p['total'])} "
                f"| {human_cost(p['cost'])} | {p['event_count']} |"
            )
        lines.append("")

    # --- Model-Breakdown ---
    models = data.get("models") or []
    if models:
        lines.append("### 🧬 Top-Modelle")
        lines.append("")
        lines.append("| Provider | Modell | Tokens | Kosten |")
        lines.append("|---|---|---:|---:|")
        for m in models:
            lines.append(
                f"| `{m['provider']}` | `{m['model']}` | "
                f"{human_tokens(m['total'])} | {human_cost(m['cost'])} |"
            )
        lines.append("")

    # --- Agent-Breakdown ---
    agents = data.get("agents") or []
    # Nur ausgeben wenn es mehr als einen Agent gibt (sonst redundant)
    if len(agents) > 1:
        lines.append("### 🧑‍💻 Breakdown nach Agent")
        lines.append("")
        lines.append("| Agent | Tokens | Kosten | Events |")
        lines.append("|---|---:|---:|---:|")
        for a in agents:
            lines.append(
                f"| `{a['agent']}` | {human_tokens(a['total'])} "
                f"| {human_cost(a['cost'])} | {a['event_count']} |"
            )
        lines.append("")

    # --- OpenRouter Live-Credits ---
    credits = meta.get("openrouter_credits")
    if credits and isinstance(credits, dict):
        data_obj = credits.get("data", {}) if isinstance(credits.get("data"), dict) else {}
        total_credits = data_obj.get("total_credits")
        total_usage = data_obj.get("total_usage")
        remaining = None
        if isinstance(total_credits, (int, float)) and isinstance(total_usage, (int, float)):
            remaining = total_credits - total_usage
        lines.append("### 🏦 OpenRouter Account (Live)")
        lines.append("")
        lines.append("| Metrik | Wert |")
        lines.append("|---|---:|")
        if total_credits is not None:
            lines.append(f"| Total Credits | ${float(total_credits):.4f} |")
        if total_usage is not None:
            lines.append(f"| Total Usage | ${float(total_usage):.4f} |")
        if remaining is not None:
            lines.append(f"| **Remaining** | **${remaining:.4f}** |")
        lines.append("")

    # --- Footer ---
    lines.append("---")
    lines.append(
        f"<sub>Report generiert: "
        f"{datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</sub>"
    )
    lines.append("")
    return "\n".join(lines)


def render_empty_report(reason: str) -> str:
    return (
        "## 💰 OpenRouter Token Cost Report\n\n"
        f"⚠️ Keine Token-Daten verfügbar: {reason}\n\n"
        "_Das oh-my-tokens Plugin konnte keine Events aufzeichnen. Mögliche Ursachen: "
        "der OpenCode-Run ist fehlgeschlagen bevor die erste LLM-Antwort kam, das "
        "Plugin wurde nicht geladen (npm install fehlgeschlagen?), oder der SQLite-"
        "Pfad ist abweichend._\n"
    )


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #

def write_summary(markdown: str) -> None:
    """Schreibe in $GITHUB_STEP_SUMMARY und stdout."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write(markdown)
                fh.write("\n")
            print(f"[token-report] Written to $GITHUB_STEP_SUMMARY ({summary_path})")
        except OSError as exc:
            print(f"[token-report] Could not write summary: {exc}", file=sys.stderr)
    # Immer auch auf stdout spiegeln für Run-Logs
    print("\n" + markdown)


def write_compact_summary(data: dict[str, Any], meta: dict[str, Any]) -> None:
    """Schreibe eine kompakte Einzeiler-Zusammenfassung nach /tmp/token_summary.txt.

    Format: 💰 Kosten: $X.XX | 🤖 Modell: name
    Diese Datei wird vom Verification-Skript gelesen und programmatisch an den
    KI-Kommentar angehängt.
    """
    t = data.get("totals", {})
    cost = human_cost(t.get("cost", 0))
    model = meta.get("model_name") or meta.get("model_id") or "unknown"

    summary = f"💰 Kosten: {cost} | 🤖 Modell: `{model}`"

    summary_path = "/tmp/token_summary.txt"
    try:
        with open(summary_path, "w", encoding="utf-8") as fh:
            fh.write(summary + "\n")
        print(f"[token-report] Compact summary written to {summary_path}")
    except OSError as exc:
        print(f"[token-report] Could not write compact summary: {exc}", file=sys.stderr)


def main() -> int:
    meta: dict[str, Any] = {
        "model_id": os.environ.get("OPENCODE_MODEL_ID"),
        "model_name": os.environ.get("OPENCODE_MODEL_NAME"),
    }

    # Optional: Live-Credits
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if api_key:
        meta["openrouter_credits"] = fetch_openrouter_credits(api_key)

    db_path = find_db_path()
    if db_path is None:
        write_summary(render_empty_report(
            "SQLite-DB nicht gefunden unter ~/.local/share/opencode/oh-my-tokens/"
        ))
        write_compact_summary({"totals": {}}, meta)
        return 0

    print(f"[token-report] Reading SQLite DB: {db_path}")
    try:
        # read-only connection via URI, damit wir nicht versehentlich die
        # WAL-Datei stören, während das Plugin evtl. noch offen ist.
        uri = f"file:{db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        try:
            data = query_run_totals(conn)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        write_summary(render_empty_report(f"SQLite-Fehler: {exc}"))
        write_compact_summary({"totals": {}}, meta)
        return 0

    totals = data["totals"]
    if not totals or int(totals.get("event_count") or 0) == 0:
        write_summary(render_empty_report("Keine Events in den letzten 6 Stunden."))
        write_compact_summary(data, meta)
        return 0

    write_summary(render_report(data, meta))
    write_compact_summary(data, meta)
    return 0


if __name__ == "__main__":
    sys.exit(main())
