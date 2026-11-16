# יאללה־סע · נסיעות ריקות (מודול, מפעילים כדיירים)

- פתיחה: `index.html` (או שרת מקומי: `python -m http.server 8770 --directory dashboard`).
- כניסה: אימייל וסיסמה (Supabase Auth). אין הרשמה פתוחה: רק מי שהוזמן. הרשאות: צופה / עורך / מנהל מפעיל, ומנהל מערכת. ניהול משתמשים: כפתור "משתמשים" (Edge Function `manage_users`).
- מפעילים: `pipeline/operators.json` (פעיל / לא פעיל, גבול יום שירות, סוד מפתח הנתונים). נתונים לכל מפעיל ב-`data/<slug>/`.
- `legacy.html`: הכניסה הישנה בסיסמה המשותפת, זמנית עד המעבר המלא.
- עדכון אוטומטי: כל לילה ה-Action `nightly-day` מוסיף את יום אתמול לכל מפעיל פעיל. מילוי ימים חסרים: Actions → nightly-day → Run workflow עם from/to (ו-operator).
- הוספת יום ידנית: `python dashboard/build_day.py YYYY-MM-DD --op derech-egged` (הקוד ב-`pipeline/`; דורש `config/.data_key_<slug>` ו-`pip install tzdata`).
- קישור ישיר: `index.html?op=derech-egged&day=2026-11-10&veh=23404402`.
- הגדרות צי (חניונים, דלק, טווחים) נשמרות ב-Supabase ונערכות במסך ההגדרות; נסיעות לילה מחושבות בדפדפן.
- רפרנס עיצוב מאושר: `design/reference-v1.webp`.
