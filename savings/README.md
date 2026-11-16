# הצעות חיסכון (savings engine)

החלפת קטעי עבודה בין שני אוטובוסים של אותו מפעיל, בלי לשנות את לוח הזמנים. כל סידור מתחיל ומסתיים כמו היום
(החלפת "סוף יום" רק כשהכלל מתיר וחניוני שני הרכבים ידועים).

| קובץ | תפקיד |
|---|---|
| `engine.js` | המנוע (JS טהור, node + worker + דף). `run()`, `adaptDay()`, `RULES_META`, `DEFAULT_RULES`, `toCSV()` |
| `worker.js` | Web Worker שמריץ את המנוע מחוץ ל־UI |
| `panel.js` / `panel.css` | המסך: עורך כללים (מפעיל + עקיפות לפי קו), הרצה, רשימה, "למה לא", פירוט, CSV |
| `demo.html` | הדגמה מקומית עם נתונים **סינתטיים** בלבד (`python -m http.server -d savings`) |
| `tests/` | `node --test savings/tests/engine.test.js` (הנתונים האמיתיים נטענים מוצפנים עם המפתח המקומי; בלעדיו המבחנים האלה מדולגים) |

## כללים
`RULES_META` ב־`engine.js` הוא מקור האמת (שם, יחידה, ברירת מחדל, איך מתמזגים).
כלל של קו מחליף את ערך המפעיל לאותו קו; כשבדיקה נוגעת בכמה קווים — הערך המחמיר מביניהם.
נשמר בטבלה `rule_sets` (operator_id, scope 'operator'|'line', line_key, rules jsonb) דרך `save_rule_set()`
(migration `supabase/migrations/20261116170000_rule_sets.sql`, כבר הוחל ב־Supabase). רק ערכים ששונו מברירת המחדל נשמרים.

## חיבור ל־index.html (אחרי ש־continuity-fix מסיים)
```html
<link rel="stylesheet" href="savings/panel.css">
<script src="savings/engine.js"></script>
<script src="savings/panel.js"></script>
```
```js
const savingsUI = SavingsPanel.mount(document.getElementById("savings"), {
  operatorId: OP.id,
  canEdit,
  days: () => days.map(d => d.day ?? d),          // רשימת הימים שנבנו
  currentDay: () => D.day,
  loadDay: day => loadDayDecrypted(day),           // אותה פונקציה שטוענת ומפענחת day_<D>.js
  roadEntries: () => [...ROAD].map(([k, v]) => [k, v.km, v.min]),
  fetchRoad: async (pairs, cb) => { let i = 0; for (const [a, b] of pairs) { await roadKm(a, b); cb(++i, pairs.length); } /* + upsert ל־road_cache כמו ensureRoad */ },
  branchOf: veh => MODEL.branchOf(veh, D.day).b,
  depotOf: veh => { const d = MODEL.depotFor?.(veh); return d && d.lat ? [+d.lat, +d.lon] : null; },
  dcp: () => eff().S.driver_change_points,
  getRows, rpc,
  onDraft: dirty => markUnsaved("savings", dirty),  // מודל הטיוטה/שמירה של האפליקציה
  getBlocks: day => applyBlockEdits(day),           // עריכות ידניות של continuity-fix (block_edits)
});
// אחרי שמירת עריכת בלוק: savingsUI.blocksChanged()
// כשמחליפים יום: savingsUI.setDay()   · כשמחליפים מפעיל: savingsUI.destroy() ו־mount מחדש
```
שמות הפונקציות בצד index.html (`loadDayDecrypted`, `markUnsaved`, `depotFor`) הם לפי מה שיהיה אחרי continuity-fix — לבדוק בזמן החיבור.

## מתאם הנתונים: `getBlocks(day)`
המנוע קורא בלוקים של רכבים רק דרך `getBlocks()` ב־`engine.js` (כולל `FIELDS`):
- **עריכות ידניות** (`block_edits` של continuity-fix): ה־host מעביר `getBlocks: day => applyBlockEdits(day)` ב־`run` / ב־panel host; המנוע לא קורא את הטבלה בעצמו.
- **נקודות קצה**: `a_gps`/`b_gps` אם קיימים, אחרת `a`/`b`, ובקבצים ישנים — מתוך `day.routes`.
- **דגלים**: `false_start` ו־`dup` נזרקים; `edited`, `gps_incomplete`/`incomplete` נשמרים ומוצגים ("איכות נתונים", ✎ בציר הזמן).
- **שגיאת נתונים לא פתורה** (ברמת רכב `data_errors`/`errors` בלי `resolved`, פריט `error`/`unresolved`, נסיעה בלי קואורדינטות,
  נסיעה ריקה בלי ק"מ, נסיעות חופפות) ⇒ הרכב לא נבדק ומופיע ברשימה "לא נבדק: שגיאת נתונים" עם הסיבה.
אם שמות השדות משתנים, משנים רק את `FIELDS` (או מעבירים `fields`).

## הנחות שמוצגות למשתמש
- הנהג נשאר עם האוטובוס (אלא אם מפעילים "החלפה רק בנקודת החלפת נהגים").
- תקנה 168(א)(3): נספר זמן נהיגה (נסיעות + נסיעה ריקה); הפסקה = המתנה פחות זמן הנסיעה הריקה.
- יציבות: החיבורים שההחלפה שוברת (sched+קו → sched+קו) צריכים לחזור בימים להשוואה: קודם אותו יום בשבוע, אחר כך ימים סמוכים מאותו סוג.
- מרחק "הערכה" = קו אווירי × 1.35 (כמו בדשבורד) עד שמרחק הכביש מגיע מ־road_cache/OSRM; מסומן בכל מקום.
