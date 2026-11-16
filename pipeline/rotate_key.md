# החלפת מפתח נתונים (rotation) / ביטול גישה

כל מפעיל מצפין את קבצי הימים שלו (`data/<slug>/day_*.js`, `ends_*.js`) במפתח AES-256 משלו.
הקבצים ציבוריים ב־GitHub Pages, ולכן מי שהחזיק פעם את המפתח יכול לפענח אותם. הסרת משתמש מבטלת את הגישה שלו
**לנתונים חדשים** רק אחרי החלפת מפתח.

## מתי מחליפים
- כשמסירים משתמש, משביתים אותו או מורידים לו את הגישה למפעיל (אחרי ההסרה בחדר הבקרה, לא לפני).
- כשיש חשד שהמפתח דלף (מחשב שאבד, צילום מסך, וכו').
- פעם בשנה, גם בלי סיבה.

## איך זה בנוי
- בכל קובץ מוצפן יש מזהה מפתח: `{kid:"k202611171030", iv:..., ct:...}`. קבצים ישנים בלי `kid` שייכים ל־`k0`.
- ב־DB (`private.data_key`) לכל מפעיל: מפתח `current` אחד, אולי `previous` אחד (רק בזמן החלפה), ו־`retired` (בלי חומר מפתח).
- `get_operator_key(op)` מחזיר לחבר במפעיל `{"current": kid, "keys": {kid: base64}}`: הנוכחי והקודם בלבד. הדפדפן בוחר מפתח לפי ה־`kid` של הקובץ.
- המפתח החדש **נוצר בתוך ה־DB** ויוצא ממנו רק מוצפן למפתח PGP חד־פעמי שנוצר במחשב המקומי. הוא לא עובר בצ'אט, בטרמינל או בלוג.
- מקומית: `config/.data_key_<slug>` = `<kid>:<base64>` (אותו טקסט כמו ה־GitHub secret), ו־`config/.keyring_<slug>.json` שומר גם מפתחות ישנים כדי שאפשר יהיה לפענח ולהצפין מחדש. `config/` לא נכנס ל־git.

## הפקודות
דרוש: `node`, `python`, `gpg` (מגיע עם Git for Windows), `gh` מחובר לחשבון david-transit.
לא להריץ בזמן שה־nightly רץ (03:00–04:30 UTC). הסקריפט בודק את זה.

```bash
node pipeline/rotate_key.js start derech-egged
```
- יוצר מפתח PGP חד־פעמי וקובץ SQL: `config/.rotate/derech-egged/rotate.sql`.
- את קובץ ה־SQL מריצים ב־Supabase SQL Editor. התוצאה היא ערך אחד שמתחיל ב־`-----BEGIN PGP MESSAGE-----`: שומרים אותו כ־`config/.rotate/derech-egged/wrapped.asc`.
- מרגע ההרצה: המפתח החדש `current`, הישן `previous`. משתמשים מחוברים ממשיכים לקרוא (הדפדפן מקבל את שניהם).

```bash
node pipeline/rotate_key.js apply derech-egged
```
- מפענח את המפתח החדש, מצפין מחדש את כל קבצי הימים וה־ends, בונה מחדש את `days.js`.
- מעדכן את ה־GitHub secret (`DATA_KEY` לדרך אגד, לפי `pipeline/operators.json`), עושה commit ו־push.

אחרי שה־GitHub Pages התעדכן (דקה–שתיים):
```bash
node pipeline/rotate_key.js finish derech-egged
```
- מדפיס שורת SQL (`select private.retire_previous_keys('derech-egged')`) להרצה ב־SQL Editor. מכאן המפתח הקודם לא נמסר לאף אחד ונמחק מה־DB.

עם `SUPABASE_ACCESS_TOKEN` (Personal Access Token של Supabase) בסביבה, שלבי ה־SQL רצים לבד: `start` ממשיך ישר ל־`apply`.

## בדיקה
- באתר: נכנסים ובוחרים יום. אם הנתונים נטענים, הדפדפן קיבל את המפתח החדש.
- המפתח הישן כבר לא פותח את הקבצים החיים:
  `node pipeline/decrypt.js <קובץ-מפתח-ישן> data/derech-egged/day_<יום>.js` צריך להיכשל עם `no key decrypts this file`.

## מגבלה שחשוב לזכור
הקבצים הישנים נשארים בהיסטוריית git של ה־repo הציבורי, מוצפנים במפתח הישן. מי שהחזיק את המפתח הישן ממשיך לקרוא את
**הימים שכבר פורסמו לפני ההחלפה**. ההחלפה מגינה על כל יום שנבנה אחריה. הגנה מלאה גם על העבר מחייבת להעביר את
הנתונים ל־Supabase Storage פרטי (גישה לפי RLS בכל בקשה); זה שלב עתידי.

## מפעיל חדש
1. שורה ב־`public.operators` ושורה ב־`pipeline/operators.json` עם `key_secret` חדש.
2. `node pipeline/rotate_key.js start <slug>` (בלי מפתח קודם זה פשוט יוצר את הראשון), ואז `apply`.
