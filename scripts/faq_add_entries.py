#!/usr/bin/env python3
"""
faq_add_entries.py: adds missing scenarios to faq-server/data/faq.json.

    python3 scripts/faq_add_entries.py --check     # show what would be added
    python3 scripts/faq_add_entries.py --apply     # add them (with a backup)

Existing entries are not changed. No restart is needed after --apply:
faq-server picks up the changed file on the next search (P-03).
"""
import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path

FAQ = Path(__file__).resolve().parents[1] / 'faq-server' / 'data' / 'faq.json'

NEW = [
    {
        "id": "service_not_working",
        "requires_client_id": True,
        "keywords": {
            "ro": ["nu merge youtube", "nu se deschide youtube", "nu merge facebook",
                   "nu merge whatsapp", "nu merge instagram", "nu merge netflix",
                   "nu se deschide site", "nu se incarca pagina", "nu pot intra pe site",
                   "nu merge aplicatia", "nu merge jocul", "nu merge tiktok",
                   "nu se deschid site-uri", "unele site-uri nu merg", "nu merge viber"],
            "ru": ["не работает ютуб", "не открывается ютуб", "не работает фейсбук",
                   "не работает ватсап", "не работает инстаграм", "не открывается сайт",
                   "не грузится страница", "не могу зайти на сайт", "не работает приложение",
                   "не работает игра", "не работает тикток", "некоторые сайты не открываются",
                   "не работает вайбер", "не открывается страница"]
        },
        "answers": {
            "ro": "Verificăm conexiunea dumneavoastră. Vă rugăm să ne spuneți codul de client din factură.",
            "ru": "Давайте проверим ваше подключение. Назовите, пожалуйста, номер клиента из счёт-фактуры."
        }
    },
    {
        "id": "wifi_not_working",
        "requires_client_id": True,
        "keywords": {
            "ro": ["nu merge wifi", "nu functioneaza wifi", "nu se conecteaza la wifi",
                   "wifi fara internet", "nu vad reteaua wifi", "s-a pierdut wifi",
                   "routerul nu da internet", "nu merge routerul"],
            "ru": ["не работает вайфай", "не работает wifi", "не подключается к вайфаю",
                   "вайфай без интернета", "не вижу сеть wifi", "роутер не раздаёт интернет",
                   "не работает роутер"]
        },
        "answers": {
            "ro": "Verificăm conexiunea și echipamentul dumneavoastră. Vă rugăm să ne spuneți codul de client din factură.",
            "ru": "Проверим подключение и оборудование. Назовите, пожалуйста, номер клиента из счёт-фактуры."
        }
    },
    {
        "id": "intermittent_internet",
        "requires_client_id": True,
        "keywords": {
            "ro": ["se intrerupe internetul", "cade internetul", "internetul se deconecteaza",
                   "merge cu intreruperi", "se pierde conexiunea", "internetul pica des",
                   "conexiune instabila"],
            "ru": ["интернет прерывается", "интернет пропадает", "отключается интернет",
                   "связь обрывается", "интернет падает", "нестабильное соединение"]
        },
        "answers": {
            "ro": "Verificăm conexiunea dumneavoastră. Vă rugăm să ne spuneți codul de client din factură.",
            "ru": "Проверим ваше подключение. Назовите, пожалуйста, номер клиента из счёт-фактуры."
        }
    },
    {
        "id": "working_hours",
        "requires_client_id": False,
        "keywords": {
            "ro": ["programul de lucru", "program de lucru", "pana la ce ora lucrati",
                   "de la ce ora lucrati", "cand sunteti deschisi", "lucrati sambata",
                   "lucrati duminica", "orar"],
            "ru": ["график работы", "режим работы", "до скольки работаете",
                   "со скольки работаете", "когда вы работаете", "работаете в субботу",
                   "работаете в воскресенье"]
        },
        "answers": {
            "ro": "Programul nostru de lucru este de luni până vineri, între orele opt și treizeci și șaptesprezece și treizeci.",
            "ru": "Мы работаем с понедельника по пятницу, с восьми тридцати до семнадцати тридцати."
        }
    },
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()

    data = json.loads(FAQ.read_text(encoding='utf-8'))
    have = {e['id'] for e in data['faq']}
    missing = [e for e in NEW if e['id'] not in have]

    print(f'сейчас записей: {len(data["faq"])}')
    print('уже есть: ' + ', '.join(sorted(have)))
    if not missing:
        print('НОВЫХ НЕТ — менять нечего')
        return
    print('будут добавлены: ' + ', '.join(e['id'] for e in missing))

    if not a.apply:
        print('\n(проверка; чтобы добавить, запустите с --apply)')
        return

    backup = FAQ.with_name(f'faq.json.bak-{datetime.now():%Y%m%d_%H%M}')
    shutil.copy2(FAQ, backup)
    data['faq'].extend(missing)
    FAQ.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    json.loads(FAQ.read_text(encoding='utf-8'))  # make sure the file is still valid JSON
    print(f'\nOK: записей стало {len(data["faq"])}, бэкап: {backup.name}')


if __name__ == '__main__':
    main()
