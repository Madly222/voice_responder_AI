#!/usr/bin/env python3
"""
diag_report.py — список устройств, на которые НЕ удалось войти под NETWORK_USER.

Берёт последний ~/avr-infra_diag_probe_*.csv (от scripts/diag_probe.py),
группирует по устройству (у одного устройства может быть несколько IP)
и по причине. Устройство считается рабочим, если вход прошёл хотя бы по одному IP.

Запуск из ~/avr-infra:
    python3 scripts/diag_report.py
    python3 scripts/diag_report.py --csv ~/avr-infra_diag_probe_20260921_1228.csv
"""
import argparse
import collections
import csv
import glob
import os
from datetime import datetime
from pathlib import Path

ORDER = [
    "RADIUS/логин отказал",
    "SSH v1 — нужен telnet",
    "SSH открыт, логин не проверялся",
    "Отвергает вход (vty ACL)",
    "Нет ответа (фильтр/маршрут)",
    "Нет маршрута",
    "Прочее",
]


def reason(r):
    st, t = r["port22"], r["test_ssh"]
    if st == "open":
        if '"error":false' in t:
            return None
        if "Incompatible version" in t:
            return "SSH v1 — нужен telnet"
        if "authentication" in t.lower():
            return "RADIUS/логин отказал"
        if not t:
            return "SSH открыт, логин не проверялся"
        return "Прочее"
    if st == "refused":
        return "Отвергает вход (vty ACL)"
    if st == "timeout":
        return "Нет ответа (фильтр/маршрут)"
    if st.startswith("error"):
        return "Нет маршрута"
    return "Прочее"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    a = ap.parse_args()
    f = a.csv or max(glob.glob(os.path.expanduser("~/avr-infra_diag_probe_*.csv")),
                     key=os.path.getmtime)
    rows = list(csv.DictReader(open(f, encoding="utf-8")))

    by_dev = collections.defaultdict(list)
    for r in rows:
        by_dev[r["device"]].append(r)

    ok, groups = [], collections.defaultdict(list)
    for dev, rs in by_dev.items():
        if any(reason(r) is None for r in rs):
            ok.append(dev)
            continue
        # причина — по «лучшему» IP (open важнее refused, refused важнее timeout)
        best = min(rs, key=lambda r: ORDER.index(reason(r)))
        groups[reason(best)].append((dev, best["vendor"], [r["ip"] for r in rs]))

    lines = [f"Источник: {f}",
             f"Устройств всего: {len(by_dev)}, вход OK: {len(ok)}, "
             f"не удалось: {sum(len(v) for v in groups.values())}", ""]
    for k in ORDER:
        if k not in groups:
            continue
        items = sorted(groups[k], key=lambda x: (x[1], x[0]))
        lines.append(f"=== {k}: {len(items)} ===")
        for dev, ven, ips in items:
            lines.append(f"  {ven:<9} {dev:<28} {', '.join(ips)}")
        lines.append("")
    lines.append(f"=== Вход OK: {len(ok)} ===")
    lines += [f"  {d}" for d in sorted(ok)]

    text = "\n".join(lines)
    print(text)
    out = Path.home() / f"avr-infra_diag_failed_{datetime.now():%Y%m%d_%H%M}.txt"
    out.write_text(text + "\n", encoding="utf-8")
    print(f"\n→ {out}")


if __name__ == "__main__":
    main()
