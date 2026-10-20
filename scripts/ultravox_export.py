#!/usr/bin/env python3
"""
ultravox_export.py: export the current Ultravox setup (agent + tools) to Markdown, without secrets.

    python3 scripts/ultravox_export.py          # ~/ultravox_export_<date>.md (safe to share)
    python3 scripts/ultravox_export.py --raw    # + ~/ultravox_tools_raw_<date>.json (CONTAINS SECRETS)
    python3 scripts/ultravox_export.py --check-ngrok   # exit code 1 if any tool still points at ngrok

The API key and agent ID come from .env (ULTRAVOX_API_KEY, ULTRAVOX_AGENT_ID). Stdlib only.
"""
import argparse
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

API = "https://api.ultravox.ai/api"


def load_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k.strip()] = v
    return env


def get(path, key):
    req = urllib.request.Request(f"{API}{path}", headers={"X-API-Key": key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def all_tools(key):
    out, url = [], "/tools?pageSize=100"
    while url:
        d = get(url, key)
        out += d.get("results", [])
        nxt = d.get("next")
        url = nxt.split("/api", 1)[1] if nxt else None
    return out


def tool_md(t):
    d = t.get("definition", {}) or {}
    http = d.get("http", {}) or {}
    lines = [f"### {t.get('name')}", "",
             f"- toolId: `{t.get('toolId')}`",
             f"- URL: `{http.get('baseUrlPattern')}`  method: `{http.get('httpMethod')}`",
             f"- timeout: `{d.get('timeout')}`  precomputable: `{d.get('precomputable', False)}`"]
    req = (d.get("requirements") or {}).get("httpSecurityOptions")
    if req:
        kinds = sorted({k for o in req.get("options", []) for k in (o.get("requirements") or o).keys()})
        lines.append(f"- security requirements: {', '.join(kinds)}"
                     + ("  ⚠️ Auth token — не нужен, удалить" if any('X-AVR' in k or len(k) > 30 for k in kinds) else ""))
    lines += ["", "Description:", "```text", (d.get("description") or "").strip(), "```", ""]
    dyn = d.get("dynamicParameters") or []
    if dyn:
        lines += ["| Dynamic | Location | Type | Required | Description |", "|---|---|---|---|---|"]
        for p in dyn:
            s = p.get("schema") or {}
            loc = (p.get("location") or "").replace("PARAMETER_LOCATION_", "").title()
            desc = (s.get("description") or "").replace("|", "/").replace("\n", " ")
            lines.append(f"| `{p.get('name')}` | {loc} | {s.get('type', '')} | {'yes' if p.get('required') else 'no'} | {desc} |")
        lines.append("")
    st = d.get("staticParameters") or []
    if st:
        lines.append("Static (значения скрыты): " + ", ".join(
            f"`{p.get('name')}` ({(p.get('location') or '').replace('PARAMETER_LOCATION_', '').title()})" for p in st))
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default=".env")
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--check-ngrok", action="store_true")
    a = ap.parse_args()

    env = load_env(a.env)
    key = env.get("ULTRAVOX_API_KEY")
    if not key:
        sys.exit("В .env нет ULTRAVOX_API_KEY")
    tools = all_tools(key)
    custom = [t for t in tools if "api.ultravox.ai" not in
              ((t.get("definition") or {}).get("http") or {}).get("baseUrlPattern", "api.ultravox.ai")]

    if a.check_ngrok:
        bad = [t.get("name") for t in custom
               if "ngrok" in (((t.get("definition") or {}).get("http") or {}).get("baseUrlPattern") or "")]
        if bad:
            print("Ещё на ngrok: " + ", ".join(bad))
            sys.exit(1)
        print("Ни один тулз не использует ngrok")
        return

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    md = [f"# Экспорт Ultravox — {datetime.now():%Y-%m-%d %H:%M}", ""]
    for var in ("ULTRAVOX_AGENT_ID", "ULTRAVOX_AGENT_ID_RU"):
        agent_id = env.get(var)
        if not agent_id:
            continue
        try:
            ag = get(f"/agents/{agent_id}", key)
            ct = ag.get("callTemplate", ag)
            md += [f"## Агент {ag.get('name')}", "", f"- id: `{agent_id}` (`{var}`)",
                   f"- model: `{ct.get('model')}`  voice: `{ct.get('voice')}`  languageHint: `{ct.get('languageHint')}`"
                   f"  temperature: `{ct.get('temperature')}`",
                   "- tools: " + ", ".join(
                       f"`{s.get('toolName') or s.get('nameOverride') or s.get('toolId')}`" for s in ct.get("selectedTools", [])),
                   "", "_Промпт не экспортируется — он ведётся в ultravox/prompts/ro.md / ultravox/prompts/ru.md._", ""]
        except Exception as e:  # noqa: BLE001
            md += [f"_Агент {var} не прочитан: {e}_", ""]
    md += ["## Наши тулзы", ""] + [tool_md(t) for t in custom]
    md += ["## Встроенные тулзы Ultravox", "", ", ".join(f"`{t.get('name')}`" for t in tools if t not in custom), ""]

    out = Path.home() / f"ultravox_export_{stamp}.md"
    out.write_text("\n".join(md), encoding="utf-8")
    print(f"→ {out}")
    if a.raw:
        raw = Path.home() / f"ultravox_tools_raw_{stamp}.json"
        raw.write_text(json.dumps(tools, ensure_ascii=False, indent=2), encoding="utf-8")
        raw.chmod(0o600)
        print(f"→ {raw}  (СЕКРЕТЫ! только на сервере)")


if __name__ == "__main__":
    main()
