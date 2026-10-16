#!/usr/bin/env python3
"""
ultravox_tool_params.py — проверить и поменять тулз в Ultravox: динамические параметры и таймаут.

Проверка (ничего не меняет):
    python3 scripts/ultravox_tool_params.py --check updateCall

Добавить параметры (по умолчанию request_summary и resolution для updateCall):
    python3 scripts/ultravox_tool_params.py --apply updateCall

Свой параметр:
    python3 scripts/ultravox_tool_params.py --apply updateCall \
        --param 'note:string:Any extra note about the call'

Таймаут (остальное в тулзе не меняется):
    python3 scripts/ultravox_tool_params.py --check diagnoseClient --timeout 15s
    python3 scripts/ultravox_tool_params.py --apply diagnoseClient --timeout 15s

Если тулз подключён к агенту и Ultravox блокирует изменение, скрипт сам отвяжет тулз,
применит правку и привяжет обратно (ключ --no-detach отключает это поведение).

Ключ и ID агента берутся из .env (ULTRAVOX_API_KEY, ULTRAVOX_AGENT_ID). Только stdlib.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = 'https://api.ultravox.ai/api'

DEFAULTS = {
    'updateCall': [
        ('request_summary', 'string',
         "One short sentence in the caller's language describing what the caller asked "
         "(e.g. 'Nu are internet de azi dimineata'). Send it as soon as the problem is clear."),
        ('resolution', 'string',
         "What you told or recommended to the caller, or how the case ended "
         "(e.g. 'Recomandat reboot router')."),
    ],
}


def load_env(path='.env'):
    env = {}
    for line in Path(path).read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k.strip()] = v
    return env


def req(method, path, key, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f'{API}{path}', data=data, method=method, headers={
        'X-API-Key': key, 'Accept': 'application/json', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors='replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'raw': raw[:500]}


def find_tool(key, name):
    status, data = req('GET', '/tools?pageSize=100', key)
    if status != 200:
        sys.exit(f'Не удалось получить список тулзов: HTTP {status} {data}')
    for t in data.get('results', []):
        if (t.get('name') or '').lower() == name.lower():
            return t
    sys.exit(f'Тулз "{name}" не найден')


def show(tool):
    d = tool.get('definition', {}) or {}
    print(f"тулз: {tool.get('name')}  id: {tool.get('toolId')}")
    print(f"  url: {(d.get('http') or {}).get('baseUrlPattern')}  timeout: {d.get('timeout')}")
    for p in d.get('dynamicParameters') or []:
        s = p.get('schema') or {}
        print(f"  dynamic: {p.get('name')} ({s.get('type')}, "
              f"{'required' if p.get('required') else 'optional'})")
    for p in d.get('staticParameters') or []:
        print(f"  STATIC : {p.get('name')} (значение скрыто)")


def agent_tools(key, agent_id):
    status, agent = req('GET', f'/agents/{agent_id}', key)
    if status != 200:
        return None, None
    ct = agent.get('callTemplate') or {}
    return agent, list(ct.get('selectedTools') or [])


def set_agent_tools(key, agent_id, agent, tools):
    # весь callTemplate целиком: меняем только selectedTools, остальное как было
    ct = {k: v for k, v in (agent.get('callTemplate') or {}).items() if k not in ('created', 'updated')}
    ct['selectedTools'] = tools
    status, body = req('PATCH', f'/agents/{agent_id}', key, {'callTemplate': ct})
    return status, body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tool', nargs='?', default='updateCall')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--param', action='append', default=[],
                    help='name:type:description')
    ap.add_argument('--timeout', help='новый таймаут тулза, например 15s')
    ap.add_argument('--no-detach', action='store_true')
    ap.add_argument('--env', default='.env')
    a = ap.parse_args()
    if a.timeout and not re.fullmatch(r'\d+(\.\d+)?s', a.timeout):
        sys.exit(f'--timeout должен быть вида 15s, получено: {a.timeout}')

    env = load_env(a.env)
    key = env.get('ULTRAVOX_API_KEY')
    # тулзы общие для RO и RU — при конфликте отвязываем от обоих
    agent_ids = [x for x in (env.get('ULTRAVOX_AGENT_ID'), env.get('ULTRAVOX_AGENT_ID_RU')) if x]
    if not key:
        sys.exit('В .env нет ULTRAVOX_API_KEY')

    wanted = []
    for spec in a.param:
        parts = spec.split(':', 2)
        if len(parts) < 2:
            sys.exit(f'--param должен быть name:type[:description], получено: {spec}')
        wanted.append((parts[0], parts[1], parts[2] if len(parts) > 2 else ''))
    if not wanted and not a.timeout:
        wanted = DEFAULTS.get(a.tool, [])
        if not wanted:
            sys.exit(f'Для "{a.tool}" нет параметров по умолчанию — укажите --param или --timeout')

    tool = find_tool(key, a.tool)
    show(tool)
    d = tool.get('definition', {}) or {}
    have = {(p.get('name') or '') for p in (d.get('dynamicParameters') or [])}
    missing = [w for w in wanted if w[0] not in have]
    timeout_change = bool(a.timeout) and d.get('timeout') != a.timeout

    if wanted:
        print('\nнужны параметры: ' + ', '.join(w[0] for w in wanted))
        if missing:
            print('ОТСУТСТВУЮТ: ' + ', '.join(w[0] for w in missing))
    if a.timeout:
        print(f"\nтаймаут: сейчас {d.get('timeout')}, нужно {a.timeout}"
              + ('' if timeout_change else ' — уже так'))
    if not missing and not timeout_change:
        print('ВСЁ НА МЕСТЕ — менять нечего')
        return

    if a.check or not a.apply:
        print('\n(проверка; чтобы поменять, запустите с --apply)')
        return

    new_def = dict(d)
    if missing:
        new_params = list(d.get('dynamicParameters') or [])
        for name, typ, desc in missing:
            new_params.append({
                'name': name,
                'location': 'PARAMETER_LOCATION_BODY',
                'schema': {'type': typ, 'description': desc},
                'required': False,
            })
        new_def['dynamicParameters'] = new_params
    if timeout_change:
        new_def['timeout'] = a.timeout
    payload = {'name': tool.get('name'), 'definition': new_def}
    tool_id = tool.get('toolId')

    def attempt():
        st, bd = req('PATCH', f'/tools/{tool_id}', key, payload)
        if st in (404, 405):
            st, bd = req('PUT', f'/tools/{tool_id}', key, payload)
        return st, bd

    status, body = attempt()
    conflict = status >= 400 and 'agent' in json.dumps(body).lower()

    if conflict and not a.no_detach and agent_ids:
        print('\nКонфликт с агентом — отвязываю тулз, правлю, возвращаю...')

        def is_ours(sel):
            return (sel.get('toolName') == tool.get('name')
                    or sel.get('toolId') == tool_id
                    or sel.get('nameOverride') == tool.get('name'))

        saved = []  # (id, agent, tools_before) — у кого тулз был и отвязан
        for aid in agent_ids:
            agent, tools_before = agent_tools(key, aid)
            if tools_before is None:
                print(f'  агент {aid} не прочитан — пропускаю')
                continue
            if not any(is_ours(t) for t in tools_before):
                continue
            backup = Path(f'/tmp/ultravox_agent_tools_backup_{aid[:8]}.json')
            backup.write_text(json.dumps(tools_before, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f"  {agent.get('name')}: копия списка тулзов — {backup}")
            st, bd = set_agent_tools(key, aid, agent, [t for t in tools_before if not is_ours(t)])
            if st >= 400:
                print(f"  НЕ удалось отвязать от {agent.get('name')}: HTTP {st} {bd}")
                break
            saved.append((aid, agent, tools_before))
        else:
            status, body = attempt()
        for aid, agent, tools_before in saved:
            st2, bd2 = set_agent_tools(key, aid, agent, tools_before)
            if st2 >= 400:
                print(f"ВНИМАНИЕ: тулз НЕ вернулся агенту {agent.get('name')} (HTTP {st2} {bd2}).")
                print('Верните его вручную: Agents → Tools → добавить ' + str(tool.get('name')))
            else:
                print(f"  тулз возвращён агенту {agent.get('name')}")

    if status >= 400:
        print(f'\nНЕ ПОЛУЧИЛОСЬ: HTTP {status}')
        print(json.dumps(body, ensure_ascii=False)[:800])
        print('Поменяйте вручную в дашборде (ULTRAVOX.md §3).')
        sys.exit(1)

    print(f'\nOK (HTTP {status}). Проверяю результат...\n')
    show(find_tool(key, a.tool))


if __name__ == '__main__':
    main()
