#!/usr/bin/env python3
"""
diag_probe.py — находит управляющие IP коммутаторов в NetBox и проверяет SSH.

Запуск из ~/avr-infra:
    python3 scripts/diag_probe.py              # логин пробуется максимум на 3 устройствах
    python3 scripts/diag_probe.py --ssh-limit 10
    python3 scripts/diag_probe.py --ssh-limit 0   # только порт 22 + баннер, без логина

Только stdlib, зависимостей нет. Пароли не выводятся.
"""
import argparse
import csv
import ipaddress
import json
import re
import socket
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

MGMT_IF = re.compile(r"^(vlan|vl\d|mgmt|management|me\d|loopback|lo\d|vlanif)", re.I)


def load_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[k.strip()] = v
    return env


def nb_get_all(base, token, endpoint, params=""):
    """Пагинация через offset (ссылки next у NetBox указывают на старый адрес)."""
    out, offset, limit = [], 0, 500
    while True:
        url = f"{base}/api/{endpoint}/?limit={limit}&offset={offset}{params}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Token {token}", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        out.extend(data.get("results", []))
        if offset + limit >= data.get("count", 0):
            return out
        offset += limit


def strip_mask(addr):
    """Возвращает IPv4 без маски; IPv6 и мусор -> '' (пропускаются)."""
    a = (addr or "").split("/")[0].strip()
    try:
        return a if ipaddress.ip_address(a).version == 4 else ""
    except ValueError:
        return ""


def probe_22(ip, timeout=3.0):
    try:
        with socket.create_connection((ip, 22), timeout=timeout) as s:
            s.settimeout(timeout)
            try:
                banner = s.recv(128).decode(errors="replace").strip()
            except socket.timeout:
                banner = "(нет баннера)"
            return "open", banner
    except socket.timeout:
        return "timeout", ""
    except ConnectionRefusedError:
        return "refused", ""
    except OSError as e:
        return f"error:{e.errno}", ""


def vendor_guess(manufacturer, model, banner):
    s = f"{manufacturer} {model} {banner}".lower()
    for key, name in (("cisco", "Cisco"), ("zte", "ZTE"), ("zxr", "ZTE"),
                      ("d-link", "DLINK"), ("dlink", "DLINK"), ("mikrotik", "MikroTik"),
                      ("rosssh", "MikroTik"), ("huawei", "Huawei")):
        if key in s:
            return name
    return "?"


def test_ssh(ip, timeout=45):
    body = json.dumps({"host": ip}).encode()
    req = urllib.request.Request("http://127.0.0.1:5000/test-ssh", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode(errors='replace')}"
    except Exception as e:  # noqa: BLE001
        return f"ERR: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default=".env")
    ap.add_argument("--ssh-limit", type=int, default=3,
                    help="на скольких устройствах пробовать логин через /test-ssh")
    args = ap.parse_args()

    env = load_env(args.env)
    base = env.get("NETBOX_API_URL", "").rstrip("/")
    token = env.get("NETBOX_API_TOKEN", "")
    if not base or not token:
        sys.exit("В .env нет NETBOX_API_URL / NETBOX_API_TOKEN")
    print(f"NETWORK_USER={env.get('NETWORK_USER', '(пусто)')} "
          f"NETWORK_PASS_LEN={len(env.get('NETWORK_PASS', ''))} "
          f"NETWORK_ENABLE_LEN={len(env.get('NETWORK_ENABLE', ''))}")

    print(f"NetBox: {base} — выгружаю устройства и IP...")
    devices = nb_get_all(base, token, "dcim/devices")
    ips = nb_get_all(base, token, "ipam/ip-addresses", "&assigned_object_type=dcim.interface")
    print(f"  устройств: {len(devices)}, IP на интерфейсах: {len(ips)}")

    cand = {}  # ip -> row
    for d in devices:
        dt = d.get("device_type") or {}
        manu = (dt.get("manufacturer") or {}).get("name", "")
        model = dt.get("model") or dt.get("display") or ""
        pip = strip_mask((d.get("primary_ip") or {}).get("address"))
        if pip:
            cand[pip] = dict(ip=pip, device=d.get("name") or f"id{d['id']}",
                             manufacturer=manu, model=model, source="primary_ip")
    dev_by_id = {d["id"]: d for d in devices}
    for ip in ips:
        ao = ip.get("assigned_object") or {}
        ifname = ao.get("name") or ""
        dev = ao.get("device") or {}
        addr = strip_mask(ip.get("address"))
        if not addr or addr in cand or not MGMT_IF.match(ifname):
            continue
        d = dev_by_id.get(dev.get("id"), {})
        dt = d.get("device_type") or {}
        cand[addr] = dict(ip=addr, device=dev.get("name", "?"),
                          manufacturer=(dt.get("manufacturer") or {}).get("name", ""),
                          model=dt.get("model", ""), source=f"iface {ifname}")

    rows = sorted(cand.values(), key=lambda r: ipaddress.ip_address(r["ip"]))
    if not rows:
        sys.exit("Кандидатов не найдено: ни primary_ip, ни IP на Vlan/mgmt-интерфейсах.")
    print(f"  кандидатов в управляющие IP: {len(rows)}\nПроверяю порт 22...")

    with ThreadPoolExecutor(max_workers=32) as ex:
        for r, (st, banner) in zip(rows, ex.map(lambda r: probe_22(r["ip"]), rows)):
            r["port22"], r["banner"] = st, banner
            r["vendor"] = vendor_guess(r["manufacturer"], r["model"], banner)
            r["test_ssh"] = ""

    # логин — последовательно, Cisco первыми, стоп после 2 ошибок авторизации подряд
    open_rows = [r for r in rows if r["port22"] == "open"]
    open_rows.sort(key=lambda r: r["vendor"] != "Cisco")
    auth_fail = 0
    for r in open_rows[:max(args.ssh_limit, 0)]:
        print(f"  /test-ssh {r['ip']} ({r['device']}, {r['vendor']})...")
        res = test_ssh(r["ip"])
        r["test_ssh"] = " ".join(res.split())[:160]
        if re.search(r"auth|denied|password|credential", res, re.I) and not re.search(
                r'"(success|ok)"\s*:\s*true', res, re.I):
            auth_fail += 1
            if auth_fail >= 2:
                print("  2 ошибки авторизации подряд — останавливаюсь, чтобы не заблокировать учётку.")
                break
        else:
            auth_fail = 0

    print()
    fmt = "{:<15} {:<22} {:<8} {:<9} {:<28} {}"
    print(fmt.format("IP", "Устройство", "Вендор", "22/tcp", "Баннер", "test-ssh"))
    for r in rows:
        print(fmt.format(r["ip"], r["device"][:22], r["vendor"], r["port22"][:9],
                         r["banner"][:28], r["test_ssh"][:70]))

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    out = Path.home() / f"avr-infra_diag_probe_{stamp}.csv"
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["ip", "device", "vendor", "manufacturer", "model",
                                          "source", "port22", "banner", "test_ssh"])
        w.writeheader()
        w.writerows(rows)

    n = lambda st: sum(1 for r in rows if r["port22"] == st)  # noqa: E731
    print(f"\nИтого: open={n('open')} timeout={n('timeout')} refused={n('refused')}  →  {out}")


if __name__ == "__main__":
    main()
