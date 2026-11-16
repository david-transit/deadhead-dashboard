# דשבורד סידורי רכב ונסיעות ריקות (שלב 1)

- פתיחה: `index.html` (או שרת מקומי: `python -m http.server 8770 --directory dashboard`).
- הוספת יום: `python dashboard/build_day.py YYYY-MM-DD` (מוריד מ-Open Bus, מחשב ק"מ ריקים לפי כביש, ומעדכן את הדשבורד).
- קישור ישיר: `index.html?day=2026-11-10&veh=23404402`.
- הגדרות צי (חניונים, תחנות דלק/גז, טווחים): `config/depots.json` — ריקות עד שדוד ימלא. בשלב 2 יהיה מסך עריכה.
- רפרנס עיצוב מאושר: `design/reference-v1.webp`.
