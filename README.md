# דשבורד סידורי רכב ונסיעות ריקות (שלב 1)

- פתיחה: `index.html` (או שרת מקומי: `python -m http.server 8770 --directory dashboard`).
- עדכון אוטומטי: כל לילה ב-03:30 (שעון ישראל) ה-Action `nightly-day` מוסיף את יום אתמול. מילוי ימים חסרים: Actions → nightly-day → Run workflow עם from/to.
- הוספת יום ידנית: `python dashboard/build_day.py YYYY-MM-DD` (הקוד ב-`pipeline/`; דורש `config/.data_key` ו-`pip install tzdata`).
- קישור ישיר: `index.html?day=2026-11-10&veh=23404402`.
- הגדרות צי (חניונים, דלק, טווחים) נשמרות ב-Supabase ונערכות במסך ההגדרות; נסיעות לילה מחושבות בדפדפן.
- רפרנס עיצוב מאושר: `design/reference-v1.webp`.
