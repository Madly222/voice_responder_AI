#!/usr/bin/env python3
"""
ultravox_prompt.py — найти и заменить фразу в промпте агента Ultravox (callTemplate.systemPrompt).

Проверка (ничего не меняет): сколько раз фраза встречается и где
    python3 scripts/ultravox_prompt.py --check 'până la treizeci de secunde'

Замена всех вхождений (перед заменой — полная копия агента в ~/ultravox_agent_backup_<дата>.json):
    python3 scripts/ultravox_prompt.py --replace 'până la treizeci de secunde' 'câteva secunde'
    (без --apply только покажет, что будет заменено)
    python3 scripts/ultravox_prompt.py --replace '...' '...' --apply

Вернуть промпт из копии:
    python3 scripts/ultravox_prompt.py --restore ~/ultravox_agent_backup_<дата>.json --apply

По умолчанию правится RO-агент; русский — ключом --agent ru (любой режим).

Ключ и ID агента берутся из .env (ULTRAVOX_API_KEY, ULTRAVOX_AGENT_ID / ULTRAVOX_AGENT_ID_RU). Только stdlib.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ultravox_tool_params import load_env, req  # noqa: E402


def get_agent(key, agent_id):
    status, agent = req('GET', f'/agents/{agent_id}', key)
    if status != 200:
        sys.exit(f'Не удалось прочитать агента: HTTP {status} {agent}')
    ct = agent.get('callTemplate') or {}
    if not isinstance(ct.get('systemPrompt'), str):
        sys.exit('У агента нет callTemplate.systemPrompt — править в дашборде')
    return agent, ct


def show_hits(prompt, phrase, width=60):
    count = prompt.count(phrase)
    print(f'«{phrase}»: найдено {count} раз(а)')
    pos = prompt.find(phrase)
    while pos != -1:
        line = prompt.count('\n', 0, pos) + 1
        a, b = max(0, pos - width), min(len(prompt), pos + len(phrase) + width)
        ctx = prompt[a:b].replace('\n', ' ⏎ ')
        print(f'  строка {line}: …{ctx}…')
        pos = prompt.find(phrase, pos + len(phrase))
    return count


def save_prompt(key, agent_id, ct, new_prompt):
    """Шлёт весь callTemplate с новым промптом и проверяет, что остальное не изменилось."""
    before = {k: v for k, v in ct.items() if k != 'systemPrompt'}
    payload = dict(ct)
    payload['systemPrompt'] = new_prompt
    status, body = req('PATCH', f'/agents/{agent_id}', key, {'callTemplate': payload})
    if status >= 400:
        print(f'НЕ ПОЛУЧИЛОСЬ: HTTP {status}')
        print(json.dumps(body, ensure_ascii=False)[:800])
        sys.exit(1)
    _, ct2 = get_agent(key, agent_id)
    if ct2.get('systemPrompt') != new_prompt:
        sys.exit('ВНИМАНИЕ: после сохранения промпт не совпадает с ожидаемым — проверьте в дашборде')
    changed = sorted(k for k in set(before) | set(ct2)
                     if k not in ('systemPrompt', 'created', 'updated')  # отметки времени меняются всегда
                     and before.get(k) != ct2.get(k))
    print(f'OK (HTTP {status}): промпт сохранён, длина {len(new_prompt)} символов')
    if changed:
        print('ВНИМАНИЕ: изменились и другие поля агента: ' + ', '.join(changed))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--check', metavar='ФРАЗА')
    g.add_argument('--replace', nargs=2, metavar=('СТАРОЕ', 'НОВОЕ'))
    g.add_argument('--restore', metavar='ФАЙЛ')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--agent', choices=('ro', 'ru'), default='ro')
    ap.add_argument('--env', default='.env')
    a = ap.parse_args()

    env = load_env(a.env)
    id_var = 'ULTRAVOX_AGENT_ID_RU' if a.agent == 'ru' else 'ULTRAVOX_AGENT_ID'
    key, agent_id = env.get('ULTRAVOX_API_KEY'), env.get(id_var)
    if not key or not agent_id:
        sys.exit(f'В .env нет ULTRAVOX_API_KEY или {id_var}')

    agent, ct = get_agent(key, agent_id)
    prompt = ct['systemPrompt']
    print(f"агент: {agent.get('name')}  промпт: {len(prompt)} символов\n")

    if a.check:
        show_hits(prompt, a.check)
        return

    if a.restore:
        saved = json.loads(Path(a.restore).expanduser().read_text(encoding='utf-8'))
        old = ((saved.get('callTemplate') or {}).get('systemPrompt'))
        if not isinstance(old, str):
            sys.exit('В файле нет callTemplate.systemPrompt')
        print(f'в копии: {len(old)} символов, сейчас: {len(prompt)}'
              + (' — совпадает, менять нечего' if old == prompt else ''))
        if old == prompt:
            return
        if not a.apply:
            print('\n(проверка; чтобы вернуть, запустите с --apply)')
            return
        save_prompt(key, agent_id, ct, old)
        return

    old, new = a.replace
    if not show_hits(prompt, old):
        sys.exit('Менять нечего')
    print(f'\nзаменить на: «{new}»')
    if not a.apply:
        print('\n(проверка; чтобы заменить, запустите с --apply)')
        return

    backup = Path.home() / f'ultravox_agent_backup_{datetime.now():%Y%m%d_%H%M%S}.json'
    backup.write_text(json.dumps(agent, ensure_ascii=False, indent=2), encoding='utf-8')
    backup.chmod(0o600)
    print(f'копия агента: {backup}')
    save_prompt(key, agent_id, ct, prompt.replace(old, new))


if __name__ == '__main__':
    main()
