#!/usr/bin/env python3
"""
ultravox_agent_clone.py — создать нового агента Ultravox копией существующего (ULTRAVOX_AGENT_ID)
с другим промптом, голосом, языком, приветствием и сообщениями при молчании.
Модель, тулзы, VAD, maxDuration и прочее копируются как есть.

Показать, что будет создано (ничего не меняет):
    python3 scripts/ultravox_agent_clone.py --name SupportBotRU --prompt-file ultravox/prompts/ru.md \
        --voice <voiceId> --language-hint ru --greeting 'Здравствуйте, ...' \
        --inactivity '45s=Могу чем-то помочь?' --inactivity '120s=Похоже, вас не слышно. ...'
Создать: то же самое + --apply. В конце печатается ID нового агента.

--inactivity 'ДЛИТЕЛЬНОСТЬ=ТЕКСТ' по порядку заменяет сообщения исходного агента;
поведение (например, отбой после второго) берётся у исходного сообщения с тем же номером.

Ключ и ID исходного агента берутся из .env (ULTRAVOX_API_KEY, ULTRAVOX_AGENT_ID). Только stdlib.
"""
import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ultravox_tool_params import load_env, req  # noqa: E402

SKIP = ('created', 'updated')


def list_agents(key):
    out, url = [], '/agents?pageSize=100'
    while url:
        st, d = req('GET', url, key)
        if st != 200:
            sys.exit(f'Не удалось получить список агентов: HTTP {st} {d}')
        out += d.get('results', [])
        nxt = d.get('next')
        url = ('/agents?' + nxt.split('?', 1)[1]) if nxt else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--prompt-file', required=True)
    ap.add_argument('--voice', required=True)
    ap.add_argument('--language-hint', required=True)
    ap.add_argument('--greeting', required=True)
    ap.add_argument('--inactivity', action='append', default=[], metavar='ДЛИТЕЛЬНОСТЬ=ТЕКСТ')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--env', default='.env')
    a = ap.parse_args()

    env = load_env(a.env)
    key, src_id = env.get('ULTRAVOX_API_KEY'), env.get('ULTRAVOX_AGENT_ID')
    if not key or not src_id:
        sys.exit('В .env нет ULTRAVOX_API_KEY или ULTRAVOX_AGENT_ID')

    st, src = req('GET', f'/agents/{src_id}', key)
    if st != 200:
        sys.exit(f'Не удалось прочитать исходного агента: HTTP {st} {src}')
    if any((ag.get('name') or '').lower() == a.name.lower() for ag in list_agents(key)):
        sys.exit(f'Агент с именем {a.name} уже существует — ничего не делаю')

    prompt = Path(a.prompt_file).read_text(encoding='utf-8').strip()
    ct = {k: copy.deepcopy(v) for k, v in (src.get('callTemplate') or {}).items() if k not in SKIP}
    ct['systemPrompt'] = prompt
    ct['voice'] = a.voice
    ct['languageHint'] = a.language_hint
    fs = ct.setdefault('firstSpeakerSettings', {}).setdefault('agent', {})
    fs['text'] = a.greeting

    old_msgs = ct.get('inactivityMessages') or []
    if a.inactivity:
        if len(a.inactivity) != len(old_msgs):
            sys.exit(f'У исходного агента {len(old_msgs)} сообщений при молчании, '
                     f'передано --inactivity: {len(a.inactivity)}')
        msgs = []
        for old, spec in zip(old_msgs, a.inactivity):
            dur, sep, text = spec.partition('=')
            if not sep or not text:
                sys.exit(f'--inactivity должен быть ДЛИТЕЛЬНОСТЬ=ТЕКСТ, получено: {spec}')
            m = dict(old)
            m['duration'], m['message'] = dur, text
            msgs.append(m)
        ct['inactivityMessages'] = msgs

    print(f"исходный агент: {src.get('name')}  →  новый: {a.name}")
    print(f"  модель: {ct.get('model')}  maxDuration: {ct.get('maxDuration')}")
    print(f"  тулзы: {', '.join(t.get('toolName') or t.get('nameOverride') or t.get('toolId') for t in ct.get('selectedTools') or [])}")
    print(f"  голос: {a.voice}  languageHint: {a.language_hint}")
    print(f"  приветствие: {a.greeting}")
    for m in ct.get('inactivityMessages') or []:
        print(f"  молчание {m.get('duration')}: {m.get('message')}"
              + (f"  [{m['endBehavior']}]" if m.get('endBehavior') else ''))
    print(f"  промпт: {a.prompt_file}, {len(prompt)} символов")

    if not a.apply:
        print('\n(проверка; чтобы создать, запустите с --apply)')
        return

    st, body = req('POST', '/agents', key, {'name': a.name, 'callTemplate': ct})
    if st >= 400:
        print(f'НЕ ПОЛУЧИЛОСЬ: HTTP {st}')
        print(json.dumps(body, ensure_ascii=False)[:800])
        sys.exit(1)
    new_id = body.get('agentId')
    st, chk = req('GET', f'/agents/{new_id}', key)
    ok = st == 200 and (chk.get('callTemplate') or {}).get('systemPrompt') == prompt
    print(f'\nOK (HTTP {st}): агент создан, agentId = {new_id}'
          + ('' if ok else '\nВНИМАНИЕ: промпт нового агента не совпадает с файлом — проверьте в дашборде'))


if __name__ == '__main__':
    main()
