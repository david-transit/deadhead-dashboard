// ---- app version: bump with tools/bump_version.py (writes APP_VER here and version.json). A browser holding an older
// index.html sees a different version.json and reloads once with ?v=<new>, which bypasses the cached copy. ----
const APP_VER="2026-11-22.4";
(async()=>{try{const r=await fetch("version.json?t="+Date.now(),{cache:"no-store"});const j=await r.json();
  if(j.v&&j.v!==APP_VER){const k="ys_reload_"+j.v;if(sessionStorage.getItem(k)) return;sessionStorage.setItem(k,"1");
    const q=new URLSearchParams(location.search);q.set("v",j.v);location.replace(location.pathname+"?"+q+location.hash)}}catch{}})();
// ---- backend: Supabase Auth (email + password) + REST. Every row is protected by RLS (operator + role);
// the publishable key is public by design. User management runs in the manage_users Edge Function. ----
const SB="https://xghfcdgettrcdciwwzbl.supabase.co", KEY="sb_publishable_hCBsqYekz61JY6SFfT_sjw_-wj0QGXT";
const SITE=location.origin+location.pathname, SKEY="ys_session";
const lsGet=k=>{try{return localStorage.getItem(k)}catch{return null}}, lsSet=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}};
let SES=null; try{SES=JSON.parse(lsGet(SKEY)||"null")}catch{}
// idle timeout (M5): no click / key / scroll for idleMinutes (in any tab) ends the session; with unsaved drafts, twice that.
// A device the user marked as personal at the portal sign-in (ys_trust = expiry) has no idle sign-out until then.
// Durations: /assets/auth-settings.js (the portal's one settings file, David 2026-11-18); same defaults if it is missing.
const AUTHCFG=window.YS_AUTH||{trustHours:12,idleMinutes:30}, ACT="ys_act", TRUST="ys_trust", lastAct=()=>+lsGet(ACT)||0;
const idleMs=()=>(+lsGet(TRUST)||0)>Date.now()?Infinity:(+AUTHCFG.idleMinutes||30)*6e4;
const touchAct=()=>{const n=Date.now();if(n-lastAct()>20000) lsSet(ACT,String(n))};
if(SES&&Date.now()-lastAct()>idleMs()){const old=SES;SES=null;lsSet(SKEY,null); // revoke the stale session on the server too
  fetch(SB+"/auth/v1/token?grant_type=refresh_token",{method:"POST",headers:{apikey:KEY,"Content-Type":"application/json"},body:JSON.stringify({refresh_token:old.refresh_token})})
    .then(r=>r.ok?r.json():null).then(j=>j&&fetch(SB+"/auth/v1/logout",{method:"POST",headers:{apikey:KEY,Authorization:"Bearer "+j.access_token}})).catch(()=>{})}
["pointerdown","keydown","wheel","touchstart"].forEach(t=>addEventListener(t,touchAct,{passive:true,capture:true}));
setInterval(async()=>{if(!SES) return;const idle=Date.now()-lastAct(),drafts=typeof nDraft==="function"&&nDraft()>0;
  if(idle>idleMs()*(drafts?2:1)){try{await authPost("logout",{},SES.access_token)}catch{} setSes(null);location.replace(location.pathname)}},60000);
function setSes(j){SES=j?{access_token:j.access_token,refresh_token:j.refresh_token,expires_at:+j.expires_at||Math.floor(Date.now()/1000)+(+j.expires_in||3600),user:j.user||null}:null;
  lsSet(SKEY,SES?JSON.stringify(SES):null)}
async function http(url,opt={},ms=15000){const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),ms);
  try{const r=await fetch(url,{...opt,signal:ctl.signal});const t=await r.text();let j=null;try{j=t?JSON.parse(t):null}catch{}
    if(!r.ok){const e=new Error(j?[j.error_code,j.error,j.code,j.msg,j.message,j.error_description].filter(Boolean).join(" · ")||("שגיאה "+r.status):"שגיאה "+r.status);e.status=r.status;throw e}
    return j}
  finally{clearTimeout(tm)}}
const authPost=(path,body,tok)=>http(SB+"/auth/v1/"+path,{method:"POST",headers:{apikey:KEY,"Content-Type":"application/json",...(tok?{Authorization:"Bearer "+tok}:{})},body:JSON.stringify(body)});
let refreshing=null;
function refresh(){return refreshing??=(async()=>{try{
    const o=JSON.parse(lsGet(SKEY)||"null"); // another tab may have refreshed already
    if(o&&o.refresh_token!==SES.refresh_token&&o.expires_at-60>Date.now()/1000){SES=o;return}
    setSes(await authPost("token?grant_type=refresh_token",{refresh_token:SES.refresh_token}))}
  catch(e){if(e.status>=400&&e.status<500) setSes(null);throw e} finally{refreshing=null}})()}
async function token(){if(!SES) throw new Error("not_signed_in");if(SES.expires_at-60<Date.now()/1000) await refresh();if(!SES) throw new Error("not_signed_in");return SES.access_token}
async function sb(path,opt={},retry=true){
  try{return await http(SB+path,{...opt,headers:{apikey:KEY,"Content-Type":"application/json",Authorization:"Bearer "+await token(),...(opt.headers||{})}})}
  catch(e){if(e.status===401&&retry&&SES){await refresh();return sb(path,opt,false)}throw e}}
const rpc=(fn,args)=>sb("/rest/v1/rpc/"+fn,{method:"POST",body:JSON.stringify(args)});
const getRows=(t,qs)=>sb(`/rest/v1/${t}?${qs}`);
const upsert=(t,rows,on)=>sb(`/rest/v1/${t}?on_conflict=${on}`,{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(rows)});
const delRows=(t,qs)=>sb(`/rest/v1/${t}?${qs}`,{method:"DELETE",headers:{Prefer:"return=minimal"}});
const opq=()=>"operator_id=eq."+OP.id, dq=d=>"day=eq."+d, vq=v=>"veh=eq."+encodeURIComponent(v);
const DOMAIN="users.yalla-sa.app"; // internal sign-in address <username>@DOMAIN: never shown, never mailed
const ERR={invalid_credentials:"שם משתמש או סיסמה שגויים","Invalid login credentials":"שם משתמש או סיסמה שגויים",user_banned:"החשבון הושבת. פנה למנהל המערכת",disabled:"החשבון הושבת. פנה למנהל המערכת",
  "row-level security":"אין לך הרשאה לשנות את זה",not_allowed:"אין לך הרשאה לפעולה הזו","42501":"אין לך הרשאה לשנות את זה",not_signed_in:"צריך להיכנס מחדש",
  weak_password:"הסיסמה צריכה להיות לפחות 8 תווים, עם אותיות ומספרים","Password should be":"הסיסמה צריכה להיות לפחות 8 תווים, עם אותיות ומספרים",same_password:"הסיסמה החדשה זהה לישנה",
  wrong_password:"הסיסמה הנוכחית שגויה",temp_expired:"הסיסמה הזמנית פגה. לקבלת סיסמה חדשה כתבו לנו: support@yalla-sa.app",bad_email:"כתובת המייל לא תקינה.",not_recovery:"הקישור מהמייל לא תקף או שפג תוקפו (10 דקות). בקש קישור חדש.",bad_username:"שם משתמש: 3–32 תווים, אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון",username_taken:"שם המשתמש הזה כבר תפוס",
  bootstrap_done:"חשבון מנהל ראשי כבר נוצר. היכנס עם שם משתמש וסיסמה","rate limit":"יותר מדי ניסיונות. נסה שוב בעוד כמה דקות",over_request_rate_limit:"יותר מדי ניסיונות. נסה שוב בעוד כמה דקות",
  signup_disabled:"אין הרשמה עצמית. מנהל המערכת יוצר את המשתמשים",bad_input:"הנתונים לא תקינים",server_error:"שגיאה בשרת. נסה שוב",
  no_key:"אין גישה לנתוני המפעיל",mfa_required:"צריך להיכנס מחדש עם קוד האימות הדו־שלבי",mfa_enroll_required:"מנהל חייב אימות דו־שלבי: צא והיכנס שוב כדי להפעיל אותו",
  "Invalid TOTP code":"הקוד שגוי או שפג תוקפו. הקלד את הקוד שמוצג עכשיו באפליקציה",mfa_verification_failed:"הקוד שגוי או שפג תוקפו. הקלד את הקוד שמוצג עכשיו באפליקציה",
  password_change_not_allowed:"שינוי סיסמה רק דרך המסך של האתר",mfa_change_not_allowed:"לשינוי האימות הדו־שלבי צריך להיכנס עם קוד האימות",last_platform_admin:"חייב להישאר לפחות מנהל מערכת פעיל אחד",
  bad_code:"שם המשתמש או קוד השחזור שגויים, או שהקוד כבר נוצל",bad_email:"כתובת המייל לא תקינה",email_taken:"המייל הזה כבר משויך לחשבון אחר",too_large:"הנתונים גדולים מדי",missing_line:"צריך לבחור קו לתגבור"};
// password policy (server: manage_users v7): at least 8 characters, with a letter and a digit
const weakPw=pw=>pw.length<8||!/[A-Za-z]/.test(pw)||!/[0-9]/.test(pw);
// live check shown right under a temporary-password input in the control room: [class, text]
const pwState=pw=>{if(!pw) return ["muted","לפחות 8 תווים, עם אותיות באנגלית ומספרים"];
  const miss=[pw.length<8?`עוד ${8-pw.length} תווים (לפחות 8)`:"",!/[A-Za-z]/.test(pw)?"אותיות באנגלית":"",!/[0-9]/.test(pw)?"מספרים":""].filter(Boolean);
  return miss.length?["err","חסר: "+miss.join(", ")+(/[֐-׿]/.test(pw)&&!/[A-Za-z]/.test(pw)?". יש אותיות בעברית: המקלדת כנראה בעברית":"")]:["ok","✓ הסיסמה תקינה"]};
const pwShow=(inp,box)=>{if(!inp||!box) return;const [c,t]=pwState(inp.value);box.className="msg pwchk "+c;box.textContent=t;inp.setAttribute("aria-invalid",c==="err"?"true":"false")};
const errText=e=>{const m=String(e&&e.message||e);for(const k in ERR) if(m.includes(k)) return ERR[k];return /abort/i.test(m)?"אין תשובה מהשרת. נסה שוב":m};

// ---- operator (tenant) and role ----
let OP=null,OPS=[],ROLE=null,PLATFORM=false,ME=null,PROFILE=null,MS=[];
const ROLEHE={admin:"מנהל",editor:"עורך",viewer:"צופה"};
const canEdit=()=>PLATFORM||ROLE==="editor"||ROLE==="admin", canManage=()=>PLATFORM||MS.some(m=>m.role==="admin");
async function loadAccess(){
  ME=SES.user&&SES.user.id?SES.user:await http(SB+"/auth/v1/user",{headers:{apikey:KEY,Authorization:"Bearer "+await token()}});
  if(!SES.user){SES.user=ME;lsSet(SKEY,JSON.stringify(SES))}
  const [pr,pa,ms,ops]=await Promise.all([getRows("profiles","select=username,display_name,must_change_password,disabled&user_id=eq."+ME.id),getRows("platform_admins","select=user_id&user_id=eq."+ME.id),getRows("memberships","select=operator_id,role&user_id=eq."+ME.id),getRows("operators","select=id,slug,name,logo_url&order=name")]);
  PROFILE=pr[0]||null; PLATFORM=pa.length>0; OPS=ops||[]; MS=ms||[];
  const want=QP.get("op")||lsGet("ys_op"); OP=OPS.find(o=>o.slug===want)||OPS[0]||null;
  ROLE=OP?(ms.find(m=>m.operator_id===OP.id)?.role||(PLATFORM?"admin":null)):null;
  if(OP) lsSet("ys_op",OP.slug);
}
function applyOperator(){
  $("#op").textContent=OP.name; $("#bPva").hidden=!canEdit(); document.title=`יאללה־סע · נסיעות ריקות · ${OP.name}`;
  const lb=$("#opLogo"); lb.hidden=!OP.logo_url; lb.innerHTML=OP.logo_url?`<img src="${esc(OP.logo_url+(OP.logo_url.includes("?")?"&":"?")+"v="+APP_VER)}" alt="${esc(OP.name)}">`:"";
  const os=$("#opSel"); os.hidden=OPS.length<2; os.innerHTML=OPS.map(o=>`<option value="${esc(o.slug)}" ${o.id===OP.id?"selected":""}>${esc(o.name)}</option>`).join("");
  $("#bCtl").hidden=!canManage();
  $("#who").innerHTML=`${esc((PROFILE&&(PROFILE.display_name||PROFILE.username))||"")} ▾<br>${PLATFORM?"מנהל מערכת":esc(ROLEHE[ROLE]||"")}`;
  $("#meSec").hidden=!PLATFORM;
  {const vt=$('#sysTabs [data-tab="via_links"]');if(vt) vt.hidden=!PLATFORM}
  setTopMin(lsGet(prefKey("topmin"))==="1",false); applyDense();
}
document.getElementById("opSel").onchange=e=>{lsSet("ys_op",e.target.value);location.replace(location.pathname+"?op="+encodeURIComponent(e.target.value))};

// ---- state ----
const $=s=>document.querySelector(s);
// service-day clock: minutes from the service date's midnight; after midnight stays 24:00–27:59 (no wrap)
const fmt=m=>{m=Math.round(m);if(m<0) m+=1440;const h=Math.floor(m/60),mm=m%60;return String(h).padStart(2,"0")+":"+String(mm).padStart(2,"0")};
const nf=n=>n==null||isNaN(n)?"–":Number(n).toLocaleString("he-IL",{maximumFractionDigits:1});
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ymd=d=>d.toISOString().slice(0,10);
const clone=x=>JSON.parse(JSON.stringify(x));
const dl=d=>d?d.slice(8,10)+"."+d.slice(5,7):"";
const inPl=p=>/^(ליד|מיקום)/.test(p||"")?" "+esc(p):" ב"+esc(p), fromPl=p=>/^(ליד|מיקום)/.test(p||"")?" "+esc(p):" מ"+esc(p);
let D=null,cls="",sel=null,T0=240,T1=26*60;
const DEF={fuel_by_class:{"עירוני":"גז","בינעירוני":"סולר"},range_km_by_fuel:{"גז":null,"סולר":null},branches:["בני ברק","ירושלים"],forced_out_km:5};
let S={depots:[],fuel_stations:[],driver_change_points:[],stop_anchors:[],forced_legs:[],defaults:clone(DEF),vehicles:{}};
// saved choices of the operator (all days), keyed "day|veh" (night before day) and "day|veh|scheduled start minute"
let OVN={}, REIN={}, AUTOR={}, BLK={}, NOTES={}; // NOTES: my own saved leg notes (feedback to the product team)
// days of the current operator: data/<slug>/days.js (built by the pipeline); service day D = D hh:00 … D+1 hh:00 (operators.json)
let days=[],DAY_START_H=4,today="",yest="",DAYVER={},ENDSVER={},ENDS={};
const {hav,estKm,estMin,roadKey,addDays,OVMODES,LEGNAME}=DH;
const hasLoc=x=>x&&x.lat!=null&&x.lon!=null&&x.lat!==""&&x.lon!==""&&isFinite(parseFloat(x.lat))&&isFinite(parseFloat(x.lon));

// ---- the model (assets/core.js): nights as one entity across days, every km counted once on the day it is driven ----
// eff() = what the screen shows: saved values + local drafts (see "drafts" below)
let MODEL=null;
function model(){const e=eff();return MODEL=DH.Model({days,dayStartMin:DAY_START_H*60,ends:endsEff(),S:e.S,OVN:e.OVN,REIN:e.REIN,AUTOR:e.AUTOR,road:roadOf})}
const vset=v=>eff().S.vehicles[v.veh]||{};
const fuelFor=v=>vset(v).fuel||eff().S.defaults.fuel_by_class?.[v.cls]||null;
const rangeFor=v=>parseFloat(vset(v).range_km)||parseFloat(eff().S.defaults.range_km_by_fuel?.[fuelFor(v)])||null;
const vstats=v=>MODEL.vehicleDay(v,D.day);
// ---- accessible vehicles (vehicle settings "accessible": true, operator-scoped, editor+ through the drafts) ----
const ACCSVG='<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="5" fill="#1F5FBF"/><g fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="5.2" r="1.3" fill="#fff" stroke="none"/><path d="M11 7.6v6h4.4l2 4"/><path d="M11 10.4h3.6"/><path d="M8.6 10.6a4.6 4.6 0 1 0 6.3 5.9"/></g></svg>';
const isAcc=veh=>!!(eff().S.vehicles[veh]||{}).accessible;
const accIcon=veh=>isAcc(veh)?`<span class="acc" role="img" aria-label="רכב נגיש" title="רכב נגיש">${ACCSVG}</span>`:"";


// ---- road distances: shared cache in Supabase (road_cache), missing pairs computed with OSRM ----
const ROAD=new Map(), ROADPK="operator_id,a_lat,a_lon,b_lat,b_lon"; // cached per operator (M2)
async function loadRoad(){try{for(let off=0;;off+=1000){const rows=await getRows("road_cache",`select=a_lat,a_lon,b_lat,b_lon,km,min,meta&${opq()}&order=a_lat,a_lon,b_lat,b_lon&limit=1000&offset=${off}`)||[];
  rows.forEach(r=>ROAD.set(roadKey([r.a_lat,r.a_lon],[r.b_lat,r.b_lon]),{km:+r.km,min:+r.min,meta:r.meta||null}));if(rows.length<1000) break}}catch(e){console.warn("road cache",e)}}
// ---- station anchor points (settings "stop_anchors", per operator): a stop name -> the point where buses really enter the
// road (e.g. a terminal's exit). Every leg from / to that stop (day legs, nights, edited blocks) is routed from the anchor.
// Matched by the stop name as it appears in the data ("ירושלים, מרכז תחבורתי הארזים/בינעירוני", or the part after the city). ----
const pk=p=>(+p[0]).toFixed(5)+","+(+p[1]).toFixed(5);
let ANC={k:null,m:new Map()};
function anchors(){const L=(eff().S.stop_anchors||[]).filter(x=>hasLoc(x)&&(x.name||"").trim());
  const k=JSON.stringify(L)+"|"+Object.keys(window.DAY_DATA||{}).join()+"|"+Object.keys(ENDS).join();if(ANC.k===k) return ANC.m;
  const by=new Map(L.map(x=>[x.name.trim(),[+(+x.lat).toFixed(5),+(+x.lon).toFixed(5)]])), m=new Map();
  const see=(p,n)=>{if(!p||!n||p[0]==null) return;const x=by.get(n.trim())||by.get(n.split(",").slice(1).join(",").trim());if(x) m.set(pk(p),x)};
  if(by.size){for(const J of Object.values(window.DAY_DATA||{})) for(const v of J.vehicles) for(const i of v.items) if(i.kind==="trip"){see(i.a,i.frm);see(i.b,i.to)}
    for(const d of Object.values(ENDS)) for(const e of Object.values(d)){see([e[1],e[2]],e[4]);see([e[6],e[7]],e[9])}}
  ANC={k,m};return m}
const sub=p=>p&&anchors().get(pk(p))||p;
// a leg from / to an anchored stop is routed from the anchor, except a move inside the terminal (the other end within
// ANCH_LOCAL_KM of the stop, e.g. drop-off platform -> departure platform): that one stays as it is
const ANCH_LOCAL_KM=0.5;
// only the origin is anchored (David, 16.11): an anchor is the exit a bus takes out of the terminal; arrivals are routed to
// the stop itself (e.g. HaMag -> Arazim drop-off 3.5 km via Golda Meir, not 5.3 km around to the exit point)
function subPair(a,b){let A=sub(a);if(A!==a&&b&&hav(a,b)<ANCH_LOCAL_KM) A=a;return [A,b]}
// ---- approved bus-only links ("נקודות מעבר מאושרות", table via_links): only approved ones are used for routing.
// A cached road km is valid only if it was computed with the same set of relevant approved links (meta.vpc). ----
let VIAL=[], VIAOK=[];
async function loadVia(){try{VIAL=await getRows("via_links",`select=*&${opq()}&order=created_at`)||[]}catch(e){console.warn("via links",e);VIAL=[]}
  VIAOK=VIAL.filter(x=>x.approved_at).map(x=>({id:x.id,name:x.name,a:[+x.a_lat,+x.a_lon],b:[+x.b_lat,+x.b_lon],km:+x.link_km,both:!!x.both_ways,line:Array.isArray(x.geom)&&x.geom.length>1?x.geom:null}))}
const linksFor=(a,b)=>ROUTE.relevantLinks(a,b,VIAOK);
// ---- "מסלול תקין" (table route_ok): an origin -> destination pair (after the stop anchor, like the road_cache key) that
// an editor marked as a correct route, for all days. It hides only "עיקוף גדול" / "מסלול חשוד" of that pair, while the
// computed km stays within 0.3 km and 10% of the km at marking time; otherwise the warning comes back as
// "השתנה מאז שאושר". Marking and cancelling go through the drafts (DRAFT.rok: key -> row, null = cancel the saved row). ----
let ROK=[],ROKM=null,ROKV=-1;
async function loadRok(){try{ROK=await getRows("route_ok",`select=*&${opq()}&order=created_at`)||[]}catch(e){console.warn("route ok",e);ROK=[]}ROKM=null}
const rokKey=(A,B)=>pk(A)+">"+pk(B), rokRowKey=r=>rokKey([r.a_lat,r.a_lon],[r.b_lat,r.b_lon]);
function rokM(){if(ROKM&&ROKV===DV) return ROKM;const m=new Map();
  for(const r of ROK) m.set(rokRowKey(r),{...r,km:+r.km});
  for(const [k,x] of Object.entries(DRAFT.rok||{})) if(x==null) m.delete(k); else m.set(k,{...x,draft:true});
  ROKM=m;ROKV=DV;return m}
// a leg matches a marked pair by the exact routed pair, else by the same stop names (origin and destination, this
// direction), else by both ends within ROK_NEAR_KM (a GPS end point near the stop); "השתנה מאז שאושר" compares the leg's
// km with the km of that marked pair
const ROK_NEAR_KM=0.3;
function rokOf(i){if(!i.a||!i.b) return null;const [A,B]=subPair(i.a,i.b),m=rokM(),x=m.get(rokKey(A,B));if(x) return x;
  for(const r of m.values()) if(r.origin&&r.origin===i.frm&&r.destination&&r.destination===i.to) return r;
  for(const r of m.values()) if(hav(A,[+r.a_lat,+r.a_lon])<=ROK_NEAR_KM&&hav(B,[+r.b_lat,+r.b_lon])<=ROK_NEAR_KM) return r;
  return null}
const rokChanged=(r,km)=>{const d=Math.abs(km-r.km);return d>0.3||d>0.1*r.km};
// ---- "אומת מול נסיעות בפועל" (R51, David 22.11.2026): leg gv = [median km, passages] that buses in service drove that day
// between the same two points (pipeline/gps_verify.py). Close to the leg's km now (max(15%, 0.5 km): pipeline/config.json
// gps_verify tol_pct / tol_km, the same rule) = verified: not a problem, listed apart. Otherwise, or no passage: stays for a
// manual check, with the km in practice beside ours. Nothing from Google is used. ----
const GV_TOL={pct:15,km:0.5};
const gvOk=i=>!!(i.gv&&i.km!=null&&Math.abs(i.gv[0]-i.km)<=Math.max(GV_TOL.pct/100*i.km,GV_TOL.km));
const gvTxt=i=>i.gv?`בפועל ${kmTxt(i.gv[0])} ק״מ (${nf(i.gv[1])} ${i.gv[1]===1?"נסיעה":"נסיעות"} ב־GPS)`:"";
// a road warning (detour / suspicious route) that GPS of buses in service does not confirm: "לבדיקה ידנית" (R51, David 22.11.2026);
// no Google answer is shown in its place. A "time" problem alone is not a km question: no GPS text
const manual=(i,kinds)=>[...kinds].some(t=>t!=="time")&&!gvOk(i);
const gvCell=(i,kinds,cls="")=>manual(i,kinds)?`<span class="${cls} muted">${i.gv?`${gvTxt(i)}, לא תואם: לבדיקה ידנית`:"אין נסיעות GPS במקטע: לבדיקה ידנית"}</span>`:i.gv?`<span class="${cls}">${gvTxt(i)}</span>`:"";
function roadGet(a,b){const r=ROAD.get(roadKey(a,b));if(!r) return null;const ls=linksFor(a,b),vpc=r.meta&&r.meta.vpc;
  if((ls.length||(vpc&&vpc.length))&&!ROUTE.sameIds(vpc,ls.map(ROUTE.linkSig))) return null; // computed with another set of links
  return r}
const roadOf=(a,b)=>roadGet(...subPair(a,b));
// day legs from / to an anchored stop (road km from the anchor) or near an approved link (road km via the link when
// shorter): the pipeline km is kept as km_file; "wait" until the road km is computed
function anchorDay(J){if(!anchors().size&&!VIAOK.length) return J;let ch=false;
  const vs=J.vehicles.map(v=>{let vc=false;
    const items=v.items.map(i=>{if(i.kind!=="empty"||!i.a||!i.b||i.edited) return i;const [A,B]=subPair(i.a,i.b),moved=A!==i.a||B!==i.b;
      if(!moved&&!linksFor(A,B).length) return i;
      const r=roadGet(A,B);if(!r){vc=true;return {...i,wait:true,anch:moved||undefined}}
      if(!moved&&!(r.meta&&r.meta.via&&r.meta.via.id)) return i; // near a link but the link is not shorter: the day file stays
      vc=true;
      const n={...i,km:r.km,drive_min:r.min,anch:moved||undefined,km_file:i.km,rt:r.meta&&(r.meta.fix||r.meta.u||(r.meta.via&&r.meta.via.id))?r.meta:undefined},gap=n.end-n.start;delete n.tight;
      if(!n.overlap&&n.km>2&&(n.drive_min>gap+10||gap===0||n.km/(gap/60)>100)) n.tight=true;return n});
    if(!vc) return v;ch=true;
    return {...v,items,empty_day_km:Math.round(items.filter(i=>i.kind==="empty"&&!i.overlap).reduce((s,i)=>s+(+i.km||0),0)*10)/10}});
  return ch?{...J,vehicles:vs}:J}
function nightPairs(){const out=new Map(),put=(a,b)=>{[a,b]=subPair(a,b);out.set(roadKey(a,b),[a,b])};if(!D) return out;model();
  for(const v of D.vehicles){for(const l of vstats(v).n) if(l.a&&l.b&&!l.road) put(l.a,l.b);
    for(const i of v.items) if(i.kind==="empty"&&(i.est||i.wait)&&i.a&&i.b) put(i.a,i.b)} // legs of edited blocks, legs waiting for an anchor / link route
  return out}
let roadBusy=false,roadAgain=false,roadFail=0;
// OSRM through assets/route.js: U-turns, revisits, far snaps and motorway snaps at terminals are detected and re-routed
const RT=ROUTE.make({fetch:async u=>{const ctl=new AbortController(),tm=setTimeout(()=>ctl.abort(),10000);
  try{const r=await fetch(u,{signal:ctl.signal});return r.json()}finally{clearTimeout(tm)}},gapMs:60});
async function osrm(a,b){try{const r=await RT.smartLinks(a,b,linksFor(a,b));if(!r) return null;const {km,min,...meta}=r;return {km,min,meta}}catch{return null}}
const roadRow=(a,b,r)=>({operator_id:OP.id,a_lat:+(+a[0]).toFixed(5),a_lon:+(+a[1]).toFixed(5),b_lat:+(+b[0]).toFixed(5),b_lon:+(+b[1]).toFixed(5),km:+(+r.km).toFixed(2),min:+(+r.min).toFixed(1),meta:r.meta||null});
async function ensureRoad(){
  if(roadBusy){roadAgain=true;return} roadBusy=true;
  try{do{roadAgain=false;const todo=[...nightPairs().values()];let buf=[];if(todo.length) render();
    const flush=async()=>{if(!buf.length||!canEdit()) return;const rows=buf;buf=[];
      try{await upsert("road_cache",rows,ROADPK)}catch(e){console.warn("road save",e)}};
    // saved every 10 pairs (an editor who leaves the page keeps what was computed); a pair that failed (slow public
    // OSRM) is tried once more at the end of the pass
    const again=[];
    for(let i=0;i<todo.length;i++){const [a,b]=todo[i],r=await osrm(a,b);
      if(r){ROAD.set(roadKey(a,b),r);buf.push(roadRow(a,b,r))} else again.push(todo[i]);
      if(buf.length>=10) await flush();
      if(i%10===9) render();
      await new Promise(r=>setTimeout(r,150))}
    for(const [a,b] of again){await new Promise(r=>setTimeout(r,1500));const r=await osrm(a,b);
      if(r){ROAD.set(roadKey(a,b),r);buf.push(roadRow(a,b,r))} else roadFail++;if(buf.length>=10) await flush()}
    await flush(); if(todo.length) render();
  }while(roadAgain)}finally{roadBusy=false}}
const legKm=l=>l.km==null?"":`${l.road?nf(l.km)+" ק״מ לפי כביש":"כ־"+nf(l.km)+" ק״מ (הערכה"+(roadBusy?" · מחשב…":"")+")"}`;
const MISSTXT={depot:"לא הוגדר חניון לרכב או לעיר",depot_loc:"מיקום החניון לא הוגדר"};

// ---- branch (סניף): confirmed value in vehicles[veh].branch; otherwise auto from where it starts/ends over ±7 days ----
const branches=()=>{const b=(eff().S.defaults.branches||[]).map(x=>String(x).trim()).filter(Boolean);return b.length?b:DEF.branches};
const branchOf=v=>MODEL.branchOf(v.veh,D.day), autoBranch=v=>MODEL.autoBranch(v.veh,D.day);
const brBadge=v=>{const o=branchOf(v);return o.b?`<span class="badge br${o.auto?" auto":""}" title="${o.auto?"שיוך אוטומטי לפי המקום שבו הרכב מתחיל ומסיים את רוב הימים · לא מאושר":"סניף מאושר"}">${esc(o.b)}</span>`:""};
let brSig="";
function fillBr(){const bs=branches(),sig=bs.join("|");if(sig===brSig) return;brSig=sig;const el=$("#br"),cur=el.value;
  el.innerHTML=`<option value="">סניף: הכול</option>`+bs.map(b=>`<option value="${esc(b)}">סניף: ${esc(b)}</option>`).join("")+`<option value="__none">סניף: לא משויך</option>`;
  el.value=[...el.options].some(o=>o.value===cur)?cur:""}
// service classes present in the day (a vehicle of unknown class gets its own option, so the filter always adds up)
function fillCls(){const have=[...new Set(D.vehicles.map(v=>v.cls))],opts=["עירוני","בינעירוני",...have.filter(c=>!["עירוני","בינעירוני"].includes(c))];
  const el=$("#cls"),sig=opts.join("|");if(el.dataset.sig===sig) return;el.dataset.sig=sig;if(cls&&!opts.includes(cls)) cls="";
  el.innerHTML=`<option value="">סוג: הכול</option>`+opts.map(c=>`<option value="${esc(c)}">סוג: ${esc(c)}</option>`).join("");el.value=cls}
$("#cls").onchange=e=>{cls=e.target.value;render()};

// ---- automatic reinforcement: rides run in service that are not in the licensed GTFS schedule (pipeline: auto) ----
// no decision = pending, counted as reinforcement; "confirmed" = reinforcement; "rejected" = ordinary service trip.
// Key: day + vehicle + scheduled start minute (stable when a day is rebuilt).
const akey=(day,veh,sched)=>day+"|"+veh+"|"+sched;
const autoSt=(v,i)=>MODEL.autoSt(D.day,v.veh,i);
const AUTOTXT={pending:"ממתין לאישור",confirmed:"אושר כתגבור",rejected:"נדחה: נספר כנסיעה רגילה בשירות"};
const reinOf=(v,i)=>MODEL.reinOf(D.day,v.veh,i);

// ---- days, the cross-day index (ends) and the saved choices ----
const loadScript=src=>new Promise((ok,bad)=>{const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=bad;document.head.appendChild(s)});
async function initDays(){
  try{await loadScript(`data/${OP.slug}/days.js?v=${Date.now()}`)}catch{}
  const m=(window.OPDAYS||{})[OP.slug]||{days:[]}; days=(m.days||[]).slice().sort(); DAYVER=m.ver||{}; ENDSVER=m.ends||{}; DAY_START_H=m.day_start_hour??4;
  const now=new Date(Date.now()-new Date().getTimezoneOffset()*6e4-DAY_START_H*36e5); today=ymd(now); yest=ymd(new Date(now-864e5));
  $("#day").innerHTML=days.map(d=>`<option value="${d}">${d.split("-").reverse().join(".")}</option>`).join("");
  $("#fdDay").innerHTML=days.map(d=>`<option value="${d}">${fdDayTxt(d)}</option>`).join("");
  $("#bToday").disabled=!days.includes(today); $("#bYest").disabled=!days.includes(yest);
  $("#bToday").title=days.includes(today)?"":"אין עדיין נתונים להיום"; $("#bYest").title=days.includes(yest)?"":"אין נתונים לאתמול";
}
async function loadEnds(){ENDS={};
  await Promise.all(Object.keys(ENDSVER).map(async m=>{try{if(!(window.ENC_ENDS&&window.ENC_ENDS[m])) await loadScript(`data/${OP.slug}/ends_${m}.js?v=${ENDSVER[m]}`);
    Object.assign(ENDS,(await decryptEnc(window.ENC_ENDS[m])).days)}catch(e){console.warn("ends",m,e)}}))}
async function loadAll(t,cols,order){let out=[];for(let off=0;;off+=1000){const r=await getRows(t,`select=${cols}&${opq()}&order=${order}&limit=1000&offset=${off}`)||[];out=out.concat(r);if(r.length<1000) break}return out}
async function loadChoices(){
  const [o,r,a]=await Promise.all([loadAll("overnight_override","day,veh,mode,detail,note","day,veh"),
    loadAll("reinforcement","day,veh,start_min,km,line,route_frm,route_to,rein_km,before_km,after_km,note","day,veh,start_min"),
    loadAll("auto_rein_status","day,veh,start_min,status","day,veh,start_min")]);
  NOTES={};try{(await getRows("leg_notes",`select=id,day,veh,leg_start_min,kind,text,created_at&${opq()}&created_by=eq.${ME.id}&order=created_at`)||[]).forEach(x=>NOTES[x.id]=x)}catch(e){console.warn("notes",e)}
  BLK={};(await loadAll("block_edits","id,day,veh,action,payload,note,created_at,created_by","day,created_at,id")).forEach(x=>BLK[x.id]=x);
  try{const N={};(await rpc("edit_authors",{p_operator:OP.id})||[]).forEach(a=>N[a.user_id]=a.name); // set by the DB, not the browser
    Object.values(BLK).forEach(x=>{x.payload={...(x.payload||{}),by:N[x.created_by]||""}})}catch(e){console.warn("edit authors",e)}
  OVN={};o.forEach(x=>OVN[x.day+"|"+x.veh]=x); REIN={};r.forEach(x=>REIN[akey(x.day,x.veh,x.start_min)]=x); AUTOR={};a.forEach(x=>AUTOR[akey(x.day,x.veh,x.start_min)]=x.status)}
let CKEYS={}; // key id -> CryptoKey (current + previous during a key rotation; pipeline/rotate_key.md)
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function decryptEnc(e){const iv=b64(e.iv),ct=b64(e.ct); // files carry the id of their key; older files have none
  for(const k of e.kid&&CKEYS[e.kid]?[CKEYS[e.kid]]:Object.values(CKEYS)) try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv},k,ct)))}catch{}
  throw new Error("decrypt")}
const decryptDay=day=>decryptEnc(window.ENC_DAY[day]);
function loadDay(day,after){
  $("#day").value=day; $("#fdDay").value=day; $("#bToday").classList.toggle("on",day===today); $("#bYest").classList.toggle("on",day===yest);
  const go=async()=>{window.DAY_DATA=window.DAY_DATA||{};try{if(!window.DAY_DATA[day]) window.DAY_DATA[day]=await decryptDay(day)}catch(e){$("#gantt").innerHTML='<div class="empty-state">לא ניתן לפענח את נתוני היום הזה</div>';return}
    D=effDay(day);{const q=$("#q").value.trim();if(knownVeh(q)) sel=q}
    loadEditedNeighbours(day); if($("#dlgFind").open){const l=$("#fdLine").value;fillDirs();$("#fdLine").value=l;setTimeout(drawFind,0)}
    render();ensureRoad();if(sel) document.querySelector(`.row[data-v="${CSS.escape(sel)}"]`)?.scrollIntoView({block:"nearest"});after&&after()};
  if((window.DAY_DATA&&window.DAY_DATA[day])||(window.ENC_DAY&&window.ENC_DAY[day])) return go();
  $("#gantt").innerHTML='<div class="empty-state">טוען…</div>';
  const s=document.createElement("script"); s.src=`data/${OP.slug}/day_${day}.js?v=${encodeURIComponent(DAYVER[day]||APP_VER)}`; s.onload=go;
  s.onerror=()=>{$("#gantt").innerHTML='<div class="empty-state">לא ניתן לטעון את נתוני היום הזה</div>'}; document.head.appendChild(s);
}
// saved choices that no longer match the day's data (rebuilt day, vehicle not running): shown, never dropped silently
function orphans(){if(!D) return [];const e=eff(),out=[],vs=new Map(D.vehicles.map(v=>[v.veh,v]));
  for(const id of (D.edits&&D.edits.orphans)||[]){const x=e.BLK[id];if(x) out.push(`עריכה ידנית ברכב ${x.veh}: ${edDesc(x)} (הנסיעה לא נמצאה, העריכה לא הוחלה)`)}
  for(const [k,r] of Object.entries(e.OVN)){const [d,veh]=k.split("|");if(d===D.day&&!vs.has(veh)) out.push(`לילה לפני ${dl(d)} · רכב ${veh}: ${OVMODES.find(m=>m[0]===r.mode)?.[1]||r.mode} (הרכב לא פעל ביום הזה)`)}
  for(const [k,r] of Object.entries(e.REIN)){const [d,veh,sc]=k.split("|");if(d!==D.day) continue;const v=vs.get(veh);
    if(!v||!v.items.some(i=>i.kind==="empty"&&!i.overlap&&String(i.next_sched)===sc)) out.push(`תגבור קו ${r.line} · רכב ${veh} לפני הנסיעה של ${fmt(+sc)} (אין נסיעה ריקה מתאימה)`)}
  for(const [k,st] of Object.entries(e.AUTOR)){const [d,veh,sc]=k.split("|");if(d!==D.day) continue;const v=vs.get(veh);
    if(!v||!v.items.some(i=>i.kind==="trip"&&i.auto&&String(i.sched)===sc)) out.push(`החלטה על תגבור אוטומטי · רכב ${veh} ${fmt(+sc)}: ${AUTOTXT[st]} (הנסיעה לא נמצאה)`)}
  return out}

// ---- render ----
const pct=m=>((m-T0)/(T1-T0)*100);
function bar(c,a,b,txt,title,extra=""){const l=pct(a),w=Math.max(pct(b)-l,.25);return `<div class="bar ${c} ${extra}" style="left:${l}%;width:${w}%" title="${esc(title)}">${w>2.2?esc(txt):""}</div>`}
const legTitle=l=>`${LEGNAME[l.kind]}${l.depot?" · "+l.depot:""}${l.line?" · קו "+l.line:""}: ${l.km==null?MISSTXT[l.missing]||"חסר":legKm(l)} · ${fmt(l.start)}–${fmt(l.end)}${l.frm?` · ${l.frm} ← ${l.to||""}`:""}`;
function render(){
  if(!D) return;
  D=effDay(D.day)||D; model(); fillBr(); fillCls(); const br=$("#br").value, q=$("#q").value.trim(), acc=$("#acc").value;
  const all=D.vehicles.map(v=>[v,vstats(v)]);
  const vsAll=all.filter(([v])=>(!cls||v.cls===cls)&&(lineQ(q)||v.veh.includes(q))&&lineOk(v)&&(!br||(br==="__none"?!branchOf(v).b:branchOf(v).b===br))&&(!acc||(acc==="yes")===isAcc(v.veh)));
  const sum=f=>vsAll.reduce((a,[v,s])=>a+f(v,s),0);
  const emp=sum((v,s)=>s.emp), rein=sum((v,s)=>s.rein), nk=sum((v,s)=>s.nk), est=sum((v,s)=>s.est);
  const nOver=sum(v=>v.items.filter(i=>i.overlap).length), nDup=sum(v=>v.items.filter(i=>i.kind==="dup").length), nInc=sum(v=>v.items.filter(i=>i.incomplete).length);
  const miss=vsAll.filter(([,s])=>s.missing.length), open=vsAll.filter(([,s])=>s.flags.includes("open_start")||s.flags.includes("open_missing")).length,
    openEnd=vsAll.filter(([,s])=>s.flags.includes("open_end")).length, tight=vsAll.filter(([,s])=>s.flags.includes("tight")).length;
  $("#cV").textContent=nf(vsAll.length); $("#cT").textContent=nf(sum(v=>v.items.filter(i=>i.kind==="trip").length));
  {const au=vsAll.flatMap(([v])=>v.items.filter(i=>i.auto&&i.kind==="trip").map(i=>autoSt(v,i))),ar=au.filter(x=>x!=="rejected").length,pend=au.filter(x=>x==="pending").length;
   $("#cTs").textContent=[au.length?`מתוכן ${nf(ar)} תגבור אוטומטי (לא בלוח הרישוי)${pend?` · ${nf(pend)} ממתינות לאישור`:""}`:"",
     nInc?`${nf(nInc)} לא הושלמו לפי GPS`:"",nDup?`${nf(nDup)} התחלות כפולות אוחדו`:""].filter(Boolean).join(" · ")}
  $("#cE").textContent=nf(Math.round(emp));
  const car=sum((v,s)=>s.car), nCar=sum(v=>v.items.filter(i=>i.kind==="empty"&&i.fb).length);
  $("#cEs").textContent=["לפי כביש, בין מיקומי ה־GPS",rein?`בלי ${nf(Math.round(rein))} ק״מ תגבור`:"",nOver?`${nf(nOver)} חפיפות בנתונים (0 ק״מ)`:"",
    nCar?`בלי ${nf(Math.round(car))} ק״מ הערכת רכב, לא אוטובוס (${nf(nCar)} נסיעות)`:""].filter(Boolean).join(" · ");
  $("#cN").textContent=nf(Math.round(nk));
  $("#cNs").innerHTML=esc(`יציאה ${nf(Math.round(sum((v,s)=>s.out)))} · חזרה ${nf(Math.round(sum((v,s)=>s.in)))} · מעבר לילה ${nf(Math.round(sum((v,s)=>s.over)))}`+
      (sum((v,s)=>s.nrein)?` · תגבור לילה ${nf(Math.round(sum((v,s)=>s.nrein)))}`:""))+
    (est>0.5?` · <span title="ק״מ שעוד לא חושבו לפי כביש">${nf(Math.round(est))} מהם הערכה${roadBusy?" (מחשב…)":""}</span>`:"")+
    (miss.length?` · <b style="color:var(--warn)" title="${esc(miss.slice(0,30).map(([v,s])=>v.veh+": "+(MISSTXT[s.missing[0].missing]||"")).join("\n"))}">חסר: ${nf(miss.length)} רכבים בלי חניון</b>`:"")+
    (open||openEnd?` · <span title="לילה פתוח: אין נתונים על היום הקודם / היום הבא עוד לא נבנה. יחושב כשיגיע.">לילה פתוח: ${[open?nf(open)+" בבוקר":"",openEnd?nf(openEnd)+" בערב":""].filter(Boolean).join(", ")}</span>`:"")+
    (tight?` · <span style="color:var(--warn)">${nf(tight)} לא נכנסים בזמן</span>`:"");
  drawRouteBar();
  const orph=orphans(); $("#orph").hidden=!orph.length;
  $("#orph").innerHTML=orph.length?`<details><summary>יש ${nf(orph.length)} בחירות שמורות שלא מתאימות לנתוני היום (יתומות). הן לא נספרות ולא נמחקות.</summary><ul>${orph.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></details>`:"";
  let vs=vsAll.slice();
  const so=$("#sort").value;
  vs.sort(so==="err"?(a,b)=>errsOf(b[0]).score-errsOf(a[0]).score||a[0].veh.localeCompare(b[0].veh):so==="empty"?(a,b)=>b[1].emp+b[1].nk-a[1].emp-a[1].nk:so==="start"?(a,b)=>a[0].items[0].start-b[0].items[0].start:(a,b)=>a[0].veh.localeCompare(b[0].veh));
  const S0=D.day_start_min??DAY_START_H*60; let mn=S0,mx=S0+24*60;
  all.forEach(([v,s])=>{v.items.forEach(i=>{mn=Math.min(mn,i.start);mx=Math.max(mx,i.end)});s.n.forEach(l=>{if(l.km){mn=Math.min(mn,l.start);mx=Math.max(mx,l.end)}})});
  T0=Math.floor(mn/60)*60; T1=Math.ceil(Math.max(mx,S0+1440+30)/60)*60; // room after the day end, so its line shows
  const tw=Math.max(($("#gantt").clientWidth||800)-(document.body.classList.contains("dense")?215:240),720), step=[1,2,3,4].find(k=>tw/((T1-T0)/60)*k>=44)||4;
  const nearEnd=m=>m<S0+1440&&(S0+1440-m)/60*tw/((T1-T0)/60)<82; // an hour label that would touch "סוף יום"
  let ticks=""; for(let m=T0;m<=T1;m+=60) ticks+=`<div class="tick${m===S0||m===S0+1440?" day":""}" style="left:${pct(m)}%">${m===S0+1440?'<span class="dl" title="סוף יום השירות">סוף יום</span>':((m-T0)/60)%step===0&&!nearEnd(m)?`<span>${fmt(m)}</span>`:""}</div>`;
  let h=`<div class="axis"><div class="lab">רכב</div><div class="track">${ticks}</div></div>`;
  const grid=ticks.replace(/<span[^>]*>.*?<\/span>/g,"");
  for(const [v,s] of vs){
    let b="";const hlS=HL&&HL.veh===v.veh?HL.sched:null;
    for(const n of s.n) if(n.km>=1) b+=bar(n.kind==="rein"?"rein":"dep",n.start,n.end,n.kind==="rein"?n.line:"",legTitle(n),s.flags.includes("tight")?"bad":"");
    for(const i of v.items){
      if(i.kind==="ghost") continue;
      if(i.kind==="dup") b+=bar("dup",i.start,i.end,"",`${fmt(i.start)}–${fmt(i.end)} התחלה כפולה של קו ${i.line}: נסיעה קצרה שאוחדה עם הנסיעה הבאה (לא נסיעה, לא תגבור)`);
      else if(i.kind==="trip"&&i.auto&&autoSt(v,i)!=="rejected") b+=bar("rein"+(i.edited?" edt":"")+(i.sched===hlS?" hl":""),i.start,i.end,(i.edited?"✎":"")+i.line+(i.asm?"*":""),`${i.edited?"✎ נערך ידנית · ":""}${fmt(i.start)}–${fmt(i.end)}${i.asm?" * לפי הנחה: "+asmTxt(i)+" ·":""} תגבור אוטומטי (לא בלוח הרישוי) · קו ${i.line}: ${i.frm} ← ${i.to} · ${AUTOTXT[autoSt(v,i)]}${i.incomplete?" · לא הושלמה לפי GPS":""}${i.no_time?" · שעת סיום: אין נתון":""}`,i.incomplete?"inc":"");
      else if(i.kind==="trip") b+=bar("svc"+(i.edited?" edt":"")+(i.sched===hlS?" hl":""),i.start,i.end,(i.edited?"✎":"")+i.line+(i.asm?"*":""),`${i.edited?"✎ נערך ידנית · ":""}${fmt(i.start)}–${fmt(i.end)}${i.asm?" * לפי הנחה: "+asmTxt(i)+" ·":""} קו ${i.line}: ${i.frm} ← ${i.to}${i.incomplete?` · לא הושלמה לפי GPS (${nf(i.gps_km)} מתוך ${nf(i.km_plan)} ק״מ)`:""}${i.no_gps?" · בלי GPS: לפי הלוח":""}${i.no_time?" · שעת סיום: אין נתון":""}`,i.incomplete?"inc":"");
      else if(i.kind==="empty"&&reinOf(v,i)){const r=reinOf(v,i),m1=estMin(+r.before_km||0),m3=estMin(+r.after_km||0),m2=Math.max(i.end-i.start-m1-m3,5);
        if(+r.before_km>=1) b+=bar("emp",i.start,i.start+Math.max(m1,3),"",`ריק לפני התגבור ${nf(r.before_km)} ק״מ`);
        b+=bar("rein",i.start+m1,i.start+m1+m2,r.line,`תגבור קו ${r.line}: ${r.route_frm} ← ${r.route_to}, ${nf(r.rein_km)} ק״מ`);
        if(+r.after_km>=1) b+=bar("emp",i.end-Math.max(m3,3),i.end,"",`ריק אחרי התגבור ${nf(r.after_km)} ק״מ`);}
      else if(i.kind==="empty"&&i.overlap) b+=bar("emp",i.end,i.end+3,"",`חפיפה בין נסיעות (שגיאה בנתוני SIRI): 0 ק״מ ריק`,"bad");
      else if(i.kind==="empty"&&i.km>=1){const de=Math.min(i.end,i.start+Math.max(i.drive_min||0,3));
        b+=bar("emp",i.start,de,nf(i.km)+" ק״מ",`ריק ${nf(i.km)} ק״מ${i.est?" (הערכה)":""}${i.fb?" · הערכת רכב, לא אוטובוס (לא נספר)":""}, כ־${nf(i.drive_min)} דק׳ נסיעה: ${i.frm} ← ${i.to} (זמן פנוי ${fmt(i.start)}–${fmt(i.end)})${i.tight?" · לא מספיק זמן לנסוע את זה: נתון חשוד":""}`,i.tight?"bad":"");}
    }
    const f=fuelFor(v);
    h+=`<div class="row${v.veh===sel?" sel":""}" role="listitem" tabindex="0" data-v="${esc(v.veh)}"><div class="lab">${esc(v.veh)}${accIcon(v.veh)} ${errBadge(v)}${brBadge(v)}<span class="badge ${v.cls==="עירוני"?"urb":"ic"}">${esc(v.cls)}</span>${f?`<span class="badge fuelb">${esc(f)}</span>`:""}</div><div class="track">${grid}${b}</div></div>`;
  }
  if(!vs.length) h+='<div class="empty-state">לא נמצאו רכבים</div>';
  window.YS_VIEW={vs,vsAll}; // mobile/mobile.js draws its list from the same filtered + sorted view
  const fv=document.activeElement&&document.activeElement.closest&&document.activeElement.closest("#gantt .row")?.dataset.v; // keep the focused row through a redraw
  $("#gantt").innerHTML=h;
  if(fv) document.querySelector(`#gantt .row[data-v="${CSS.escape(fv)}"]`)?.focus({preventScroll:true});
  side(sel);
}
// ---- "נסיעה ריקה מוכרחת" (PRD R53, David 18.11.2026): light severity, information and not a warning. (1) a day empty leg
// from a stop that is not a depot to its fixed departure stop (settings "forced_legs": end stop -> departure stop, stop
// names as in the data, matched like stop_anchors); (2) a pull-out from the depot to a first stop farther than
// defaults.forced_out_km. Not counted as a problem anywhere. ----
const stopIs=(n,want)=>{n=(n||"").trim();want=(want||"").trim();return !!want&&(n===want||n.split(",").slice(1).join(",").trim()===want)};
function forcedOf(i){if(i.kind!=="empty"||!i.km) return null;return (eff().S.forced_legs||[]).find(r=>stopIs(i.frm,r.name)&&stopIs(i.to,r.to_stop))||null}
const forcedKm=()=>eff().S.defaults?.forced_out_km??DEF.forced_out_km;
const forcedOut=l=>l.kind==="out"&&l.km!=null&&l.km>forcedKm();
// a start of the day longer than the threshold of a vehicle with no depot set (David 18.11.2026, option ב'): an interim
// note "מוכרחת? מחכה להגדרת חניון"; once the vehicle has a depot the day starts from it and forcedOut() decides
const forcedWait=(l,veh)=>l.kind==="over"&&l.km!=null&&l.km>forcedKm()&&!(eff().S.vehicles[veh]||{}).depot;
const FORCEDB=`<span class="badge forced">ריקה מוכרחת</span>`;
const forcedTxt=i=>{const r=forcedOf(i);return r?`<span class="sub forcedx">${FORCEDB} הרכב סיים ב־${esc(i.frm)}, שאינה חניון, והיציאה הקבועה ממנה היא ${esc(r.to_stop)}${r.note?` (${esc(r.note)})`:""}</span>`:""};
// one line of a night leg in the side panel
function nightLine(l,day){
  const when=`${fmt(l.start)}–${fmt(l.end)}`;
  if(l.km==null) return `<div class="it dep"><span>${LEGNAME[l.kind]}<span class="sub" style="color:var(--warn)">חסר: ${esc(MISSTXT[l.missing]||"")}${l.depot?" ("+esc(l.depot)+")":""}. הרכב לא נעלם מהסכום: שאר הק״מ שלו נספרים.</span></span><span class="t">–</span></div>`;
  if(l.kind==="over"&&l.km===0) return `<div class="it wait"><span>התחיל את היום במקום שבו סיים<span class="sub">אין נסיעה ריקה לתחילת היום</span></span><span class="t"></span></div>`;
  return `<div class="it ${l.kind==="rein"?"rein":"dep"}"${l.a&&l.b?mi({k:"night",l}):""}><span>${LEGNAME[l.kind]}${l.line?" · קו "+esc(l.line):""}: ${nf(l.km)} ק״מ${day?` <span class="badge">נספר ב־${dl(day)}</span>`:""}<span class="sub">${l.frm?esc(l.frm)+" ← "+esc(l.to||"")+" · ":""}${esc(l.kind==="rein"?"ק״מ תגבור":legKm(l))}</span>${forcedOut(l)?`<span class="sub forcedx">${FORCEDB} החניון רחוק מתחילת הקו (${nf(l.km)} ק״מ, מעל ${nf(forcedKm())})</span>`:forcedWait(l,sel)?`<span class="sub forcedw"><span class="badge forcedq">מוכרחת? מחכה להגדרת חניון</span> תחילת יום של ${nf(l.km)} ק״מ (מעל ${nf(forcedKm())}). כשיוגדר חניון לרכב, ההכרעה תהיה אוטומטית</span>`:""}${day||l.kind==="rein"?"":legActs("overnight",Math.round(l.start))}</span><span class="t">${when}</span></div>`}
// every empty leg (day and overnight): "עריכה" = the block editor of this vehicle-day (a reinforcement is added there as
// a trip on a chosen line), "הערה" = free-text feedback to the product team (leg_notes; read only by platform admins)
function legActs(kind,start){
  const mine=Object.values(eff().NOTES).filter(n=>n&&n.day===D.day&&n.veh===sel&&n.kind===kind&&n.leg_start_min===start)
    .map(n=>`<span class="sub edtm">הערה: ${esc(n.text)} · ${NOTES[n.id]?"נשלח":"טיוטה, תישלח בשמירה"}</span>`).join("");
  return mine+(canEdit()?`<span class="sub"><button class="btn small" data-blkopen>עריכה</button> <button class="btn small" data-note="${start}" data-nk="${kind}">הערה</button></span>`:"")}
function ovnSelect(N,veh,mode){
  if(!canEdit()) return `<span class="sub">${esc(OVMODES.find(x=>x[0]===mode)?.[1]||mode)}</span>`;
  return `<span class="sub"><select data-ovn="${esc(N)}" data-veh="${esc(veh)}" aria-label="מה הרכב עשה בלילה שלפני ${dl(N)}">${OVMODES.filter(([k])=>k!=="rein"||mode==="rein").map(([k,t])=>`<option value="${k}" ${mode===k?"selected":""}>${t}</option>`).join("")}</select></span>`}
// the block (סידור) of the selected vehicle: drawn into #side, which lives in the vehicle dialog (#dlgVeh)
function side(veh){sideBody(veh);vehHead()}
function sideBody(veh){
  const box=$("#side"); MAPI=[];
  if(!veh){box.innerHTML='<div class="empty-state">בחר רכב בציר הזמן כדי לראות את הסידור שלו</div>';return}
  const v=D.vehicles.find(x=>x.veh===veh);
  if(!v){const p=MODEL.prevActive(veh,D.day),nx=MODEL.nextActive(veh,D.day);
    box.innerHTML=`<h2>רכב ${esc(veh)}${accIcon(veh)}</h2>${editsBlock(veh)}<div class="empty-state">הרכב לא פעל ביום זה (${dl(D.day)}).${p.e?`<br>סיים לאחרונה ב־${dl(p.day)} ${fmt(p.e[5])}${inPl(p.e[9])} (קו ${esc(p.e[10])}).`:"<br>אין נתונים על היום האחרון שבו פעל."}${nx.e?`<br>פעל שוב ב־${dl(nx.day)} ${fromPl(nx.e[4])} ב־${fmt(nx.e[0])}.`:""}</div>`;return}
  const s=vstats(v),last=[...v.items].reverse().find(i=>i.kind==="trip"),mo=s.morning,ev=s.evening;
  const fromD=l=>l.night===mo?.key, thisNight=l=>l.night;
  const bo=branchOf(v),ro=!canEdit();
  let h=`<h2>רכב ${esc(v.veh)}${accIcon(v.veh)} · ${esc(v.cls)}</h2><div class="brrow"><label for="sbr"><b>סניף:</b></label><select id="sbr" data-brv="${esc(v.veh)}" ${ro?"disabled":""}>`+
    [["","לא משויך"],...branches().map(b=>[b,b])].map(([val,lab])=>`<option value="${esc(val)}" ${bo.b===val?"selected":""}>${esc(lab)}</option>`).join("")+`</select>`+
    (bo.auto?`<span class="badge br auto">אוטומטי</span>${ro||!bo.b?"":`<button class="btn small" data-brok="${esc(v.veh)}">אישור</button>`}`:`<span class="badge br">מאושר</span>`)+`<span class="msg" id="sbrMsg"></span></div>`+
    `<div class="brrow">${ro?"":`<button class="btn small${BLKMODE?" on":""}" data-blkmode>✎ עריכת הסידור</button>`}${BLKMODE&&!ro?`<button class="btn small" data-badd>+ הוספת נסיעה</button>`:""}${v.edited?`<button class="btn small${SHOWORIG?" on":""}" data-showorig>הצג מקור</button>`:""}</div>`+
    editsBlock(v.veh)+(SHOWORIG&&v.edited?origBlock(v.veh):"");
  // the night before this day
  const p=mo.p;
  if(p.open) h+=`<div class="it wait"><span>לילה פתוח<span class="sub">${p.reason==="start"?"אין נתונים על היום הקודם (תחילת הנתונים)":"היום "+dl(p.day)+" עוד לא נבנה"}. הלילה לא נספר, ויחושב כשיגיעו הנתונים.</span></span><span class="t"></span></div>`;
  else if(p.none) h+=`<div class="it wait"><span>לא פעל ב־${DH.LOOKBACK} הימים הקודמים<span class="sub">מניחים יציאה מהחניון שלו</span></span><span class="t"></span></div>`;
  else{const e=p.e,cnt=mo.legs.filter(l=>l.day!==D.day);
    h+=`<div class="it wait"><span>לינה: סיים ב־${dl(p.day)} ${fmt(e[5])}${inPl(e[9])} (קו ${esc(e[10])})${p.idle?` · לא פעל ${p.idle} ימים`:""}${ovnSelect(D.day,v.veh,mo.mode)}${mo.flags.includes("rein_incomplete")?'<span class="sub" style="color:var(--warn)">פרטי תגבור הלילה חסרים: נספר כמעבר רגיל</span>':""}</span><span class="t"></span></div>`;
    for(const l of cnt) h+=nightLine({...l,start:l.start-DH.dayNum(p.day)*1440,end:l.end-DH.dayNum(p.day)*1440},p.day);}
  for(const l of s.n.filter(l=>l.night===mo.key)) h+=nightLine(l);
  if(mo.flags.includes("tight")) h+=`<div class="it" style="color:var(--warn)"><span>הלילה לא נכנס בזמן: הנסיעות האלה ארוכות מהזמן שבין סוף היום הקודם לתחילת היום</span><span class="t"></span></div>`;
  for(const i of v.items){
    if(i.kind==="ghost"){h+=`<div class="it wait"><span>קו ${esc(i.line)} שובץ לרכב אבל לא בוצע לפי GPS<span class="sub">אין אף מיקום תקין ומשך 0 דק׳. לא נספר.</span></span><span class="t">${fmt(i.start)}</span></div>`;continue}
    if(i.kind==="dup"){h+=i.continued?`<div class="it wait"><span>המשך באותה נסיעה · קו ${esc(i.line)}<span class="sub">הנסיעה נרשמה ב־SIRI כשתי נסיעות של אותו קו, אחת אחרי השנייה מאותה נקודה. אוחדו לנסיעה אחת: לא נספרת פעמיים, אין ריק ביניהן.</span>${fixLink()}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`
      :`<div class="it wait"><span>התחלה כפולה · קו ${esc(i.line)}<span class="sub">נסיעה של ${Math.round(i.end-i.start)} דק׳${fromPl(i.frm)} שהופסקה או נרשמה פעמיים, ואותו קו נסע מיד. אוחדה עם הנסיעה: לא נסיעה, לא תגבור, אין ריק.</span>${fixLink()}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;continue}
    const gpsTxt=i.kind==="trip"?(i.midroute?`<span class="sub">הצטרף לקו באמצע (ה־GPS ראה אותו לראשונה ${nf(i.midroute)} ק״מ מתחילת הקו). נספרים ${nf(i.km)} ק״מ.</span>`:"")+snapTxt(i)+(i.late_login?`<span class="sub">נרשם באיחור ב־SIRI (${nf(i.late_login)} ק״מ אחרי תחילת הקו): תחילת הנסיעה מתחילת הקו, השעה משוערת</span>`:"")+(i.incomplete?`<span class="sub" style="color:var(--warn)">לא הושלמה לפי GPS: ${nf(i.gps_km)} מתוך ${nf(i.km_plan)} ק״מ. נספרים ${nf(i.km)} ק״מ.${i.contra==="here"?" לא נחשבת שלמה: הנסיעה הבאה של הרכב יצאה ליד הנקודה שבה ה־GPS הסתיים, ולא מתחנת הסוף.":i.contra==="time"?" לא נחשבת שלמה: אין מספיק זמן להשלים את המסלול ולהגיע לנסיעה הבאה.":""}</span>${fixLink()}`:i.no_gps?`<span class="sub">בלי GPS לנסיעה הזו: לפי הלוח</span>`:""):"";
    if(i.kind==="trip"&&i.auto){const st=autoSt(v,i),btn=(k,t)=>`<button class="btn small" data-ar="${i.sched}" data-st="${k}">${t}</button>`;
      h+=`<div class="it ${st==="rejected"?"svc":"rein"}${HL&&HL.veh===v.veh&&HL.sched===i.sched?" hl":""}"${mi({k:"trip",v,i})}><span>${st==="rejected"?"":"תגבור אוטומטי (לא בלוח הרישוי) · "}קו ${esc(i.line)}${asmBtn(i)}${i.unmapped?` (קו לא מזוהה, line_ref ${esc(i.line_ref)})`:""} · ${esc(i.frm)} ← ${esc(i.to)}${asmBox(i)}
        <span class="sub">${AUTOTXT[st]} · ${i.km==null?"? ק״מ":nf(i.km)+" ק״מ"}${i.dur_est?" · משך משוער":""}</span>${gpsTxt}${tripExtra(i)}
        ${canEdit()?`<span class="sub">${st!=="confirmed"?btn("confirmed","אישור כתגבור"):""}${st!=="rejected"?btn("rejected","דחייה (נסיעה רגילה)"):""}${st!=="pending"?btn("auto","ביטול החלטה"):""}</span>`:""}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;}
    else if(i.kind==="trip") h+=`<div class="it svc${i.edited?" edt":""}${HL&&HL.veh===v.veh&&HL.sched===i.sched?" hl":""}"${mi({k:"trip",v,i})}><span>קו ${esc(i.line)}${asmBtn(i)} · ${esc(i.frm)} ← ${esc(i.to)}${asmBox(i)}${gpsTxt}${tripExtra(i)}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;
    else if(i.overlap) h+=`<div class="it emp" style="color:var(--warn)"><span>חפיפה בין נסיעות (${i.edited?"אחרי עריכה ידנית":"שגיאה בנתוני SIRI"})<span class="sub">0 ק״מ ריק</span>${fixLink()}</span><span class="t"></span></div>`;
    else if(i.km>=1){const r=reinOf(v,i);
      if(r) h+=`<div class="it rein"${mi({k:"rein",v,i,r})}><span>תגבור קו ${esc(r.line)} · ${nf(r.rein_km)} ק״מ<span class="sub">${esc(r.route_frm)} ← ${esc(r.route_to)}</span>
          <span class="sub" style="color:#B4630E">ריק לפני ${nf(r.before_km)} ק״מ · ריק אחרי ${nf(r.after_km)} ק״מ (במקום ${nf(i.km)} ק״מ ריק)</span>
          ${canEdit()&&BLKMODE?`<button class="btn small" data-unrein="${i.next_sched}">ביטול התגבור</button>`:""}${legActs("day",i.start)}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;
      else h+=`<div class="it emp${legProblems(i)?" rpw":""}${hlLeg(v,i)?" hl":""}"${mi({k:"emp",v,i})}><span>ריק ${nf(i.km)} ק״מ${i.est?" (הערכה)":""}${i.fb?" · הערכת רכב, לא אוטובוס (לא נספר)":""} · כ־${nf(i.drive_min)} דק׳<span class="sub">${esc(i.frm)} ← ${esc(i.to)} · זמן פנוי ${Math.round(i.end-i.start)} דק׳</span>
          ${forcedTxt(i)}${i.tight?`<span class="sub" style="color:var(--warn)">אין מספיק זמן לנסוע את זה: נתון חשוד</span>${fixLink()}`:""}${routeNote(i)}${legEdTxt(i)}
          ${legActs("day",i.start)}${legEdBtn(i)}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;}
    else h+=`<div class="it wait${hlLeg(v,i)?" hl":""}"><span>המתנה${i.km>0.05?` · מעבר ${nf(i.km)} ק״מ`:""}${legEdTxt(i)}${legEdBtn(i)}</span><span class="t">${fmt(i.start)}–${fmt(i.end)}</span></div>`;
  }
  // the night after this day
  const nx=s.next;
  h+=`<div class="it wait"><span>סוף היום: ${esc(last.to)}`;
  if(nx.open) h+=`<span class="sub">לילה פתוח: ${nx.reason==="end"?"היום הבא עוד לא נבנה":"היום "+dl(nx.day)+" עוד לא נבנה"}. הלילה ייספר כשיגיעו הנתונים.</span>`;
  else if(nx.none) h+=`<span class="sub">לא פעל ב־${DH.LOOKBACK} הימים הבאים</span>`;
  else h+=`<span class="sub">הלילה עד ${dl(nx.day)}${nx.idle?` (לא פעל ${nx.idle} ימים)`:""}: </span>${ovnSelect(nx.day,v.veh,ev.mode)}`;
  h+=`</span><span class="t">${fmt(last.end)}</span></div>`;
  if(ev){for(const l of s.n.filter(l=>l.night===ev.key)) h+=nightLine(l);
    for(const l of ev.legs.filter(l=>l.day!==D.day)) h+=nightLine({...l,start:l.start-DH.dayNum(l.day)*1440,end:l.end-DH.dayNum(l.day)*1440},l.day);}
  h+=`<div class="tot"><div><b>${nf(s.emp)}</b><span>ק״מ ריק ביום</span></div><div><b>${nf(s.nk)}</b><span>ק״מ ריק מחוץ לסידור${s.missing.length?" (חסר חלק)":""}</span></div><div><b>${nf(s.emp+s.nk)}</b><span>סה״כ ריק</span></div></div>`;
  if(s.rein) h+=`<div class="it rein"><span>ק״מ תגבור (לא נספרים כריקים)</span><span class="t">${nf(s.rein)}</span></div>`;
  if(s.est>0.5) h+=`<div class="it wait"><span>מתוכם הערכה (עוד לא לפי כביש): ${nf(s.est)} ק״מ</span><span class="t"></span></div>`;
  const r=rangeFor(v), pc=r?Math.min(s.day/r*100,100):0, f=fuelFor(v);
  h+=`<div class="fuel"><div><b>דלק:</b> ${esc(f||"לא הוגדר")}</div><div><b>חניון:</b> ${esc((MODEL.depotFor(v.veh,"out",v.first_o[2])||MODEL.depotFor(v.veh,"out",v.last_d[2]))?.name||"לא הוגדר")}${vset(v).depot?"":' <span class="muted">(לפי העיר)</span>'}</div>
     <div><b>ק״מ ביום:</b> ${nf(s.day)} (בשירות ${nf(s.svc)})</div>
     ${r?`<div><b>מתוך טווח:</b> ${nf(r)} ק״מ · נשאר ${nf(Math.max(r-s.day,0))} ק״מ בסוף היום</div><div class="prog"><div style="width:${pc}%;background:${pc>90?"var(--warn)":pc>75?"var(--empty)":"var(--ok)"}"></div></div>${s.day>r?`<div style="color:var(--warn)">חורג מהטווח: צריך תדלוק במהלך היום</div>`:""}`:`<div class="muted">טווח נסיעה לא הוגדר</div>`}</div>`;
  box.innerHTML=h;
  if((HL&&HL.veh===v.veh)||(HLE&&HLE.veh===v.veh)) box.querySelector(".it.hl")?.scrollIntoView({block:"center"});
}
// ---- maps (assets/map.js): every schedule row opens a map; route warnings reuse it ----
let MAPI=[];
// the empty leg asked for from the route warnings ("הצג סידור"): highlighted and scrolled to
let HLE=null;
const hlLeg=(v,i)=>!!(HLE&&HLE.veh===v.veh&&HLE.day===D.day&&i.kind==="empty"&&i.start===HLE.start);
const legEdTxt=i=>i.leg_edit?`<span class="sub edtm">✎ ${i.leg_edit.a&&i.leg_edit.b?"מוצא ויעד נקבעו":i.leg_edit.a?"מוצא נקבע":"יעד נקבע"} ידנית${i.leg_edit.by?" · "+esc(i.leg_edit.by):""}${i.orig?` · במקור ${esc(i.orig.frm)} ← ${esc(i.orig.to)}, ${kmTxt(i.orig.km)} ק״מ`:""}</span>`:"";
const legEdBtn=i=>BLKMODE&&canEdit()&&i.next_sched!=null&&!i.overlap?`<span class="sub"><button class="btn small" data-legedit="${i.next_sched}">שינוי מוצא / יעד</button></span>`:"";
const mi=o=>{MAPI.push(o);return ` data-mi="${MAPI.length-1}" tabindex="0" title="לחיצה: הצגה על מפה"`};
const kmTxt=x=>x==null?"–":nf(Math.round(x*10)/10);
const STRIDE="https://open-bus-stride-api.hasadna.org.il";
let OPREF=null; async function opRef(){if(OPREF!=null) return OPREF;
  try{const j=await (await fetch("pipeline/operators.json?v="+APP_VER)).json();OPREF=(j.operators.find(o=>o.slug===OP.slug)||{}).operator_ref||0}catch{OPREF=0}return OPREF}
function tzOff(ms){try{const f=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Jerusalem",timeZoneName:"shortOffset"}).formatToParts(new Date(ms)).find(p=>p.type==="timeZoneName").value;
  const m=f.match(/GMT([+-]\d+)(?::(\d+))?/);return m?(+m[1])*60+(m[2]?Math.sign(+m[1])*+m[2]:0):120}catch{return 120}}
const utcISO=(day,m)=>{const base=Date.UTC(+day.slice(0,4),+day.slice(5,7)-1,+day.slice(8,10))+m*60000;return new Date(base-tzOff(base)*60000).toISOString().slice(0,19)+"Z"};
// road geometry of a pair as routed (anchor / snapping fix / approved link): road_cache.geom, else OSRM (saved for editors)
const pq=(A,B)=>`${opq()}&a_lat=eq.${(+A[0]).toFixed(5)}&a_lon=eq.${(+A[1]).toFixed(5)}&b_lat=eq.${(+B[0]).toFixed(5)}&b_lon=eq.${(+B[1]).toFixed(5)}`;
// the way a link is driven on a leg: [entry, exit, road line entry -> exit] (meta.via.rev; older results without it:
// the nearer orientation for a two-way link); the line is via_links.geom, else the straight line
function linkDir(lk,via,A,B){const ln=lk.line||[lk.a,lk.b];
  const rev=via&&via.rev!=null?!!via.rev:lk.both&&hav(A,lk.b)+hav(lk.a,B)<hav(A,lk.a)+hav(lk.b,B);
  return rev?[lk.b,lk.a,ln.slice().reverse()]:[lk.a,lk.b,ln]}
// The saved geometry is used only if it was drawn for this km and the same approved link (not when the link lost its
// approval or the km was recomputed): the map always matches the km shown
// A pair without a valid cached row (e.g. a day-file leg whose snapping was fixed by the pipeline) is routed again with
// the same route check (assets/route.js), so the map draws the route the km came from, not the plain OSRM route.
async function geomFor(A,B){let row=roadGet(A,B),fresh=false;
  if(!row){const r=await osrm(A,B);if(r){row=r;fresh=true}}
  const m=row&&row.meta||{};
  const lk=m.via&&m.via.id?VIAOK.find(x=>x.id===m.via.id):null;
  if(row&&!fresh) try{const g=await getRows("road_cache",`select=geom&${pq(A,B)}`);if(g&&g[0]&&g[0].geom){const j=JSON.parse(g[0].geom);
    if(j&&j.p&&j.km===+row.km&&!!j.l===!!lk) return {parts:j.p.map(YMAP.decode),link:j.l||null,cached:true}}}catch{}
  let parts=[],link=null;
  if(lk){const [E,X,ln]=linkDir(lk,m.via,A,B);parts=[await YMAP.osrmLine(A,E),ln,await YMAP.osrmLine(X,B)];link=1}
  else if(m.fix==="near"&&Array.isArray(m.via)){const A2=m.via[0]||A,B2=m.via[1]||B;parts=[[A,A2],await YMAP.osrmLine(A2,B2),[B2,B]]}
  else parts=[await YMAP.osrmLine(A,B,{curb:m.fix==="curb"})];
  if(row&&!fresh&&canEdit()) try{const geom=JSON.stringify({p:parts.map(YMAP.encode),km:+row.km,...(link?{l:1}:{})});
    if(geom.length<=40000) await sb(`/rest/v1/road_cache?${pq(A,B)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({geom})})}catch(e){console.warn("geom save",e)}
  return {parts,link}}
// an empty leg (day or night): road route as computed + dashed straight line, anchor / approved link marked
async function legMap(o){const {a,b,km,min,free,frm,to,title,rt}=o,[A,B]=subPair(a,b),ax=hav(a,b);
  const row=roadGet(A,B),m=(row&&row.meta)||rt||{};
  const info=`<div class="mapkv"><span><b>${kmTxt(km)}</b> ק״מ בכביש</span><span><b>${kmTxt(ax)}</b> ק״מ בקו אווירי</span><span><b>${min==null?"–":nf(Math.round(min))}</b> דק׳ נסיעה</span>${free!=null?`<span><b>${nf(Math.round(free))}</b> דק׳ פנויות</span>`:""}</div>
    <div class="sub">${esc(frm||"")} ← ${esc(to||"")}${m.via&&m.via.id?` · דרך נקודת מעבר מאושרת: ${esc(m.via.name)}`:""}${A!==a||B!==b?" · לפי נקודת עיגון לתחנה":""}${m.fix?" · מסלול שתוקן אוטומטית (הצמדה לכביש)":""}</div>`;
  const c=await YMAP.open({title,info:(o.head||"")+info,actions:o.actions||"",fit:[a,b],back:o.back});if(!c) return null;
  c.line([a,b],{color:"#666",dash:true,weight:3,label:"קו אווירי"}).point(a,{label:"מוצא: "+(frm||""),fill:"#2E9E5B"}).point(b,{label:"יעד: "+(to||""),fill:"#C0392B"});
  if(A!==a) c.point(A,{label:"נקודת עיגון",fill:"#F1C40F",r:6}); if(B!==b) c.point(B,{label:"נקודת עיגון",fill:"#F1C40F",r:6});
  c.status("טוען מסלול…");
  try{const g=await geomFor(A,B);
    g.parts.forEach((pts,k)=>c.line(pts,{color:g.link&&k===1?"#8E44AD":"#1F5FBF",weight:g.link&&k===1?7:5,label:k===0?"מסלול לפי כביש":g.link&&k===1?"קטע מאושר לתחבורה ציבורית":""}));
    if(g.link){const lk=VIAOK.find(x=>x.id===m.via.id);if(lk){const [E,X]=linkDir(lk,m.via,A,B);c.point(E,{label:"כניסה לקטע המאושר",fill:"#8E44AD",r:5}).point(X,{label:"יציאה מהקטע המאושר",fill:"#8E44AD",r:5})}}
    c.fit([a,b,...g.parts.flat()]);c.status("")}
  catch{c.status("לא ניתן לטעון את המסלול מהשרת",true)}
  return c}
async function tripMap(v,i){const route=(D.routes||[]).filter(r=>String(r.line)===String(i.line)).sort((x,y)=>(hav(x.o,i.a)+hav(x.d,i.b))-(hav(y.o,i.a)+hav(y.d,i.b)))[0]||null;
  const info=`<div class="mapkv"><span>קו <b>${esc(i.line)}</b></span><span>${fmt(i.start)}–${fmt(i.end)}</span><span><b>${i.km==null?"?":nf(i.km)}</b> ק״מ</span>${i.gps_km!=null?`<span>לפי GPS <b>${nf(i.gps_km)}</b> ק״מ</span>`:""}</div><div class="sub">${esc(i.frm)} ← ${esc(i.to)}</div>`;
  const c=await YMAP.open({title:`רכב ${v.veh} · קו ${i.line}`,info,fit:[i.a,i.b,route&&route.o,route&&route.d].filter(Boolean)});if(!c) return;
  if(route) c.point(route.o,{label:"תחנת מוצא מתוכננת: "+route.frm,fill:"#ddd",border:"#555",r:6}).point(route.d,{label:"תחנת יעד מתוכננת: "+route.to,fill:"#ddd",border:"#555",r:6});
  if(i.no_gps){c.status("אין GPS לנסיעה הזו (מוצגות תחנות הקצה המתוכננות)");c.point(i.a,{fill:"#2E9E5B"}).point(i.b,{fill:"#C0392B"});return}
  c.status("טוען מסלול GPS מ־Open Bus (לפעמים עד חצי דקה)…");
  try{const ref=await opRef(),q=new URLSearchParams({limit:"2000",siri_ride__vehicle_ref:v.veh,recorded_at_time_from:utcISO(D.day,i.start-2),recorded_at_time_to:utcISO(D.day,i.end+2),order_by:"recorded_at_time asc"});
    if(ref) q.set("siri_routes__operator_ref",ref); if(i.line_ref) q.set("siri_routes__line_ref",i.line_ref);
    const rows=(await (await fetch(`${STRIDE}/siri_vehicle_locations/list?${q}`)).json()).filter(x=>x.lat>29&&x.lat<34&&x.lon>34&&x.lon<36.5);
    if(!rows.length){c.status("לא נמצאו נקודות GPS לנסיעה הזו ב־Open Bus",true);c.point(i.a,{label:"תחילת הנסיעה",fill:"#2E9E5B"}).point(i.b,{label:"סוף הנסיעה",fill:"#C0392B"});return}
    const tr=rows.map(x=>[x.lat,x.lon]),f=tr[0],l=tr[tr.length-1];
    c.line(tr,{color:"#1F5FBF",label:`מסלול GPS בפועל (${rows.length} נקודות)`}).point(f,{label:"נקודת GPS ראשונה "+rows[0].recorded_at_time.slice(11,16)+" UTC",fill:"#2E9E5B"}).point(l,{label:"נקודת GPS אחרונה",fill:"#C0392B"});
    c.fit(tr.concat(route?[route.o,route.d]:[]));
    const dev=route?hav(l,route.d):null;
    c.status(dev!=null&&dev>2?`סטייה מהמסלול: ה־GPS הסתיים ${nf(Math.round(dev*10)/10)} ק״מ מתחנת הסוף המתוכננת`:(i.incomplete?"הנסיעה לא הושלמה לפי GPS":""),dev!=null&&dev>2)}
  catch{c.status("לא ניתן לטעון את מסלול ה־GPS מ־Open Bus",true)}}
async function reinMap(v,i,r){const rt=(D.routes||[]).find(x=>String(x.line)===String(r.line)&&x.frm===r.route_frm&&x.to===r.route_to)||(D.routes||[]).find(x=>String(x.line)===String(r.line));
  const c=await YMAP.open({title:`רכב ${v.veh} · תגבור קו ${r.line}`,info:`<div class="mapkv"><span>ריק לפני <b>${nf(r.before_km)}</b></span><span>קו <b>${nf(r.rein_km)}</b></span><span>ריק אחרי <b>${nf(r.after_km)}</b> ק״מ</span></div><div class="sub">${esc(r.route_frm)} ← ${esc(r.route_to)}</div>`,fit:[i.a,i.b,rt&&rt.o,rt&&rt.d].filter(Boolean)});
  if(!c) return; if(!rt){c.status("מסלול הקו לא נמצא בנתוני היום",true);return}
  c.point(i.a,{label:"מוצא הריק",fill:"#2E9E5B"}).point(rt.o,{label:"תחילת הקו",fill:"#F39C12"}).point(rt.d,{label:"סוף הקו",fill:"#F39C12"}).point(i.b,{label:"יעד הריק",fill:"#C0392B"});
  c.status("טוען מסלולים…");
  try{const [p1,p2,p3]=await Promise.all([YMAP.osrmLine(i.a,rt.o),YMAP.osrmLine(rt.o,rt.d),YMAP.osrmLine(rt.d,i.b)]);
    c.line(p1,{color:"#B4630E",dash:true,label:"ריק לפני"}).line(p2,{color:"#F39C12",weight:6,label:"מסלול הקו (לפי כביש, קירוב)"}).line(p3,{color:"#B4630E",dash:true,label:"ריק אחרי"});
    c.fit([...p1,...p2,...p3]);c.status("")}catch{c.status("לא ניתן לטעון את המסלולים מהשרת",true)}}
function openRowMap(o){if(!o) return;
  if(o.k==="trip") return tripMap(o.v,o.i);
  if(o.k==="rein") return reinMap(o.v,o.i,o.r);
  if(o.k==="emp") return legMap({a:o.i.a,b:o.i.b,km:o.i.km,min:o.i.drive_min,free:o.i.end-o.i.start,frm:o.i.frm,to:o.i.to,rt:o.i.rt,title:`רכב ${o.v.veh} · ריק ${fmt(o.i.start)}–${fmt(o.i.end)}`});
  if(o.k==="night") return legMap({a:o.l.a,b:o.l.b,km:o.l.km,min:o.l.km!=null?estMin(o.l.km):null,free:o.l.end-o.l.start,frm:o.l.frm,to:o.l.to,title:`${LEGNAME[o.l.kind]||"נסיעה"}`})}
$("#side").addEventListener("click",e=>{const r=e.target.closest("[data-mi]");if(!r||e.target.closest("button,select,input,a,label,textarea,summary")) return;openRowMap(MAPI[+r.dataset.mi])});
$("#side").addEventListener("keydown",e=>{const r=e.target.closest("[data-mi]");if(!r||e.target!==r||(e.key!=="Enter"&&e.key!==" ")) return;e.preventDefault();openRowMap(MAPI[+r.dataset.mi])});

// ---- route warnings: legs of this day with a route problem, grouped by origin -> destination; actions go to the drafts
// (route_reports, sent on "שמירה"); "הצע נקודת מעבר" creates a via_links proposal (used only after approval) ----
let RP=[],RSENT={};
const rpKey=g=>D.day+"|"+g.k;
function routeProblems(){const g=new Map();if(!D) return [];
  for(const v of D.vehicles) for(const i of v.items){const p=legProblems(i);if(!p) continue;
    const k=pk(i.a)+">"+pk(i.b);let x=g.get(k);
    if(!x){const [A,B]=subPair(i.a,i.b);x={k,a:i.a,b:i.b,A,B,ok:rokOf(i),frm:i.frm,to:i.to,km:i.km,air:hav(i.a,i.b),min:i.drive_min,kinds:new Set(),legs:[]};g.set(k,x)}
    p.forEach(t=>x.kinds.add(t));x.legs.push({veh:v.veh,start:i.start,end:i.end,km:i.km,min:i.drive_min,i})}
  return [...g.values()].sort((x,y)=>(y.kinds.has("time")-x.kinds.has("time"))||y.legs.length-x.legs.length||y.km/Math.max(y.air,.1)-x.km/Math.max(x.air,.1))}
function drawRouteBar(){RP=routeProblems();const b=$("#rwBar");if(!b) return;const nl=RP.reduce((s,g)=>s+g.legs.length,0);const nm=RP.filter(g=>manual(g.legs[0].i,g.kinds)).length;
  b.hidden=!RP.length;b.innerHTML=RP.length?`<button type="button" class="rwbtn" data-rwopen aria-haspopup="dialog">⚠ ${nf(RP.length)} בעיות מסלול ביום הזה</button><span class="rwsub">${nf(nl)} נסיעות ריקות${nm?` · ${nf(nm)} לבדיקה ידנית`:""} · ${[...new Set(RP.flatMap(g=>[...g.kinds]))].map(k=>RPTXT[k]).join(" · ")}</span>`:"";
  const dl=$("#dlgRw");if(dl&&dl.open&&!(dl.contains(document.activeElement)&&/^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName))) drawRouteList()}
document.addEventListener("click",e=>{if(e.target.closest("[data-rwopen]")) openRouteList()});
function rwDlg(){let d=$("#dlgRw");if(d) return d;d=document.createElement("dialog");d.id="dlgRw";d.className="rwdlg";d.setAttribute("aria-labelledby","rwT");
  d.innerHTML=`<div class="maphd"><h3 id="rwT">בעיות מסלול</h3><button type="button" class="btn small" data-rwclose>✕ סגירה</button></div><p class="hint">נסיעות ריקות שלא נכנסות בזמן, עם עיקוף גדול (כביש פי 2.5 מקו אווירי ויותר מ־4 ק״מ) או מסלול חשוד. כל שורה היא זוג מוצא ← יעד. "שלח לבדיקה", "הערה" ו"מסלול תקין" נשמרים כטיוטה ונשלחים ב"שמירה". "מסלול תקין" מסתיר את העיקוף / המסלול החשוד של הזוג בכל הימים (לא את "לא נכנס בזמן").</p><div id="rwList"></div>`;
  document.body.appendChild(d);d.addEventListener("click",rwClick);return d}
// back from the block opened by "הצג סידור": the same warning, scrolled into view, focus on the button it was opened from
// (if the warning is gone, e.g. the leg was fixed: the warning now in its place, or the list's top)
function backToWarning(gk,idx,veh,start){openRouteList();const L=$("#rwList");
  const sec=[...L.querySelectorAll(".rwg")].find(x=>x.dataset.rgk===gk)||L.querySelectorAll(".rwg")[Math.min(idx,L.querySelectorAll(".rwg").length-1)];if(!sec) return;
  const b=sec.dataset.rgk===gk&&[...sec.querySelectorAll("[data-rgv]")].find(x=>x.dataset.rgv===veh&&x.dataset.rgs===String(start));
  sec.scrollIntoView({block:"center"});(b||sec).focus({preventScroll:true});
  L.querySelectorAll(".rwg.rwback").forEach(x=>x.classList.remove("rwback"));sec.classList.add("rwback");setTimeout(()=>sec.classList.remove("rwback"),2500)}
function openRouteList(){const d=rwDlg();drawRouteList();if(!d.open) d.showModal();d.querySelector("[data-rwclose]").focus()}
// "הצג על מפה" of a route problem: one empty leg (one vehicle's block) at a time, with the vehicle, its class and the day
// on top and "הסידור הקודם / הבא" over all the day's problem legs, in the list's order (as the vehicle dialog does)
const rpFlat=()=>RP.flatMap(g=>g.legs.map(x=>({g,x})));
async function rpShow(n,k){const L=rpFlat(),z=L[n];if(!z) return;const {g,x}=z,v=D.vehicles.find(q=>q.veh===x.veh);
  const nav=(d,lab)=>`<button type="button" class="btn small" data-rpnav="${d}" ${L[n+d]?"":"disabled"}>${lab}</button>`;
  const head=`<div class="vehnav rpnav" role="group" aria-label="מעבר לסידור אחר"><b class="rphd">רכב ${esc(x.veh)}${v&&v.cls?` · ${esc(v.cls)}`:""} · ${esc(vehDayTxt(D.day))} · ריק <bdi dir="ltr">${fmt(x.start)}–${fmt(x.end)}</bdi></b><span class="sp"></span>
${gvCell(x.i,g.kinds,"pos")}<div class="grp">${nav(-1,`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg> הסידור הקודם`)}<span class="pos">${nf(n+1)} מתוך ${nf(L.length)}</span>${nav(1,`הסידור הבא <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`)}</div></div>`;
  RPN=n;const pr=legMap({a:g.a,b:g.b,km:x.km,min:x.min,free:x.end-x.start,frm:g.frm,to:g.to,rt:x.i.rt,title:"בעיית מסלול",back:openRouteList,head});
  // the map dialog is drawn (and focuses its close button) before the map loads: keep the focus on the nav button
  if(k){const b=document.querySelector(`#mapInfo [data-rpnav="${k}"]`);(b&&!b.disabled?b:document.querySelector(`#mapInfo [data-rpnav="${-k}"]`))?.focus()}
  return pr}
let RPN=0;
document.addEventListener("click",e=>{const b=e.target.closest("[data-rpnav]");if(b&&!b.disabled){const k=+b.dataset.rpnav;rpShow(RPN+k,k)}});
function drawRouteList(){const box=$("#rwList");if(!box) return;
  box.innerHTML=RP.length?RP.map((g,n)=>{const k=rpKey(g),dr=DRAFT.reports[k],frees=g.legs.map(x=>x.end-x.start);
    return `<section class="rwg" data-rg="${n}" data-rgk="${esc(g.k)}" tabindex="-1" aria-label="${esc(g.frm)} ← ${esc(g.to)}"><h4>${esc(g.frm)} ← ${esc(g.to)}</h4>
      <div class="mapkv"><span><b>${kmTxt(g.km)}</b> ק״מ בכביש</span><span><b>${kmTxt(g.air)}</b> אווירי</span>${gvCell(g.legs[0].i,g.kinds)}<span><b>${g.min==null?"–":nf(Math.round(g.min))}</b> דק׳ נסיעה</span><span>זמן פנוי <b>${nf(Math.min(...frees))}${Math.max(...frees)!==Math.min(...frees)?"–"+nf(Math.max(...frees)):""}</b> דק׳</span>${[...g.kinds].map(t=>`<span class="badge errb rp">${RPTXT[t]}</span>`).join("")}</div>
      <div class="rwveh" role="group" aria-label="הצג סידור">${g.legs.map(x=>`<button type="button" class="btn small" data-rgv="${esc(x.veh)}" data-rgs="${x.start}" aria-label="הצג סידור של רכב ${esc(x.veh)}, הנסיעה הריקה של ${fmt(x.start)}">הצג סידור · ${esc(x.veh)} · ${fmt(x.start)}</button>`).join("")}</div>
      <div class="rwact"><button type="button" class="btn small" data-rgmap="${n}">הצג על מפה</button>${canEdit()?`<button type="button" class="btn small" data-rgvia="${n}">הצע נקודת מעבר</button><button type="button" class="btn small" data-rgnote="${n}">הערה</button><button type="button" class="btn small primary" data-rgsend="${n}" ${dr||RSENT[k]?"disabled":""}>${RSENT[k]?"נשלח לבדיקה":dr?"בטיוטה":"שלח לבדיקה"}</button>${g.kinds.has("detour")||g.kinds.has("route")||g.kinds.has("okchg")?`<button type="button" class="btn small" data-rgok="${n}">מסלול תקין</button>`:""}`:""}</div>
      ${g.ok&&g.kinds.has("okchg")?`<div class="sub edtm">סומן כמסלול תקין ב־${kmTxt(g.ok.km)} ק״מ; עכשיו ${kmTxt(g.km)} ק״מ. אפשר לסמן שוב</div>`:""}
      ${dr?`<div class="sub edtm">טיוטה: ${esc(dr.text||"לבדיקה")}${dr.proposed_via?" · הוצעה נקודת מעבר":""} · תישלח ב"שמירה"</div>`:""}
      <div class="rwnote" hidden><textarea rows="2" maxlength="2000" aria-label="הערה על המסלול" placeholder="בלי שמות של אנשים ובלי כתובות פרטיות"></textarea><button type="button" class="btn small" data-rgnoteok="${n}">הוספה לטיוטה</button></div>
      <div class="rwnote rwok" hidden><textarea rows="2" maxlength="300" aria-label="הערה למסלול התקין (לא חובה)" placeholder="הערה (לא חובה)"></textarea><button type="button" class="btn small primary" data-rgokok="${n}">סימון כתקין (טיוטה)</button></div></section>`}).join(""):`<p class="muted">אין בעיות מסלול ביום הזה.</p>`;
  box.insertAdjacentHTML("beforeend",gvFoot()+rokFoot())}
let GVOPEN=false;
function gvFoot(){const L=routeVerified();if(!L.length) return "";
  return `<div class="rokfoot"><span>${nf(L.reduce((s,x)=>s+x.legs.length,0))} נסיעות אומתו מול נסיעות בפועל (לא נספרות כבעיה)</span> · <button type="button" class="linkbtn" data-gvshow aria-expanded="${GVOPEN}">${GVOPEN?"הסתר":"הצג"}</button></div>
    <ul class="roklist" ${GVOPEN?"":"hidden"}>${L.map(x=>`<li><span>${esc(x.frm)} ← ${esc(x.to)} · שלנו ${kmTxt(x.km)} ק״מ · ${gvTxt(x.i)} · ${x.legs.map(l=>`${esc(l.veh)} ${fmt(l.start)}`).join(", ")}</span></li>`).join("")}</ul>`}
// the pairs marked as correct (all days) + cancel; a saved row cancelled in the drafts is listed until "שמירה"
let ROKOPEN=false;
function rokFoot(){const m=rokM(),gone=ROK.filter(r=>DRAFT.rok[rokRowKey(r)]===null);if(!m.size&&!gone.length) return "";
  const row=(k,r,st)=>`<li><span>${esc(r.origin||"?")} ← ${esc(r.destination||"?")} · ${kmTxt(+r.km)} ק״מ${r.note?` · ${esc(r.note)}`:""}${st?` <span class="sub edtm">${st}</span>`:""}</span>${canEdit()?`<button type="button" class="btn small" data-rokdel="${esc(k)}">${st==="יבוטל בשמירה"?"החזרה":"בטל"}</button>`:""}</li>`;
  return `<div class="rokfoot"><span>${nf(m.size)} צמדים סומנו כתקינים</span> · <button type="button" class="linkbtn" data-rokshow aria-expanded="${ROKOPEN}">${ROKOPEN?"הסתר":"הצג"}</button></div>
    <ul class="roklist" ${ROKOPEN?"":"hidden"}>${[...m].map(([k,r])=>row(k,r,r.draft?"בטיוטה":"")).join("")}${gone.map(r=>row(rokRowKey(r),r,"יבוטל בשמירה")).join("")}</ul>`}
function rokSet(k,val){if(!canEdit()) return;const saved=ROK.some(r=>rokRowKey(r)===k);
  if(val===undefined) delete DRAFT.rok[k]; else if(val===null&&!saved) delete DRAFT.rok[k]; else DRAFT.rok[k]=val;
  touched();render();drawRouteList()}
function rpDraft(g,patch){const k=rpKey(g),cur=DRAFT.reports[k]||{day:D.day,origin:g.frm,destination:g.to,
    legs:g.legs.map(x=>({veh:x.veh,start:x.start,end:x.end,km:x.km,min:x.min})),text:null,proposed_via:null};
  DRAFT.reports[k]={...cur,...patch};touched();drawRouteList()}
async function rwClick(e){const t=e.target,d=$("#dlgRw");
  if(t.closest("[data-rwclose]")||t===d){d.close();return}
  if(t.dataset.gvshow!=null){GVOPEN=!GVOPEN;drawRouteList();$("#rwList [data-gvshow]")?.focus();return}
  if(t.dataset.rokshow!=null){ROKOPEN=!ROKOPEN;drawRouteList();$("#rwList [data-rokshow]")?.focus();return}
  if(t.dataset.rokdel!=null){const k=t.dataset.rokdel;rokSet(k,DRAFT.rok[k]===null||(DRAFT.rok[k]&&!ROK.some(r=>rokRowKey(r)===k))?undefined:null);$("#rwList [data-rokshow]")?.focus();return}
  const n=t.dataset.rgmap??t.dataset.rgvia??t.dataset.rgnote??t.dataset.rgsend??t.dataset.rgnoteok??t.dataset.rgok??t.dataset.rgokok;const g=n!=null?RP[+n]:null;
  if(t.dataset.rgv){d.close();if(!(await selectVehicle(t.dataset.rgv))){openRouteList();return}
    const gk=t.closest(".rwg")?.dataset.rgk,idx=+(t.closest(".rwg")?.dataset.rg||0),rv=t.dataset.rgv,rs=t.dataset.rgs;
    HLE={veh:rv,day:D.day,start:+rs};openVehDlg(null,{back:()=>backToWarning(gk,idx,rv,rs)});return}
  if(!g) return;
  if(t.dataset.rgmap!=null){d.close();rpShow(rpFlat().findIndex(z=>z.g===g))}
  else if(t.dataset.rgnote!=null){const w=t.closest(".rwg").querySelector(".rwnote");w.hidden=!w.hidden;if(!w.hidden) w.querySelector("textarea").focus()}
  else if(t.dataset.rgnoteok!=null){const tx=t.closest(".rwnote").querySelector("textarea").value.trim();if(tx) rpDraft(g,{text:tx})}
  else if(t.dataset.rgsend!=null) rpDraft(g,{})
  else if(t.dataset.rgok!=null){const w=t.closest(".rwg").querySelector(".rwok");w.hidden=!w.hidden;if(!w.hidden) w.querySelector("textarea").focus()}
  else if(t.dataset.rgokok!=null){const note=t.closest(".rwok").querySelector("textarea").value.trim()||null;
    rokSet(rokKey(g.A,g.B),{a_lat:+(+g.A[0]).toFixed(5),a_lon:+(+g.A[1]).toFixed(5),b_lat:+(+g.B[0]).toFixed(5),b_lon:+(+g.B[1]).toFixed(5),km:+(+g.km).toFixed(2),origin:g.frm,destination:g.to,note});
    d.querySelector("[data-rwclose]").focus()}
  else if(t.dataset.rgvia!=null){d.close();const x=g.legs[0];
    const c=await legMap({a:g.a,b:g.b,km:g.km,min:g.min,free:x.end-x.start,frm:g.frm,to:g.to,rt:x.i.rt,title:"הצעת נקודת מעבר",back:openRouteList,actions:`<p class="hint">לחצו על המפה: קודם נקודת הכניסה לקטע שמותר לאוטובוסים, ואז נקודת היציאה. ההצעה נשמרת ברשימת "נקודות מעבר מאושרות" וממתינה לאישור מנהל מערכת; היא לא משפיעה על החישוב עד שתאושר.</p>`});
    if(!c) return; const pts=[];c.status("בחרו את נקודת הכניסה");
    c.pick(p=>{pts.push(p);c.point(p,{label:pts.length===1?"כניסה":"יציאה",fill:"#8E44AD"});
      if(pts.length===1){c.status("בחרו את נקודת היציאה");return true}
      const km=+(hav(pts[0],pts[1])*1.2).toFixed(3),name=`הצעה: ${g.frm} ← ${g.to}`.slice(0,80);
      sb("/rest/v1/via_links",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({operator_id:OP.id,name,a_lat:+pts[0][0].toFixed(6),a_lon:+pts[0][1].toFixed(6),b_lat:+pts[1][0].toFixed(6),b_lon:+pts[1][1].toFixed(6),link_km:Math.max(km,0.01),both_ways:false,note:"הוצע מרשימת בעיות המסלול"})})
        .then(()=>{loadVia();rpDraft(g,{proposed_via:{a:pts[0],b:pts[1],km}});c.status("ההצעה נשמרה וממתינה לאישור מנהל מערכת. נוספה גם לטיוטת הדיווח")})
        .catch(err=>c.status("שמירת ההצעה נכשלה: "+errText(err),true));
      return false})}}
// what the route check did on a leg (assets/route.js) / an anchor point used
function routeNote(i){const r=i.rt,o=[];
  if(i.anch===true) o.push(`לפי נקודת עיגון לתחנה${i.km_file!=null&&Math.abs(i.km_file-i.km)>0.1?` (בנתוני היום: ${nf(i.km_file)} ק״מ)`:""}`);
  if(i.wait) o.push("מחשב מסלול…");
  if(r&&r.via&&r.via.id) o.push(`דרך נקודת מעבר מאושרת: ${esc(r.via.name)} (בלי המעבר: ${nf(r.via.km0)} ק״מ)`);
  if(r&&r.fix) o.push(`מסלול תוקן אוטומטית: OSRM נצמד לכביש הלא נכון ונתן ${nf(r.km0)} ק״מ`);
  if(ROUTE.unresolved(r)) o.push(`<span style="color:var(--warn)">מסלול חשוד (פרסה או נקודה רחוקה מהכביש). אפשר להגדיר נקודת עיגון לתחנה בהגדרות</span>`);
  else if(r&&r.ok) o.push(`מסלול חשוד שנבדק: לא נמצא מסלול טוב יותר`);
  return o.map(x=>`<span class="sub">${x}</span>`).join("")}
// data errors of a vehicle-day (sort "שגיאות נתונים תחילה" + the badge): incomplete GPS, overlaps, false starts,
// impossible speed, suspicious route
const ERRK=[["rp","בעיית מסלול"],["inc","לא הושלמה לפי GPS"],["over","חפיפה"],["dup","התחלה כפולה"]];
// a route problem on an empty leg: "time" = needs more driving time than it has (tight), "detour" = road > 2.5 x air
// and > 4 km, "route" = suspicious route the route check could not fix
const RPTXT={time:"לא נכנס בזמן",detour:"עיקוף גדול",route:"מסלול חשוד",okchg:"השתנה מאז שאושר"};
// a leg still waiting for its road km (anchor / approved link) shows the day file's km: not judged until it is computed
// GPS trip ends/starts: moved to the planned stop under the strict rule (pipeline SNAP), or left raw ("קטיעה אפשרית")
const snapTxt=i=>(i.snap_end?`<span class="sub">סוף הנסיעה בתחנה המתוכננת: ה־GPS הסתיים ${nf(i.snap_end.m)} מ׳ לפניה (${esc(i.snap_end.to)}). השעה לפי ה־GPS.</span>`:"")
  +(i.snap_start?`<span class="sub">תחילת הנסיעה בתחנה המתוכננת: ה־GPS התחיל ${nf(i.snap_start.m)} מ׳ אחריה (${esc(i.snap_start.frm)}). השעה לפי ה־GPS.</span>`:"")
  +(i.trunc_end&&!i.incomplete?(t=>`<span class="sub" style="color:var(--warn)">קטיעה אפשרית: ה־GPS הסתיים ${/^(ליד|מיקום)/.test(t)?"":"ב"}${esc(t)}, לא בתחנת הסוף המתוכננת${i.trunc_to?`. הנסיעה נספרת כשלמה, והנסיעה הריקה אחריה נספרת מתחנת הסוף`:""}</span>`)(i.trunc_to||i.to):"")
  +(i.trunc_start?`<span class="sub" style="color:var(--warn)">קטיעה אפשרית: ה־GPS התחיל ${/^(ליד|מיקום)/.test(i.frm)?"":"ב"}${esc(i.frm)}, לא בתחנת המוצא המתוכננת</span>`:"")
  // pipeline DEV: GPS points off the licensed shape (MOT GTFS) over a stretch of driving, then back on it
  +(Array.isArray(i.dev)?`<span class="sub" style="color:var(--warn);font-weight:600">סטייה מהמסלול ברישוי: ${nf(i.dev[1])} ק״מ מחוץ למסלול${i.dev[2]>1?` ב־${nf(i.dev[2])} מקומות`:""} (עד ${i.dev[0]>=400?"400 מ׳ ויותר":nf(i.dev[0])+" מ׳"} ממנו)</span>`:"");
// trips counted as completed by assumption, not by GPS (pipeline "asm", David 18.11.2026): a small star next to the trip in
// the schedule, the block and the search; the reason with this trip's numbers on hover, and on click / Enter (keyboard,
// screen readers, phone) shown in place
function asmTxt(i){const a=i.asm;if(!a) return "";
  return `ה־GPS אבד אחרי ${nf(a.gps_km??0)} ק״מ (${a.share}% מהמסלול). הנקודה האחרונה ${nf(a.last_km)} ק״מ מתחנת הסוף. `+(
    a.g==="a"?`הנסיעה הבאה של אותו רכב יצאה מתחנת הסוף (${a.next_m} מ׳ ממנה) אחרי ${a.gap} דק׳. לכן הנחנו שהנסיעה הושלמה.`
    :a.g==="b"?`הנסיעה הבאה של אותו רכב יצאה ${nf(a.next_km)} ק״מ משם, ${a.gap} דק׳ אחרי הסוף המשוער של הנסיעה (לפי הלוח, או לפי היציאה בפועל אם יצאה באיחור), והזמן מספיק (כ־${a.drive} דק׳ נסיעה). לכן הנחנו שהנסיעה הושלמה.`
    :"אין לרכב נסיעה אחריה באותו יום. לכן הנחנו שהנסיעה הושלמה.")+" נספרים ק״מ הרישוי, והנסיעה הריקה אחריה יוצאת מתחנת הסוף."}
const asmBtn=i=>i.asm?`<button type="button" class="asmb" aria-expanded="false" aria-controls="asmx-${i.sched}" title="${esc(asmTxt(i))}" aria-label="חושבה לפי הנחה: הצגת ההסבר">*</button>`:"";
const asmBox=i=>i.asm?`<span class="sub asmx" id="asmx-${i.sched}">${esc(asmTxt(i))}</span>`:"";
document.addEventListener("click",e=>{const b=e.target.closest(".asmb");if(!b) return;const x=document.getElementById(b.getAttribute("aria-controls"));if(!x) return;
  const open=b.getAttribute("aria-expanded")!=="true";b.setAttribute("aria-expanded",open);x.classList.toggle("open",open)});
function legProblems(i,raw){if(i.kind!=="empty"||i.overlap||i.km==null||i.wait) return null;let p=[];
  if(i.tight) p.push("time");
  const ax=i.a&&i.b?hav(i.a,i.b):null; if(ax!=null&&i.km>4&&i.km>2.5*Math.max(ax,0.01)) p.push("detour");
  if(ROUTE.unresolved(i.rt)) p.push("route");
  if(p.some(t=>t!=="time")){const ok=rokOf(i);if(ok){if(rokChanged(ok,i.km)) p.push("okchg"); else p=p.filter(t=>t==="time")}}
  if(!raw&&p.some(t=>t!=="time")&&gvOk(i)) p=p.filter(t=>t==="time");
  return p.length?p:null}
// the legs whose road warning the GPS of buses in service confirmed, by pair: shown under the list, not counted
function routeVerified(){const g=new Map();if(!D) return [];
  for(const v of D.vehicles) for(const i of v.items){const p=legProblems(i,true);if(!p||!p.some(t=>t!=="time")||!gvOk(i)) continue;
    const k=pk(i.a)+">"+pk(i.b);let x=g.get(k);if(!x){x={frm:i.frm,to:i.to,km:i.km,i,legs:[]};g.set(k,x)}x.legs.push({veh:v.veh,start:i.start})}
  return [...g.values()]}
function errsOf(v){const c={inc:0,over:0,dup:0,rp:0};
  for(const i of v.items){if(i.kind==="dup") c.dup++;else if(i.kind==="trip"&&i.incomplete) c.inc++;
    else if(i.kind==="empty"){if(i.overlap) c.over++;if(legProblems(i)) c.rp++}}
  c.n=c.inc+c.over+c.dup+c.rp;c.score=c.rp*100+c.n;return c}
const errTitle=c=>ERRK.filter(([k])=>c[k]).map(([k,t])=>`${t}: ${c[k]}`).join(" · ");
const errBadge=v=>{const c=errsOf(v);return c.n?`<span class="badge errb${c.rp?" rp":""}" title="${esc("שגיאות נתונים: "+errTitle(c))}" aria-label="${c.n} שגיאות נתונים: ${esc(errTitle(c))}">⚠ ${c.n}</span>`:""};
// ---- reinforcement trip: a service line placed inside an empty leg; the gaps before/after stay empty ----
let pick=null;
async function roadKm(a,b){ // shared cache, then OSRM; falls back to an estimate
  const c=roadGet(a,b); if(c) return {...c,road:true};
  const r=await osrm(a,b); if(r){ROAD.set(roadKey(a,b),r);return {...r,road:true}}
  const km=estKm(a,b);return {km,min:estMin(km),road:false}}
function legOf(veh,ns){const v=D.vehicles.find(x=>x.veh===veh),k=v.items.findIndex(i=>i.kind==="empty"&&i.next_sched===ns);
  const prev=[...v.items.slice(0,k)].reverse().find(i=>i.kind==="trip"),next=v.items.slice(k+1).find(i=>i.kind==="trip");return {v,leg:v.items[k],prev,next}}
function openPick(ns){
  const {v,leg,prev,next}=legOf(sel,ns), RS=D.routes||[];
  const A=prev&&prev.b, B=next&&next.a, have=leg.end-leg.start;
  const rows=RS.map((r,idx)=>{const bk=A?estKm(A,r.o):null, ak=B?estKm(r.d,B):null, need=(bk!=null&&ak!=null)?estMin(bk)+r.dur+estMin(ak):null;
    return {r,idx,bk,ak,need,fits:need!=null&&need<=have}}).sort((x,y)=>(y.fits-x.fits)||((x.bk+x.ak)-(y.bk+y.ak)));
  pick={ns,A,B,leg,rows,calc:null};
  $("#reinHead").innerHTML=`רכב ${esc(v.veh)} · נסיעה ריקה ${nf(leg.km)} ק״מ, ${fmt(leg.start)}–${fmt(leg.end)} (${Math.round(have)} דק׳ פנויות)<br>${esc(leg.frm)} ← ${esc(leg.to)}<br>
    בוחרים קו וכיוון שעליו תיספר נסיעת התגבור. הנסיעה מהמקום הנוכחי לתחילת הקו, ומסוף הקו לנסיעה הבאה, נשארות ק״מ ריקים. המספרים ברשימה הם הערכה, ואחרי בחירה הם מחושבים לפי כביש.`;
  $("#reinQ").value=""; drawPick(); $("#reinPrev").innerHTML=""; $("#dlgRein").showModal(); $("#reinQ").focus();
}
function drawPick(){
  const q=$("#reinQ").value.trim();
  const rows=pick.rows.filter(x=>!q||x.r.line.includes(q)||x.r.frm.includes(q)||x.r.to.includes(q));
  $("#reinList").innerHTML=`<table class="ed"><thead><tr><th>קו</th><th>מ־</th><th>אל</th><th>ק״מ קו</th><th>ריק לפני</th><th>ריק אחרי</th><th>נכנס בזמן?</th></tr></thead><tbody>`+
    rows.map(x=>`<tr class="pickable${pick.calc&&pick.calc.r===x.r?" chosen":""}" data-ri="${x.idx}" tabindex="0"><td><b>${esc(x.r.line)}</b></td><td>${esc(x.r.frm)}</td><td>${esc(x.r.to)}</td><td>${nf(x.r.km)}</td><td>${x.bk==null?"–":"~"+nf(x.bk)}</td><td>${x.ak==null?"–":"~"+nf(x.ak)}</td><td>${x.need==null?"–":x.fits?'<span class="msg ok">כן</span>':'<span class="msg err">לא</span>'}</td></tr>`).join("")+`</tbody></table>`;
}
async function choosePick(idx){
  const r=D.routes[idx]; pick.calc=null; drawPick(); const box=$("#reinPrev");
  if(!pick.A||!pick.B){box.innerHTML=`<span class="msg err">חסרים מיקומים לנסיעה הזו בנתונים</span>`;return}
  box.innerHTML="מחשב מרחקים לפי כביש…";
  const b=await roadKm(pick.A,r.o), a=await roadKm(r.d,pick.B), need=b.min+r.dur+a.min, have=pick.leg.end-pick.leg.start;
  pick.calc={r,b,a,legKm:pick.leg.km}; drawPick();
  box.innerHTML=`<div><b>קו ${esc(r.line)}</b> · ${esc(r.frm)} ← ${esc(r.to)}</div>
    <div>ריק לפני: <b>${nf(b.km)}</b> ק״מ · תגבור: <b>${nf(r.km)}</b> ק״מ · ריק אחרי: <b>${nf(a.km)}</b> ק״מ${b.road&&a.road?"":" (הערכה)"} · סה״כ ריק ${nf(b.km+a.km)} במקום ${nf(pick.leg.km)}</div>
    ${need>have?`<div class="msg err">לא נכנס בזמן: צריך כ־${Math.round(need)} דק׳, יש ${Math.round(have)}. אפשר לסמן בכל זאת.</div>`:`<div class="msg ok">נכנס בזמן: צריך כ־${Math.round(need)} דק׳ מתוך ${Math.round(have)}</div>`}
    <button class="btn primary" id="reinSave" style="margin-top:6px">סימון התגבור</button>`;
}
$("#reinList").addEventListener("click",e=>{const tr=e.target.closest("tr[data-ri]");if(tr) choosePick(+tr.dataset.ri)});
$("#reinList").addEventListener("keydown",e=>{const tr=e.target.closest("tr[data-ri]");if(tr&&(e.key==="Enter"||e.key===" ")){e.preventDefault();choosePick(+tr.dataset.ri)}});
$("#reinQ").oninput=drawPick;
$("#reinClose").onclick=()=>{$("#dlgRein").close();pick=null};
$("#reinPrev").addEventListener("click",e=>{
  if(e.target.id!=="reinSave"||!pick||!pick.calc) return; const c=pick.calc;
  setDraft("rein",akey(D.day,sel,pick.ns),{day:D.day,veh:sel,start_min:pick.ns,km:c.legKm,line:String(c.r.line).slice(0,20),route_frm:String(c.r.frm).slice(0,200),
    route_to:String(c.r.to).slice(0,200),rein_km:c.r.km,before_km:+c.b.km.toFixed(2),after_km:+c.a.km.toFixed(2),note:null});
  $("#dlgRein").close();pick=null;render();
});
function setBranch(veh,b){setVehDraft(veh,{branch:b,branch_confirmed:true});render()}
$("#side").addEventListener("change",e=>{if(e.target.dataset.brv!=null) setBranch(e.target.dataset.brv,e.target.value);
  if(e.target.dataset.ovn!=null) chooseNight(e.target.dataset.ovn,e.target.dataset.veh,e.target.value)});
$("#side").addEventListener("click",e=>{
  if(e.target.dataset.ar!=null){const sc=+e.target.dataset.ar,st=e.target.dataset.st;setDraft("autor",akey(D.day,sel,sc),st==="auto"?null:st);render();return}
  if(e.target.dataset.brok!=null){const v=D.vehicles.find(x=>x.veh===e.target.dataset.brok);setBranch(v.veh,autoBranch(v));return}
  const p=e.target.dataset.pickrein, u=e.target.dataset.unrein;
  if(p!=null){ openPick(+p); return }
  if(u!=null){ setDraft("rein",akey(D.day,sel,+u),null); render() }
});
// a night choice (key = the day after the night). "depot" fixes the depots it uses now (later settings changes do not
// rewrite past nights); "rein" opens the overnight reinforcement dialog.
function chooseNight(N,veh,mode){
  if(mode==="rein"){openNightRein(N,veh);return}
  if(mode==="stay"){setDraft("ovn",N+"|"+veh,null);render();ensureRoad();return}
  const tmp=DH.Model({days,dayStartMin:DAY_START_H*60,ends:ENDS,S:eff().S,OVN:{[N+"|"+veh]:{mode:"depot"}},REIN:{},AUTOR:{},road:()=>null}).night(veh,N);
  const S2=eff().S, idOf=name=>(S2.depots||[]).find(d=>d.name===name)?.id||null;
  const li=tmp.legs.find(l=>l.kind==="in"),lo=tmp.legs.find(l=>l.kind==="out");
  setDraft("ovn",N+"|"+veh,{day:N,veh,mode:"depot",detail:{depot_in:li&&idOf(li.depot),depot_out:lo&&idOf(lo.depot)},note:null});render();ensureRoad()}
// ---- drafts: every edit (settings, reinforcement, overnight, branch, automatic reinforcement) changes the view at once
// but nothing is written until "שמירה". Drafts stay when the day changes. value null = remove the saved value. ----
const DRAFT={settings:{},veh:{},ovn:{},rein:{},autor:{},blk:{},rules:{},notes:{},reports:{},rok:{}}; // rules: {set: savings rule set} (savings panel)
let DV=0,EFF=null,EFFV=-1;
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const baseOf=t=>t==="ovn"?OVN:t==="rein"?REIN:t==="autor"?AUTOR:t==="blk"?BLK:t==="notes"?NOTES:null;
function nDraft(){return Object.values(DRAFT).reduce((a,x)=>a+Object.keys(x).length,0)}
function touched(){DV++;EFF=null;drawSaveBar()}
function eff(){if(EFF&&EFFV===DV) return EFF;
  const S2={...S,...clone(DRAFT.settings)}, vehicles={...(S2.vehicles||{})};
  for(const [veh,x] of Object.entries(DRAFT.veh)) if(x==null) delete vehicles[veh]; else vehicles[veh]=x;
  S2.vehicles=vehicles; S2.defaults={...clone(DEF),...(S2.defaults||{})};
  const ap=(base,d)=>{const o={...base};for(const [k,x] of Object.entries(d)) if(x==null) delete o[k]; else o[k]=x;return o};
  EFF={S:S2,OVN:ap(OVN,DRAFT.ovn),REIN:ap(REIN,DRAFT.rein),AUTOR:ap(AUTOR,DRAFT.autor),BLK:ap(BLK,DRAFT.blk),NOTES:ap(NOTES,DRAFT.notes)};EFFV=DV;return EFF}
function setDraft(t,key,val){
  if(!canEdit()) return;
  const base=t==="settings"?S[key]:baseOf(t)[key];
  if(same(val,base)) delete DRAFT[t][key]; else DRAFT[t][key]=val;
  touched()}
function setVehDraft(veh,patch){ // patch: field -> value (null/"" removes the field)
  const cur={...(eff().S.vehicles[veh]||{})};
  for(const [k,x] of Object.entries(patch)) if(x==null||x==="") delete cur[k]; else cur[k]=x;
  const val=Object.keys(cur).length?cur:null;
  if(same(val,S.vehicles?.[veh])) delete DRAFT.veh[veh]; else DRAFT.veh[veh]=val;
  touched()}
function drawSaveBar(){const n=nDraft(),b=$("#bSave");if(!b) return;
  $("#saveBar").hidden=!canEdit()||!n; $("#nDraft").textContent=n?`(${n})`:""; b.disabled=!n; $("#bUndo").disabled=!n;
  b.classList.toggle("pending",n>0); b.title=n?`יש ${n} שינויים שלא נשמרו`:"אין שינויים לשמירה";
  const vs=$("#vehSave");if(vs){vs.hidden=!canEdit()||!n;$("#vehSaveN").textContent=n?`(${n})`:"";$("#vehSaveBtn").disabled=!n;$("#vehUndo").disabled=!n}}
async function saveAll(){
  const msg=$("#saveMsg"); if(!nDraft()) return true;
  if(!canEdit()){msg.className="msg err";msg.textContent=ERR.not_allowed;return false}
  msg.className="msg";msg.textContent="שומר…";$("#bSave").disabled=true;
  try{
    const ch={settings:Object.entries(DRAFT.settings).map(([key,value])=>({key,value})),ovn:[],rein:[],autor:[],
      blk:Object.entries(DRAFT.blk).map(([id,x])=>x==null?{id,delete:true}:{id,day:x.day,veh:x.veh,action:x.action,payload:x.payload,note:x.note||null}),
      notes:Object.values(DRAFT.notes).filter(Boolean).map(x=>({id:x.id,day:x.day,veh:x.veh,leg_start_min:x.leg_start_min,kind:x.kind,text:x.text}))};
    if(Object.keys(DRAFT.veh).length){ // vehicles: merge into the latest saved value (someone else may have saved meanwhile)
      const r=await getRows("settings",`select=value&${opq()}&key=eq.vehicles`)||[], cur={...((r[0]&&r[0].value)||{})};
      for(const [veh,x] of Object.entries(DRAFT.veh)) if(x==null) delete cur[veh]; else cur[veh]=x;
      ch.settings=ch.settings.filter(x=>x.key!=="vehicles").concat([{key:"vehicles",value:cur}])}
    for(const [k,x] of Object.entries(DRAFT.ovn)){const [day,veh]=k.split("|");ch.ovn.push(x==null?{day,veh,delete:true}:{day,veh,mode:x.mode,detail:x.detail||null,note:x.note||null})}
    for(const [k,x] of Object.entries(DRAFT.rein)){const [day,veh,sm]=k.split("|");ch.rein.push(x==null?{day,veh,start_min:+sm,delete:true}:{...x,day,veh,start_min:+sm})}
    for(const [k,x] of Object.entries(DRAFT.autor)){const [day,veh,sm]=k.split("|");ch.autor.push(x==null?{day,veh,start_min:+sm,delete:true}:{day,veh,start_min:+sm,status:x})}
    const n=nDraft(),reps=Object.values(DRAFT.reports).filter(Boolean);
    if(reps.length){await sb("/rest/v1/route_reports",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(reps.map(r=>({operator_id:OP.id,...r})))});
      for(const k of Object.keys(DRAFT.reports)) RSENT[k]=true; DRAFT.reports={};}
    const rk=Object.entries(DRAFT.rok);
    if(rk.length){const sv=new Map(ROK.map(r=>[rokRowKey(r),r])),del=rk.map(([k])=>sv.get(k)).filter(Boolean).map(r=>r.id);
      if(del.length) await delRows("route_ok",`${opq()}&id=in.(${del.join(",")})`);
      const ins=rk.filter(([,x])=>x).map(([,x])=>({operator_id:OP.id,a_lat:x.a_lat,a_lon:x.a_lon,b_lat:x.b_lat,b_lon:x.b_lon,km:x.km,origin:x.origin,destination:x.destination,note:x.note}));
      if(ins.length) await sb("/rest/v1/route_ok",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(ins)});
      DRAFT.rok={};await loadRok()}
    if(DRAFT.rules.set) await rpc("save_rule_set",{p_operator:OP.id,p_operator_rules:DRAFT.rules.set.operator||{},p_lines:DRAFT.rules.set.lines||{}});
    const res=await rpc("save_changes",{p_operator:OP.id,p_changes:ch});
    for(const x of ch.settings) S[x.key]=clone(x.value);
    const ap=(base,d)=>{for(const [k,x] of Object.entries(d)) if(x==null) delete base[k]; else base[k]=x};
    ap(OVN,DRAFT.ovn);ap(REIN,DRAFT.rein);ap(AUTOR,DRAFT.autor);ap(BLK,DRAFT.blk);ap(NOTES,DRAFT.notes);
    for(const t in DRAFT) DRAFT[t]={};
    touched(); render(); if(SAV) SAV.ui.reloadRules(); msg.className="msg ok"; msg.textContent=`נשמר (${nf(res&&res.saved||n)})`; setTimeout(()=>{if(msg.textContent.startsWith("נשמר")) msg.textContent=""},5000);
    ensureRoad(); return true}
  catch(err){msg.className="msg err";msg.textContent="השמירה נכשלה: "+errText(err);drawSaveBar();return false}}
function undoAll(){for(const t in DRAFT) DRAFT[t]={};touched();render();ensureRoad();$("#saveMsg").textContent="";if(SAV) SAV.ui.syncDraft()}
$("#bSave").onclick=saveAll;
$("#bUndo").onclick=()=>{if(confirm(`לבטל ${nDraft()} שינויים שלא נשמרו?`)) undoAll()};
addEventListener("beforeunload",e=>{if(nDraft()){e.preventDefault();e.returnValue=""}});
// "יש X שינויים שלא נשמרו. לשמור?" -> "save" | "go" (continue, drafts kept or dropped as the caller says) | "back"
function askSave(goText){return new Promise(res=>{if(!nDraft()) return res("go");
  const d=$("#dlgAsk");$("#askText").textContent=`יש ${nDraft()} שינויים שלא נשמרו. לשמור?`;$("#askGo").textContent=goText;
  const done=r=>{d.close();res(r)};$("#askSave").onclick=()=>done("save");$("#askGo").onclick=()=>done("go");$("#askBack").onclick=()=>done("back");d.oncancel=e=>{e.preventDefault();done("back")};
  d.showModal();$("#askSave").focus()})}
// switching to another vehicle: ask first (drafts stay if the user goes on without saving)
async function selectVehicle(veh){
  if(veh===sel) return true;
  if(sel&&nDraft()){const r=await askSave("המשך בלי לשמור");if(r==="back") return false;if(r==="save"&&!(await saveAll())) return false}
  sel=veh;pick=null;BLKMODE=false;SHOWORIG=false;HL=null;HLE=null;document.querySelectorAll(".row.sel").forEach(x=>x.classList.remove("sel"));
  document.querySelector(`.row[data-v="${CSS.escape(veh)}"]`)?.classList.add("sel");side(sel);return true}

// ---- the vehicle dialog: the block of the selected vehicle over the full-width schedule. "הסידור הקודם / הבא" walk the
// schedule as shown (filters + sort); the date control shows the same vehicle on another day. Closing it (Esc / סגירה)
// returns to where the user was: the day, the vehicle, the schedule's scroll position and the focused row. ----
let VRET=null;
const DOWV=["א'","ב'","ג'","ד'","ה'","ו'","ש'"];
const vehDayTxt=d=>`יום ${DOWV[new Date(d+"T12:00:00Z").getUTCDay()]} ${d.slice(8,10)}.${d.slice(5,7)}.${d.slice(0,4)}`;
function vehHead(){const d=$("#dlgVeh");if(!d||!D) return;
  const h=$("#side h2");$("#vehT").innerHTML=h?h.innerHTML:(sel?`רכב ${esc(sel)}`:""); // the h2 is built with esc() in sideBody
  const vs=(window.YS_VIEW&&window.YS_VIEW.vs)||[],i=vs.findIndex(([v])=>v.veh===sel);
  $("#vehPrev").disabled=i<=0;$("#vehNext").disabled=i<0||i>=vs.length-1;
  $("#vehPos").textContent=i<0?(D.vehicles.some(v=>v.veh===sel)?"לא ברשימה המסוננת":"לא ברשימה של היום"):`${nf(i+1)} מתוך ${nf(vs.length)}`;
  const ds=[...days].sort(),k=ds.indexOf(D.day),sl=$("#vehDay"),sig=ds.join();
  if(sl.dataset.sig!==sig){sl.innerHTML=[...ds].reverse().map(x=>`<option value="${esc(x)}">${esc(vehDayTxt(x))}</option>`).join("");sl.dataset.sig=sig}
  sl.value=D.day;$("#vehDPrev").disabled=k<=0;$("#vehDNext").disabled=k<0||k>=ds.length-1}
function openVehDlg(from,o){const d=$("#dlgVeh");if(!sel||!D) return;if(d.open){side(sel);return}
  const g=$("#gantt");VRET={veh:sel,day:D.day,top:g.scrollTop,left:g.scrollLeft,x:scrollX,y:scrollY,el:from||document.activeElement,back:o&&o.back};
  $("#side").scrollTop=0;side(sel);d.showModal();$("#vehT").focus({preventScroll:true});
  if(HLE) $("#side .it.hl")?.scrollIntoView({block:"center"})}
const vehAnnounce=()=>{$("#vehLive").textContent=`${$("#vehT").textContent} · ${D?vehDayTxt(D.day):""}`};
async function vehStep(k){const vs=(window.YS_VIEW&&window.YS_VIEW.vs)||[],i=vs.findIndex(([v])=>v.veh===sel),n=vs[i+k];if(i<0||!n) return;
  if(!(await selectVehicle(n[0].veh))) return;$("#side").scrollTop=0;vehAnnounce();
  const b=$(k<0?"#vehPrev":"#vehNext");if(b.disabled) $(k<0?"#vehNext":"#vehPrev").focus()}
function vehDay(day){if(!day||!D||day===D.day) return;loadDay(day,()=>{$("#side").scrollTop=0;vehAnnounce()})}
function vehDayStep(k){const ds=[...days].sort(),i=ds.indexOf(D.day);vehDay(ds[i+k]);
  setTimeout(()=>{const b=$(k<0?"#vehDPrev":"#vehDNext");if(b.disabled) $("#vehDay").focus()},0)}
$("#vehPrev").onclick=()=>vehStep(-1);$("#vehNext").onclick=()=>vehStep(1);
$("#vehDPrev").onclick=()=>vehDayStep(-1);$("#vehDNext").onclick=()=>vehDayStep(1);
$("#vehDay").onchange=e=>vehDay(e.target.value);
$("#vehClose").onclick=()=>$("#dlgVeh").close();
// focus stays inside the dialog: Tab from the last control goes to the first, Shift+Tab from the first to the last
$("#dlgVeh").addEventListener("keydown",e=>{if(e.key!=="Tab") return;
  const f=[...$("#dlgVeh").querySelectorAll('button,select,input,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter(x=>!x.disabled&&x.getClientRects().length);if(!f.length) return;
  const a=f[0],z=f[f.length-1],el=document.activeElement;
  if(e.shiftKey&&(el===a||!$("#dlgVeh").contains(el)||el===$("#vehT"))){e.preventDefault();z.focus()}else if(!e.shiftKey&&el===z){e.preventDefault();a.focus()}});
$("#vehSaveBtn").onclick=async e=>{e.currentTarget.disabled=true;await saveAll();drawSaveBar()};
$("#vehUndo").onclick=()=>$("#bUndo").click();
new MutationObserver(()=>{const m=$("#saveMsg"),v=$("#vehSaveMsg");v.textContent=m.textContent;v.className=m.className.replace("savemsg","")}).observe($("#saveMsg"),{childList:true,characterData:true,subtree:true,attributes:true});
$("#dlgVeh").addEventListener("close",()=>{const r=VRET;VRET=null;BLKMODE=false;SHOWORIG=false;HLE=null;if(!r){render();return}
  const vis=el=>el&&el.isConnected&&el!==document.body&&el.getClientRects().length>0;
  const back=()=>{if(sel!==r.veh){sel=r.veh;pick=null;HL=null}render();
    const g=$("#gantt");g.scrollTop=r.top;g.scrollLeft=r.left;scrollTo(r.x,r.y);
    const q=CSS.escape(r.veh),el=[r.el,document.querySelector(`.row[data-v="${q}"]`),document.querySelector(`.m-vc[data-v="${q}"]`)].find(vis);
    if(el) el.focus({preventScroll:true});if(r.back) r.back()};
  if(D&&r.day&&D.day!==r.day) loadDay(r.day,back); else back()});

// ---- manual change of an empty leg's origin / destination (block edit "leg"): e.g. the GPS lost the bus on Begin road,
// 700 m before the terminal it really reached, and the leg after it was routed from the middle of the road. The choices
// are the planned last stop of the trip before / first stop of the trip after, and known stops nearby (a stop with an
// origin anchor is routed from its anchor, as always). Saved with the other drafts on "שמירה". ----
let LEGED=null;
const isRaw=n=>/^(ליד |מיקום)/.test(n||"");
function knownStops(){const m=new Map();
  for(const J of Object.values(window.DAY_DATA||{})) for(const v of J.vehicles) for(const i of v.items) if(i.kind==="trip"){
    if(i.a&&!isRaw(i.frm)) m.set(pk(i.a),{p:i.a,n:i.frm}); if(i.b&&!isRaw(i.to)) m.set(pk(i.b),{p:i.b,n:i.to})}
  return m}
// a route's planned terminal (route catalog of the day) as a stop: named like the trips when that stop is known
function routeEnd(line,near,end){let best=null,bd=1e9;for(const r of D.routes||[]) if(String(r.line)===String(line)){const q=end?r.d:r.o,d=hav(near,q);if(d<bd){bd=d;best=r}}
  if(!best) return null;const p=end?best.d:best.o,k=knownStops().get(pk(p));return {p,n:k?k.n:(end?best.to:best.frm),d:bd}}
function legChoices(cur,curName,planned,plannedTxt){const out=[{p:cur,n:curName,t:"בלי שינוי"}],seen=new Set([pk(cur)]);
  if(planned&&!seen.has(pk(planned.p))){out.push({p:planned.p,n:planned.n,t:plannedTxt});seen.add(pk(planned.p))}
  [...knownStops().values()].map(s=>({...s,d:hav(s.p,cur)})).filter(s=>s.d<=3&&!seen.has(pk(s.p))).sort((a,b)=>a.d-b.d).slice(0,8)
    .forEach(s=>{out.push({p:s.p,n:s.n,t:"תחנה קרובה"});seen.add(pk(s.p))});
  return out}
const mTxt=km=>km<1?`${nf(Math.round(km*100)*10)} מ׳`:`${kmTxt(km)} ק״מ`;
function legDlg(){let d=$("#dlgLeg");if(d) return d;d=document.createElement("dialog");d.id="dlgLeg";d.className="legdlg";d.setAttribute("aria-labelledby","lgT");
  d.innerHTML=`<div class="dlg-h"><h3 id="lgT">שינוי מוצא / יעד של נסיעה ריקה</h3><button type="button" class="btn small" id="lgClose">סגירה</button></div>
    <div class="dlg-b"><div class="hint" id="lgHead"></div>
      <div class="field"><label for="lgA">מוצא</label><select id="lgA"></select></div>
      <div class="field"><label for="lgB">יעד</label><select id="lgB"></select></div>
      <p class="hint" id="lgSum" aria-live="polite"></p>
      <p class="hint">הק״מ מחושבים מחדש לפי כביש מהנקודות שנבחרו. תחנה עם נקודת עיגון מאושרת יוצאת מנקודת העיגון. המקור לא משתנה, ואפשר לבטל את העריכה בכל זמן.</p></div>
    <div class="dlg-f"><button type="button" class="btn primary" id="lgOk">החלה (טיוטה)</button><button type="button" class="btn" id="lgMap">הצגה על מפה</button><span class="msg" id="lgMsg" role="status"></span></div>`;
  document.body.appendChild(d);
  const pick=()=>({A:LEGED.ca[+$("#lgA").value],B:LEGED.cb[+$("#lgB").value]});
  const sum=()=>{const {A,B}=pick();$("#lgSum").textContent=`קו אווירי: ${mTxt(hav(A.p,B.p))} (עכשיו ${mTxt(hav(LEGED.i.a,LEGED.i.b))} אווירי, ${kmTxt(LEGED.i.km)} ק״מ בכביש)`};
  $("#lgA").onchange=sum;$("#lgB").onchange=sum;$("#lgClose").onclick=()=>d.close();
  $("#lgMap").onclick=()=>{const {A,B}=pick();legMap({a:A.p,b:B.p,km:null,min:null,free:LEGED.i.end-LEGED.i.start,frm:A.n,to:B.n,title:`רכב ${sel} · ריק ${fmt(LEGED.i.start)}–${fmt(LEGED.i.end)} · הנקודות שנבחרו`})};
  $("#lgOk").onclick=()=>{const {A,B}=pick(),i=LEGED.i,ca=+$("#lgA").value>0,cb=+$("#lgB").value>0;
    if(!ca&&!cb){$("#lgMsg").className="msg err";$("#lgMsg").textContent="לא נבחר שינוי";return}
    // a newer choice for the same leg replaces an earlier one that is still a draft
    for(const e of Object.values(DRAFT.blk)) if(e&&e.action==="leg"&&e.day===D.day&&e.veh===sel&&+e.payload.sched===i.next_sched&&!BLK[e.id]) delete DRAFT.blk[e.id];
    d.close();mkEdit("leg",{sched:i.next_sched,...(ca?{a:A.p,frm:A.n}:{}),...(cb?{b:B.p,to:B.n}:{})})};
  return d}
function openLegEdit(sc){const v=D.vehicles.find(x=>x.veh===sel);if(!v||!canEdit()) return;const k=v.items.findIndex(x=>x.kind==="empty"&&x.next_sched===sc);if(k<0) return;
  const i=v.items[k],prev=[...v.items.slice(0,k)].reverse().find(x=>x.kind==="trip"),next=v.items.slice(k+1).find(x=>x.kind==="trip"),d=legDlg();
  // the choices start from the leg as the day file has it (an earlier hand-made choice is listed as "בלי שינוי")
  const pe=prev&&routeEnd(prev.line,prev.b,true),ns=next&&routeEnd(next.line,next.a,false);
  LEGED={i,ca:legChoices(i.a,i.frm,pe,`סוף המסלול המתוכנן של קו ${prev?prev.line:""}`),cb:legChoices(i.b,i.to,ns,`תחילת המסלול המתוכנן של קו ${next?next.line:""}`)};
  $("#lgA").innerHTML=LEGED.ca.map((c,n)=>`<option value="${n}">${esc(c.n)} · ${esc(c.t)}${n?` · ${mTxt(hav(c.p,i.a))} מהמוצא הנוכחי`:""}</option>`).join("");
  $("#lgB").innerHTML=LEGED.cb.map((c,n)=>`<option value="${n}">${esc(c.n)} · ${esc(c.t)}${n?` · ${mTxt(hav(c.p,i.b))} מהיעד הנוכחי`:""}</option>`).join("");
  // the usual fix is ready: the planned last stop of the trip before, when the leg starts away from it
  if(pe&&hav(pe.p,i.a)>0.2&&LEGED.ca[1]&&pk(LEGED.ca[1].p)===pk(pe.p)) $("#lgA").value="1";
  $("#lgHead").innerHTML=`רכב ${esc(sel)} · ${dl(D.day)} · ריק ${fmt(i.start)}–${fmt(i.end)}${prev?`<br>אחרי קו ${esc(prev.line)}: ${esc(prev.frm)} ← ${esc(prev.to)}`:""}${next?`<br>לפני קו ${esc(next.line)}: ${esc(next.frm)} ← ${esc(next.to)}`:""}`;
  $("#lgMsg").textContent="";$("#lgA").onchange();d.showModal();$("#lgA").focus()}

// ---- manual block edits (fixing data errors): every edit is a draft override (block_edits) on the vehicle-day; the
// original day file never changes. assets/core.js applyBlockEdits() rebuilds the edited blocks (empty legs by road,
// totals, start/end) and everything else (nights, cards, branch, savings engine) is computed from them. ----
let BLKMODE=false, SHOWORIG=false, TR=null, EDC={k:"",m:new Map(),ends:null};
const editsOf=day=>Object.values(eff().BLK).filter(e=>e.day===day);
function edCache(){const k=DV+"|"+ROAD.size+"|"+anchors().size+"|"+VIAOK.map(x=>x.id).join();if(EDC.k!==k) EDC={k,m:new Map(),ends:null};return EDC}
// the day as shown: the raw day file with the block edits of that day applied (raw when there are none)
function effDay(day){const raw=window.DAY_DATA&&window.DAY_DATA[day];if(!raw) return null;const es=editsOf(day);if(!es.length&&!anchors().size) return raw;
  const c=edCache();if(!c.m.has(day)){const J=anchorDay(raw);c.m.set(day,es.length?DH.applyBlockEdits(J,es,{road:roadOf}):J)}return c.m.get(day)}
// the cross-day index with the edited days laid over it (only days whose file is loaded can be re-read)
function endsEff(){const c=edCache();if(c.ends) return c.ends;const ed={};
  for(const d of new Set(Object.values(eff().BLK).map(e=>e.day))) ed[d]=effDay(d);
  return c.ends=DH.endsWithEdits(ENDS,ed)}
function ensureDayLoaded(day){return new Promise((ok,bad)=>{if(window.DAY_DATA&&window.DAY_DATA[day]) return ok();
  const fin=async()=>{try{window.DAY_DATA=window.DAY_DATA||{};window.DAY_DATA[day]=await decryptDay(day);ok()}catch(e){bad(e)}};
  if(window.ENC_DAY&&window.ENC_DAY[day]) return fin();
  const s=document.createElement("script");s.src=`data/${OP.slug}/day_${day}.js?v=${encodeURIComponent(DAYVER[day]||APP_VER)}`;s.onload=fin;s.onerror=bad;document.head.appendChild(s)})}
// edits on nearby days change where vehicles start/end, so those days are read too (nights across days stay right)
function loadEditedNeighbours(day){const n=DH.dayNum(day);
  for(const d of new Set(Object.values(eff().BLK).map(e=>e.day)))
    if(d!==day&&days.includes(d)&&Math.abs(DH.dayNum(d)-n)<=DH.LOOKBACK&&!(window.DAY_DATA&&window.DAY_DATA[d])) ensureDayLoaded(d).then(()=>{EDC.k="";render()},()=>{})}
// the same view for the savings engine (its getBlocks host hook): a day file object -> with that day's block edits applied
window.YS_HOST=Object.assign(window.YS_HOST||{},{getBlocks:dayObj=>{const es=editsOf(dayObj.day);return es.length?DH.applyBlockEdits(dayObj,es,{road:roadOf}):dayObj}});
// ---- savings suggestions (savings/*.js, loaded on first open): the panel gets everything through this host ----
let SAV=null;
const loadJs=src=>new Promise((ok,bad)=>{const s=document.createElement("script");s.src=src+"?v="+APP_VER;s.onload=ok;s.onerror=bad;document.head.appendChild(s)});
async function openSavings(){
  if(!window.SavingsPanel){const l=document.createElement("link");l.rel="stylesheet";l.href="savings/panel.css?v="+APP_VER;document.head.appendChild(l);
    await loadJs("savings/engine.js");await loadJs("savings/panel.js")}
  if(SAV&&SAV.op!==OP.id){SAV.ui.destroy();SAV=null}
  if(!SAV){const H=window.YS_HOST;
    SAV={op:OP.id,ui:SavingsPanel.mount($("#savBody"),{operatorId:OP.id,canEdit,days:()=>days,currentDay:()=>D&&D.day,
      loadDay:async day=>{await ensureDayLoaded(day);return window.DAY_DATA[day]},getBlocks:H.getBlocks,
      roadEntries:()=>[...ROAD].map(([k,v])=>[k,v.km,v.min]),
      fetchRoad:async(pairs,cb)=>{const rows=[];let i=0; // same path as the night legs: shared cache, then OSRM; new results saved for everyone
        for(const [a,b] of pairs){const had=ROAD.has(roadKey(a,b)),r=await roadKm(a,b);
          if(r.road&&!had) rows.push(roadRow(a,b,r));
          cb(++i,pairs.length);if(!had) await new Promise(r=>setTimeout(r,150))}
        if(rows.length&&canEdit()) for(let k=0;k<rows.length;k+=50) try{await upsert("road_cache",rows.slice(k,k+50),ROADPK)}catch(e){console.warn("road save",e)}},
      branchOf:veh=>{try{return MODEL.branchOf(veh,D.day).b||""}catch{return ""}},
      depotOf:veh=>{const d=MODEL&&MODEL.depotFor(veh,"in",null);return d&&d.lat!==""&&d.lat!=null&&d.lon!==""&&d.lon!=null?[+d.lat,+d.lon]:null},
      dcp:()=>eff().S.driver_change_points||[],getRows,rpc,workerUrl:"savings/worker.js?v="+APP_VER,
      getDraftRules:()=>DRAFT.rules.set||null,
      setDraftRules:rs=>{if(!canEdit()) return;if(rs) DRAFT.rules.set=rs; else delete DRAFT.rules.set;touched()}})}}
  $("#dlgSav").showModal()}
$("#bSav").onclick=()=>openSavings().catch(e=>alert("טעינת הצעות החיסכון נכשלה: "+errText(e)));
$("#savClose").onclick=()=>$("#dlgSav").close();
const EDNAME={delete:"מחיקה",replace:"החלפה",add:"הוספה",times:"שעות",move:"העברה",leg:"מוצא / יעד"};
function edDesc(e){const p=e.payload||{};
  return e.action==="delete"?`נמחקה הנסיעה של ${fmt(+p.sched)}`:e.action==="times"?`הנסיעה של ${fmt(+p.sched)} → ${fmt(+p.start)}–${fmt(+p.end)}`
    :e.action==="replace"?`הנסיעה של ${fmt(+p.sched)} הוחלפה בקו ${p.line} (${p.frm} ← ${p.to}), ${fmt(+p.start)}`
    :e.action==="add"?`נוספה נסיעה: קו ${p.line} (${p.frm} ← ${p.to}), ${fmt(+p.start)}`
    :e.action==="leg"?`הנסיעה הריקה לפני ${fmt(+p.sched)}: ${p.a?"מוצא ← "+p.frm:""}${p.a&&p.b?" · ":""}${p.b?"יעד ← "+p.to:""}`:`הנסיעה של ${fmt(+p.sched)} הועברה לרכב ${p.to_veh}`}
const whenTxt=t=>{try{return t?new Date(t).toLocaleString("he-IL",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):""}catch{return ""}};
function editsBlock(veh){const es=editsOf(D.day).filter(e=>e.veh===veh||(e.payload||{}).to_veh===veh).sort((a,b)=>((a.payload||{}).seq||0)-((b.payload||{}).seq||0));
  if(!es.length) return "";const orph=new Set((D.edits&&D.edits.orphans)||[]);
  return `<div class="it edt"><span><b>✎ עריכות ידניות ברכב הזה (${es.length})</b><span class="sub">החישובים (ריק, לילות, סכומים) נעשים מהסידור הערוך. המקור לא משתנה.</span></span><span class="t"></span></div>`+
    es.map(e=>`<div class="it edt"><span>${esc(edDesc(e))}${e.veh!==veh?` (מרכב ${esc(e.veh)})`:""}<span class="sub edtm">${esc((e.payload||{}).by||"")}${e.created_at?" · "+whenTxt(e.created_at):""}${DRAFT.blk[e.id]&&!BLK[e.id]?" · טיוטה, לא נשמר":""}${orph.has(e.id)?" · לא הוחלה: הנסיעה לא נמצאה":""}</span></span>
      <span class="t">${canEdit()?`<button class="btn small" data-unblk="${esc(e.id)}">ביטול</button>`:""}</span></div>`).join("")}
function origBlock(veh){const raw=(window.DAY_DATA[D.day].vehicles||[]).find(x=>x.veh===veh);
  return `<div class="orig"><b>המקור (לפני העריכה)</b>`+(raw?raw.items.filter(i=>i.kind==="trip").map(i=>`<div>${fmt(i.start)}–${fmt(i.end)} · קו ${esc(i.line)} · ${esc(i.frm)} ← ${esc(i.to)}</div>`).join(""):"<div>הרכב לא פעל ביום הזה במקור</div>")+`</div>`}
const fixLink=()=>canEdit()&&!BLKMODE?` <button class="linkbtn" data-blkmode>עריכת הסידור</button>`:"";
const OWNLINK={added:"לא שויכה ב־Stride (המאגר הציבורי של Open Bus שממנו מגיעים מיקומי ה־GPS); שויכה על ידינו מול לוח הרישוי",
  trip_no:"לא שויכה ב־Stride (המאגר הציבורי של Open Bus שממנו מגיעים מיקומי ה־GPS); שויכה על ידינו מול לוח הרישוי, לפי מספר הנסיעה",
  relinked:"Stride (המאגר הציבורי של Open Bus) שייך אותה לנסיעה אחרת בלוח; שויכה על ידינו מול לוח הרישוי של היום"};
function srcTxt(i){return (i.own_link&&OWNLINK[i.own_link]?`<span class="sub">${OWNLINK[i.own_link]}</span>`:"")
  +(i.own_gps?`<span class="sub">שעות ההתחלה והסיום חושבו על ידינו מנקודות ה־GPS של הנסיעה (Stride לא חישב אותן)</span>`:"")
  +(i.end_wait?`<span class="sub">האוטובוס עמד בתחנה האחרונה עוד ${i.end_wait} דק׳ אחרי שהגיע (SIRI השאיר את הנסיעה פתוחה); הסיום לפי ההגעה</span>`:"")
  +(i.no_time?`<span class="sub" style="color:var(--warn)">שעת סיום: אין נתון (אין GPS ואין זמן מתוכנן לקו)</span>`:"")
  +(i.dur_line&&i.no_gps?`<span class="sub">משך לפי הזמן המתוכנן של הקו באותו יום</span>`:"")}
function tripExtra(i){let h=srcTxt(i)+(i.edited?`<span class="sub edtm">✎ נערך ידנית${i.edit&&i.edit.by?" · "+esc(i.edit.by):""}${i.moved_from?" · הועבר מרכב "+esc(i.moved_from):""}</span>`:"");
  if(BLKMODE&&canEdit()) h+=`<span class="sub">${[["delete","מחיקה"],["replace","החלפה"],["times","שעות"],["move","העברה לרכב"]].map(([a,t])=>`<button class="btn small" data-bact="${a}" data-s="${i.sched}">${t}</button>`).join(" ")}</span>`;
  return h}
function mkEdit(action,payload){const id=crypto.randomUUID?crypto.randomUUID():"10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
  setDraft("blk",id,{id,day:D.day,veh:sel,action,payload:{...payload,seq:Date.now(),by:(PROFILE&&PROFILE.username)||""},created_at:new Date().toISOString(),note:null});
  render();ensureRoad()}
const tParse=s=>{const m=/^\s*(\d{1,2}):(\d{2})\s*$/.exec(s||"");if(!m||+m[2]>59) return null;let x=+m[1]*60+ +m[2];if(x<DAY_START_H*60) x+=1440;return x<DAY_START_H*60+1440+240?x:null};
const tripOfSel=sc=>D.vehicles.find(x=>x.veh===sel).items.find(i=>i.kind==="trip"&&i.sched===sc);
function openTrip(action,sc){const t=sc!=null?tripOfSel(sc):null,v=D.vehicles.find(x=>x.veh===sel);TR={action,sc,t,r:null};
  $("#trTitle").textContent={replace:"החלפת נסיעה",add:"הוספת נסיעה",times:"שינוי שעות הנסיעה",move:"העברת נסיעה לרכב אחר"}[action];
  $("#trHead").innerHTML=`רכב ${esc(sel)} · ${dl(D.day)}`+(t?`<br>הנסיעה: קו ${esc(t.line)} · ${esc(t.frm)} ← ${esc(t.to)} · ${fmt(t.start)}–${fmt(t.end)}`:"")+
    `<br>${action==="replace"||action==="add"?"בוחרים קו וכיוון מתוך הקווים של היום. משך הנסיעה לפי הקו. אפשר לשנות את שעת ההתחלה.":action==="times"?"שעות לפי שעון יום השירות (אחרי חצות: 24:30, 25:10 …).":"הנסיעה תוסר מהרכב הזה ותופיע ברכב שתבחר (גם רכב שלא פעל היום)."}`;
  $("#trTimes").hidden=action==="move"; $("#trEndBox").hidden=action!=="times"; $("#trMoveBox").hidden=action!=="move"; $("#trPickBox").hidden=!(action==="replace"||action==="add");
  const last=v.items.filter(i=>i.kind==="trip").slice(-1)[0];
  $("#trStart").value=t?fmt(t.start):last?fmt(last.end+30):""; $("#trEnd").value=t?fmt(t.end):"";
  $("#trVeh").value=""; $("#trVehs").innerHTML=D.vehicles.filter(x=>x.veh!==sel).map(x=>`<option value="${esc(x.veh)}">`).join("");
  $("#trQ").value=""; $("#trMsg").textContent=""; drawTrip(); $("#dlgTrip").showModal(); (action==="move"?$("#trVeh"):action==="times"?$("#trStart"):$("#trQ")).focus()}
function drawTrip(){if($("#trPickBox").hidden) return;const q=$("#trQ").value.trim(),t=TR.t,RS=D.routes||[];
  const near=r=>t?(r.line===t.line?-1:0)+estKm(t.a,r.o)/100:0;
  const rows=RS.map((r,idx)=>({r,idx})).filter(x=>!q||x.r.line.includes(q)||x.r.frm.includes(q)||x.r.to.includes(q)).sort((x,y)=>near(x.r)-near(y.r)||x.r.line.localeCompare(y.r.line,"he",{numeric:true}));
  $("#trList").innerHTML=`<table class="ed"><thead><tr><th>קו</th><th>מ־</th><th>אל</th><th>ק״מ</th><th>משך</th></tr></thead><tbody>`+
    rows.slice(0,300).map(x=>`<tr class="pickable${TR.r===x.r?" chosen":""}" data-ti="${x.idx}" tabindex="0"><td><b>${esc(x.r.line)}</b></td><td>${esc(x.r.frm)}</td><td>${esc(x.r.to)}</td><td>${nf(x.r.km)}</td><td>${nf(x.r.dur)} דק׳</td></tr>`).join("")+`</tbody></table>`}
$("#trList").addEventListener("click",e=>{const tr=e.target.closest("tr[data-ti]");if(!tr) return;TR.r=D.routes[+tr.dataset.ti];drawTrip()});
$("#trList").addEventListener("keydown",e=>{const tr=e.target.closest("tr[data-ti]");if(tr&&(e.key==="Enter"||e.key===" ")){e.preventDefault();tr.click()}});
$("#trQ").oninput=drawTrip; $("#trClose").onclick=()=>$("#dlgTrip").close();
$("#trOk").onclick=()=>{const m=$("#trMsg"),err=t=>{m.className="msg err";m.textContent=t};const a=TR.action,st=tParse($("#trStart").value);
  if(a==="times"){const en=tParse($("#trEnd").value);if(st==null||en==null) return err("שעה לא תקינה (למשל 17:30 או 25:10)");if(en<=st) return err("הסיום צריך להיות אחרי ההתחלה");
    mkEdit("times",{sched:TR.sc,start:st,end:en})}
  else if(a==="move"){const to=$("#trVeh").value.trim();if(!/^\d{3,12}$/.test(to)) return err("מספר רכב לא תקין");if(to===sel) return err("זה אותו רכב");mkEdit("move",{sched:TR.sc,to_veh:to})}
  else{const r=TR.r;if(!r) return err("בחרו קו מהרשימה");if(st==null) return err("שעת התחלה לא תקינה");
    const city=x=>String(x||"").split(",").pop().trim(), base={line:r.line,frm:r.frm,to:r.to,o:r.o,d:r.d,km:r.km,dur:r.dur,start:st,cls:r.cls,ca:city(r.frm),cb:city(r.to)};
    if(a==="replace") mkEdit("replace",{...base,sched:TR.sc,...(TR.t&&TR.t.auto?{auto:true}:{})});
    else{let sc=st;const used=new Set(D.vehicles.find(x=>x.veh===sel).items.map(i=>i.sched));while(used.has(sc)) sc++;mkEdit("add",{...base,sched:sc})}}
  $("#dlgTrip").close()};
$("#side").addEventListener("click",e=>{const t=e.target;
  if(t.dataset.blkmode!=null){BLKMODE=!BLKMODE;side(sel);return}
  if(t.dataset.blkopen!=null){BLKMODE=true;side(sel);$("#side").scrollTop=0;return}
  if(t.dataset.note!=null){openNote(t.dataset.nk,+t.dataset.note);return}
  if(t.dataset.showorig!=null){SHOWORIG=!SHOWORIG;side(sel);return}
  if(t.dataset.badd!=null){openTrip("add",null);return}
  if(t.dataset.legedit!=null){openLegEdit(+t.dataset.legedit);return}
  if(t.dataset.unblk!=null){const x=eff().BLK[t.dataset.unblk];if(x&&confirm(`לבטל את העריכה "${edDesc(x)}"?`)){setDraft("blk",t.dataset.unblk,null);render();ensureRoad()}return}
  if(t.dataset.bact!=null){const a=t.dataset.bact,sc=+t.dataset.s;
    if(a==="delete"){const tr=tripOfSel(sc);if(tr&&confirm(`למחוק את הנסיעה של ${fmt(tr.start)} (קו ${tr.line})? אפשר לבטל אחר כך.`)) mkEdit("delete",{sched:sc});return}
    openTrip(a,sc)}});

let NOTE=null;
function openNote(kind,start){NOTE={kind,start};$("#noteHead").textContent=`רכב ${sel} · ${dl(D.day)} · ${kind==="overnight"?"נסיעה ריקה בלילה":"נסיעה ריקה ביום"} שמתחילה ב־${fmt(start)}`;
  $("#noteText").value="";$("#noteMsg").textContent="";$("#dlgNote").showModal();$("#noteText").focus()}
$("#noteClose").onclick=()=>$("#dlgNote").close();
$("#noteOk").onclick=()=>{const t=$("#noteText").value.trim();if(!t){$("#noteMsg").className="msg err";$("#noteMsg").textContent="ההערה ריקה";return}
  const id=crypto.randomUUID();setDraft("notes",id,{id,day:D.day,veh:sel,leg_start_min:NOTE.start,kind:NOTE.kind,text:t.slice(0,2000)});$("#dlgNote").close();side(sel)};

// ---- overnight reinforcement: a specific line + direction driven in the night, with its empty legs around it ----
let NR=null;
function openNightRein(N,veh){
  const base=MODEL.night(veh,N); if(!base||!base.p.e){render();return}
  const pe=base.p.e,e=ENDS[N][veh],A=[pe[6],pe[7]],F=[e[1],e[2]],tA=DH.dayNum(base.p.day)*1440+pe[5],tF=DH.dayNum(N)*1440+e[0];
  const cur=(eff().OVN[N+"|"+veh]||{}).detail||{}, RS=(D.routes||[]);
  const rows=RS.map((r,idx)=>{const k1=estKm(A,r.o),k2=estKm(r.d,F),need=estMin(k1)+r.dur+estMin(k2);
    return {r,idx,k1,k2,need,fits:need<=tF-tA}}).sort((x,y)=>(y.fits-x.fits)||((x.k1+x.k2)-(y.k1+y.k2)));
  NR={N,veh,P:base.p.day,A,F,tA,tF,rows,r:null,cur,home:MODEL.depotFor(veh,"out",e[3])||MODEL.depotFor(veh,"out",pe[8])};
  if(cur.line){NR.r=RS.find(r=>r.line===cur.line&&r.frm===cur.frm&&r.to===cur.to)||{line:cur.line,frm:cur.frm,to:cur.to,o:cur.o,d:cur.d,km:cur.rein_km,dur:cur.dur}}
  $("#nrHead").innerHTML=`רכב ${esc(veh)} · הלילה שבין ${dl(base.p.day)} ל־${dl(N)}<br>סיים ב־${dl(base.p.day)} ${fmt(pe[5])}${inPl(pe[9])} · מתחיל ב־${dl(N)} ${fmt(e[0])}${inPl(e[4])} (${Math.round(tF-tA)} דק׳ בין לבין)<br>
    בוחרים את הקו והכיוון שהרכב נסע בלילה, ומתי. רק ק״מ הקו נספרים כתגבור. הנסיעה מסוף היום לתחילת הקו, מסוף הקו לחניון (אם חיכה בחניון) ומשם לנסיעה הראשונה נשארות ק״מ ריקים. ההמלצות למעלה הן הקווים שהכי קרובים לדרך.`;
  const dsel=$("#nrDepot"); dsel.innerHTML=`<option value="">אין: חיכה בסוף הקו</option>`+(eff().S.depots||[]).map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("");
  dsel.value=cur.depot_wait||""; $("#nrQ").value=""; drawNR(); setNRTime(cur.start!=null?cur.start:null); nrPreview(); $("#dlgNR").showModal(); $("#nrQ").focus()}
function drawNR(){const q=$("#nrQ").value.trim(),rows=NR.rows.filter(x=>!q||x.r.line.includes(q)||x.r.frm.includes(q)||x.r.to.includes(q));
  $("#nrList").innerHTML=`<table class="ed"><thead><tr><th>קו</th><th>מ־</th><th>אל</th><th>ק״מ קו</th><th>ריק לתחילת הקו</th><th>ריק מסוף הקו</th><th>נכנס בלילה?</th></tr></thead><tbody>`+
    rows.slice(0,300).map((x,i)=>`<tr class="pickable${NR.r&&NR.r.line===x.r.line&&NR.r.frm===x.r.frm&&NR.r.to===x.r.to?" chosen":""}" data-nri="${x.idx}" tabindex="0"><td><b>${esc(x.r.line)}</b>${i<3&&!q?' <span class="badge">מומלץ</span>':""}</td><td>${esc(x.r.frm)}</td><td>${esc(x.r.to)}</td><td>${nf(x.r.km)}</td><td>~${nf(x.k1)}</td><td>~${nf(x.k2)}</td><td>${x.fits?'<span class="msg ok">כן</span>':'<span class="msg err">לא</span>'}</td></tr>`).join("")+`</tbody></table>`}
function setNRTime(t){ // t = absolute minute; default: right after reaching the line start
  if(t==null){const k1=NR.r?estKm(NR.A,NR.r.o):0;t=NR.tA+Math.round(estMin(k1))+5}
  const P0=DH.dayNum(NR.P)*1440,m=t-P0;
  if(m<1440+DAY_START_H*60){$("#nrDay").value="P";$("#nrTime").value=fmt(m)}else{$("#nrDay").value="N";$("#nrTime").value=fmt(t-DH.dayNum(NR.N)*1440)}}
function nrStart(){const m=/^(\d{1,2}):(\d{2})$/.exec($("#nrTime").value.trim());if(!m) return null;const mm=+m[1]*60+ +m[2];
  return $("#nrDay").value==="P"?DH.dayNum(NR.P)*1440+(mm<DAY_START_H*60?mm+1440:mm):DH.dayNum(NR.N)*1440+mm}
function nrDetail(){const r=NR.r,t=nrStart();if(!r||t==null) return null;
  return {line:String(r.line).slice(0,20),frm:r.frm,to:r.to,o:r.o,d:r.d,rein_km:r.km,dur:r.dur,start:t,depot_wait:$("#nrDepot").value||null,to_city:(r.to||"").split(",")[0].trim()}}
async function nrPreview(exact){
  const box=$("#nrPrev"),det=nrDetail();
  $("#nrDayP").textContent=`${dl(NR.P)} (ערב/לילה, עד ${fmt(DAY_START_H*60+1440)})`; $("#nrDayN").textContent=`${dl(NR.N)} (בוקר)`;
  if(!det){box.innerHTML=NR.r?'<span class="msg err">שעה לא תקינה (למשל 26:00 או 05:30)</span>':'<span class="muted">בחרו קו מהרשימה</span>';$("#nrSave").disabled=true;return}
  if(exact){box.innerHTML="מחשב לפי כביש…";const pts=[[NR.A,det.o],[det.d,NR.F]];
    const dw=det.depot_wait&&(eff().S.depots||[]).find(d=>d.id===det.depot_wait);if(dw&&hasLoc(dw)) pts.push([det.d,[+dw.lat,+dw.lon]],[[+dw.lat,+dw.lon],NR.F]);
    for(const [a,b] of pts) await roadKm(a,b)}
  const nt=DH.Model({days,dayStartMin:DAY_START_H*60,ends:ENDS,S:eff().S,OVN:{[NR.N+"|"+NR.veh]:{mode:"rein",detail:det}},REIN:{},AUTOR:{},road:(a,b)=>ROAD.get(roadKey(a,b))||null}).night(NR.veh,NR.N);
  const rel=l=>{const d0=DH.dayNum(l.day)*1440;return `${dl(l.day)} ${fmt(l.start-d0)}–${fmt(l.end-d0)}`};
  box.innerHTML=`<table class="ed"><thead><tr><th>קטע</th><th>מ־ ← אל</th><th>ק״מ</th><th>מתי</th><th>נספר ביום</th></tr></thead><tbody>`+
    nt.legs.map(l=>`<tr><td>${LEGNAME[l.kind]}</td><td>${esc(l.frm||"")} ← ${esc(l.to||"")}</td><td>${l.km==null?'<span class="msg err">חסר</span>':nf(l.km)+(l.kind==="rein"?" (תגבור)":l.road?"":" (הערכה)")}</td><td dir="ltr" style="text-align:right">${rel(l)}</td><td>${dl(l.day)}</td></tr>`).join("")+`</tbody></table>`+
    (nt.flags.includes("tight")?`<div class="msg err">לא נכנס בזמן: הקטעים ארוכים מהזמן שבין סוף היום הקודם (${dl(NR.P)} ${fmt(NR.tA-DH.dayNum(NR.P)*1440)}) לנסיעה הראשונה (${dl(NR.N)} ${fmt(NR.tF-DH.dayNum(NR.N)*1440)}). אפשר לסמן בכל זאת.</div>`:`<div class="msg ok">נכנס בזמן</div>`);
  $("#nrSave").disabled=false}
$("#nrList").addEventListener("click",e=>{const tr=e.target.closest("tr[data-nri]");if(!tr) return;NR.r=D.routes[+tr.dataset.nri];setNRTime(null);drawNR();nrPreview(true)});
$("#nrList").addEventListener("keydown",e=>{const tr=e.target.closest("tr[data-nri]");if(tr&&(e.key==="Enter"||e.key===" ")){e.preventDefault();tr.click()}});
$("#nrQ").oninput=drawNR; ["nrDay","nrTime","nrDepot"].forEach(id=>$("#"+id).addEventListener("change",()=>nrPreview(true)));
$("#nrClose").onclick=()=>{$("#dlgNR").close();NR=null;render()};
$("#nrSave").onclick=()=>{const det=nrDetail();if(!det) return;
  setDraft("ovn",NR.N+"|"+NR.veh,{day:NR.N,veh:NR.veh,mode:"rein",detail:det,note:null});$("#dlgNR").close();NR=null;render();ensureRoad()};
// ---- sign-in lives in the yalla-sa portal (platform rule: one login, logout only in the portal) ----
// no session -> the portal, which returns here after sign-in (?next= is checked there against an allow-list)
const PORTAL=location.hostname==="yalla-sa.app"?location.origin+"/":"https://yalla-sa.app/";
const toPortal=()=>location.replace(PORTAL+"?next="+encodeURIComponent(location.pathname+location.search));
// signed out in another tab (the portal's "יציאה" or its idle timeout): leave too
addEventListener("storage",e=>{if(e.key===SKEY&&!e.newValue&&!["recoverpw","code"].includes(GMODE)) toPortal()});

// ---- settings ----
async function loadSettings(){try{const rows=await getRows("settings",`select=key,value&${opq()}`)||[];for(const {key:k,value:v} of rows) S[k]=k==="defaults"?{...clone(DEF),...v}:v}catch(e){console.warn("settings",e)}}
const uid=()=>Math.random().toString(36).slice(2,9);
let LOOKRES=[];
function parseLoc(s){ // Waze ll=, Google @lat,lon / q= / !3d..!4d.., or plain "lat, lon"
  s=decodeURIComponent(s);
  const pats=[/[?&](?:ll|latlng|q|query|destination)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/,/@(-?\d+\.\d+),(-?\d+\.\d+)/,/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,/^\s*(-?\d+\.\d+)\s*[,\s]\s*(-?\d+\.\d+)\s*$/];
  for(const p of pats){const m=s.match(p);if(m){const a=+m[1],b=+m[2];if(a>29&&a<34&&b>34&&b<36.5) return [a.toFixed(6),b.toFixed(6)]}}
  return null;}
const LISTS={
  depots:{cols:[["name","שם"],["addr","כתובת או קישור"],["lat","קו רוחב"],["lon","קו אורך"],["cities","שיוך אוטומטי לפי ערים (מופרד בפסיקים)"]],
    hint:"רכב בלי חניון מוגדר משויך לפי העיר שבה הוא מתחיל או מסיים את היום."}, // later: capacity etc. as extra fields on each depot row
  fuel_stations:{cols:[["name","שם"],["fuel","סוג"],["addr","כתובת או קישור"],["lat","קו רוחב"],["lon","קו אורך"]],hint:"סוג: סולר או גז. ישמש לחישוב התדלוק בשלב הבא."},
  driver_change_points:{cols:[["name","שם המקום"],["addr","כתובת או קישור"],["lat","קו רוחב"],["lon","קו אורך"],["from","משעה"],["to","עד שעה"]],
    hint:"מותר להחליף נהג רק בנקודות האלה. בלי שעות = כל היום. ישמש את הצעות החיסכון."},
  stop_anchors:{cols:[["name","תחנה (השם כפי שמופיע בנתונים)"],["addr","כתובת או קישור"],["lat","קו רוחב לניתוב"],["lon","קו אורך לניתוב"],["note","הערה"]],
    hint:"נקודת עיגון = המקום שבו האוטובוס באמת עולה לכביש ליד התחנה (למשל היציאה ממסוף). כל נסיעה ריקה מהתחנה או אליה (גם בלילה) תחושב לפי כביש מהנקודה הזו. מתאים לתחנות שבהן המסלול נצמד לכביש הלא נכון. את שם התחנה בוחרים מהרשימה שנפתחת בהקלדה."}
};
LISTS.forced_legs={cols:[["name","תחנת סיום (השם כפי שמופיע בנתונים)"],["to_stop","תחנת היציאה הקבועה ממנה"],["note","הערה (למשל קודי התחנות)"]],noloc:true,
  hint:"נסיעה ריקה מוכרחת (דרגה קלה, מידע ולא אזהרה): הרכב סיים בתחנה שאינה חניון, ולכן חייב לנסוע ריק לתחנת היציאה הקבועה שלה. שורה לכל צמד; אותה תחנת סיום יכולה להופיע בכמה שורות."};
let tab="depots", draft=null, look=null;
const PRIVHINT="<b>פרטיות:</b> רק כתובות של חניונים, מסופים ואתרי החברה. לא כתובות מגורים של אנשים (הכתובת נשלחת לשירות המפות OpenStreetMap).";
const LOCHINT="<b>איך מכניסים מיקום:</b> בשדה \"כתובת או קישור\" כותבים כתובת רגילה (למשל: מבצע קדש, בני ברק) ולוחצים \"איתור\". אפשר גם להדביק קישור מלא מ־Waze או מגוגל מפות, או שני מספרים שהועתקו בקליק ימני בגוגל מפות. שמות מקומות כמו \"חניון אפיקים\" לא תמיד נמצאים בחיפוש, ואז עדיף קישור או כתובת. החיפוש נעשה ב־OpenStreetMap.";
// two sections: system settings (substance: depots, fuel, driver change points, branches, defaults, vehicles) and
// display settings (colors etc., later). Depot rows keep unknown fields, so later attributes (capacity …) fit in as-is.
function openSettings(){draft=clone(eff().S);look=null;$("#setMsg").textContent="";setSec("sys");$("#dlgSet").showModal()}
function setSec(sec){document.querySelectorAll(".secsw .btn").forEach(b=>b.classList.toggle("on",b.dataset.sec===sec));
  $("#sysTabs").hidden=$("#setFoot").hidden=sec!=="sys";
  if(sec==="sys") showTab(tab||"depots");
  else $("#setBody").innerHTML=`<p class="hint">כאן יוגדרו בהמשך צבעים ותצוגה (למשל צבעי הנסיעות בציר הזמן). עוד אין הגדרות בחלק הזה.</p>`}
document.querySelectorAll(".secsw .btn").forEach(b=>b.onclick=()=>setSec(b.dataset.sec));
function showTab(t){tab=t;document.querySelectorAll("#sysTabs button").forEach(b=>b.classList.toggle("on",b.dataset.tab===t));
  const ro=!canEdit(); let h=ro?`<p class="hint" style="color:var(--warn)">צפייה בלבד: ההרשאה שלך היא לצפייה. לשינויים פנה למנהל המפעיל.</p>`:"";
  if(LISTS[t]){const L=LISTS[t],rows=draft[t]||[];
    h+=`${L.noloc?"":`<p class="hint">${LOCHINT}</p><p class="hint">${PRIVHINT}</p>`}<p class="hint">${L.hint}</p><table class="ed"><thead><tr>${L.cols.map(c=>`<th>${c[1]}</th>`).join("")}<th></th></tr></thead><tbody>`+
      rows.map((r,i)=>`<tr>${L.cols.map(([k])=>`<td>${k==="fuel"?`<select data-i="${i}" data-k="${k}" ${ro?"disabled":""}><option></option>${["סולר","גז"].map(f=>`<option ${r[k]===f?"selected":""}>${f}</option>`).join("")}</select>`
        :k==="addr"?`<div style="display:flex;gap:4px"><input data-i="${i}" data-k="addr" value="${esc(r.addr??"")}" placeholder="כתובת חניון או מסוף, קישור Waze/גוגל או מספרים" style="min-width:200px" ${ro?"disabled":""}>${ro?"":`<button class="btn small" data-find="${i}">איתור</button>`}</div>${look&&look.i===i?`<div class="look">${look.html}</div>`:""}`
        :`<input data-i="${i}" data-k="${k}" value="${esc(r[k]??"")}" ${(t==="stop_anchors"||t==="forced_legs")&&(k==="name"||k==="to_stop")?'list="stopNames" style="min-width:220px"':""} ${["lat","lon"].includes(k)?'class="num" inputmode="decimal" dir="ltr"':["from","to"].includes(k)?'type="time"':""} ${ro?"disabled":""}>`}</td>`).join("")}
        <td>${ro?"":`<button class="btn small danger" data-del="${i}">מחיקה</button>`}</td></tr>`).join("")+
      `</tbody></table>${rows.length?"":`<p class="muted">עוד לא הוגדר כלום.</p>`}${ro?"":`<button class="btn small" id="addRow" style="margin-top:8px">+ הוספה</button>`}`;}
  else if(t==="via_links") h+=PLATFORM?viaTab(ro):`<p class="hint">רק מנהל מערכת מנהל את נקודות המעבר. אפשר להציע נקודת מעבר מתוך "בעיות מסלול".</p>`;
  else if(t==="defaults"){const d=draft.defaults;
    h+=`<p class="hint">ברירת המחדל לכל רכב שאין לו הגדרה משלו בלשונית "רכבים".</p><table class="ed"><tr><th>סוג שירות</th><th>דלק</th></tr>`+
      ["עירוני","בינעירוני"].map(c=>`<tr><td>${c}</td><td><select data-def="fuel_by_class" data-c="${c}" ${ro?"disabled":""}><option></option>${["סולר","גז"].map(f=>`<option ${d.fuel_by_class?.[c]===f?"selected":""}>${f}</option>`).join("")}</select></td></tr>`).join("")+
      `</table><table class="ed" style="margin-top:14px"><tr><th>דלק</th><th>טווח נסיעה בק״מ (ממלא עד ריק)</th></tr>`+
      ["גז","סולר"].map(f=>`<tr><td>${f}</td><td><input class="num" inputmode="decimal" data-def="range_km_by_fuel" data-c="${f}" value="${esc(d.range_km_by_fuel?.[f]??"")}" ${ro?"disabled":""}></td></tr>`).join("")+`</table>`+
      `<div class="field" style="margin-top:14px;max-width:420px"><label for="dfo"><b>יציאה מוכרחת מחניון רחוק</b>: יציאה מחניון לתחילת הקו מעל (ק״מ)</label><input id="dfo" class="num" inputmode="decimal" data-defn="forced_out_km" value="${esc(d.forced_out_km??DEF.forced_out_km)}" ${ro?"disabled":""}></div>`+
      `<div class="field" style="margin-top:14px;max-width:420px"><label for="dbr"><b>סניפים</b> (מופרדים בפסיקים)</label><input id="dbr" data-defl="branches" value="${esc((d.branches||DEF.branches).join(", "))}" ${ro?"disabled":""}></div>`;}
  else if(t==="vehicles"){const vs=D?D.vehicles:[];
    h+=`<p class="hint">שדה ריק = ברירת מחדל. הרשימה מציגה את הרכבים של ${D?D.day.split("-").reverse().join("."):""}. לפני שמשייכים חניון, צריך להוסיף אותו בלשונית "חניונים" ולשמור.</p><input type="search" id="vq" placeholder="חיפוש מספר רכב" style="margin-bottom:8px">
      ${ro||!D?"":`<button class="btn small" id="brAll" style="margin:0 8px 8px 0">אישור כל השיוכים האוטומטיים</button>`}
      <table class="ed"><thead><tr><th>רכב</th><th>סוג</th><th>סניף</th><th>חניון</th><th>חניון סוף יום (אם שונה)</th><th>דלק</th><th>טווח ק״מ</th><th>נגיש</th></tr></thead><tbody id="vrows">`+
      vs.map(v=>{const x=draft.vehicles[v.veh]||{},opt=cur=>`<option value=""></option>`+(draft.depots||[]).map(d=>`<option value="${esc(d.id)}" ${cur===d.id?"selected":""}>${esc(d.name)}</option>`).join("");
        const ab=autoBranch(v),bsel=x.branch_confirmed?(x.branch||""):"__auto";
        const brs=`<select data-vb="1" ${ro?"disabled":""}>`+[["__auto",`אוטומטי: ${ab||"לא משויך"}`],["","לא משויך"],...branches().map(b=>[b,b])].map(([val,lab])=>`<option value="${esc(val)}" ${bsel===val?"selected":""}>${esc(lab)}</option>`).join("")+`</select>`;
        return `<tr data-v="${esc(v.veh)}"><td>${esc(v.veh)}${accIcon(v.veh)}</td><td>${esc(v.cls)}</td><td>${brs}</td><td><select data-vk="depot" ${ro?"disabled":""}>${opt(x.depot)}</select></td><td><select data-vk="depot_end" ${ro?"disabled":""}>${opt(x.depot_end)}</select></td>
          <td><select data-vk="fuel" ${ro?"disabled":""}><option></option>${["סולר","גז"].map(f=>`<option ${x.fuel===f?"selected":""}>${f}</option>`).join("")}</select></td>
          <td><input class="num" inputmode="decimal" data-vk="range_km" value="${esc(x.range_km??"")}" ${ro?"disabled":""}></td>
          <td><label class="acck"><input type="checkbox" data-vk="accessible" ${x.accessible?"checked":""} ${ro?"disabled":""} aria-label="רכב ${esc(v.veh)} נגיש"> נגיש</label></td></tr>`}).join("")+`</tbody></table>`;}
  if(t==="stop_anchors"||t==="forced_legs"){const ns=new Set();for(const J of Object.values(window.DAY_DATA||{})) for(const v of J.vehicles) for(const i of v.items) if(i.kind==="trip") for(const n of [i.frm,i.to]) if(n&&!/^(ליד|מיקום)/.test(n)) ns.add(n);
    h+=`<datalist id="stopNames">${[...ns].sort().map(n=>`<option value="${esc(n)}">`).join("")}</datalist>`}
  $("#setBody").innerHTML=h;
  const vq=$("#vq"); if(vq) vq.oninput=()=>document.querySelectorAll("#vrows tr").forEach(r=>r.hidden=!r.dataset.v.includes(vq.value.trim()));
}
// "נקודות מעבר מאושרות": written to the table directly (not a draft). An editor proposes; only a platform admin approves
// (enforced in the DB, private.guard_via_link). Only approved links are used for routing.
const llTxt=(la,lo)=>`${(+la).toFixed(6)}, ${(+lo).toFixed(6)}`;
function viaTab(ro){
  let h=`<p class="hint">קטע כביש שמותר לאוטובוסים ולא לרכב פרטי (מחסום, כניסה לתחבורה ציבורית בלבד). המסלול מחושב עד נקודת הכניסה, דרך הקטע, ומנקודת היציאה, ונבחר רק אם הוא קצר יותר בלי פרסה. רק קטע <b>מאושר</b> משפיע על החישוב. עורך יכול להציע; רק מנהל מערכת מאשר.</p>
    <table class="ed"><thead><tr><th>שם</th><th>כניסה</th><th>יציאה</th><th>אורך הקטע</th><th>כיוון</th><th>הערה</th><th>סטטוס</th><th></th></tr></thead><tbody>`+
    VIAL.map(x=>`<tr><td>${esc(x.name)}</td><td dir="ltr">${esc(llTxt(x.a_lat,x.a_lon))}</td><td dir="ltr">${esc(llTxt(x.b_lat,x.b_lon))}</td><td>${nf(+x.link_km)} ק״מ</td>
      <td>${x.both_ways?"שני הכיוונים":"כניסה ← יציאה"}</td><td>${esc(x.note||"")}</td>
      <td>${x.approved_at?`<span class="msg ok">מאושר</span><span class="sub muted" style="display:block">${esc(x.approved_name||"")} · ${esc(String(x.approved_at).slice(0,10).split("-").reverse().join("."))}</span>`:`<span class="msg err">ממתין לאישור</span>`}</td>
      <td><button class="btn small" data-vmap="${esc(x.id)}">מפה</button> ${PLATFORM&&!x.approved_at?`<button class="btn small" data-vapprove="${esc(x.id)}">אישור</button>`:""}${!ro&&(!x.approved_at||PLATFORM)?`<button class="btn small danger" data-vdel="${esc(x.id)}">מחיקה</button>`:""}</td></tr>`).join("")+
    `</tbody></table>${VIAL.length?"":`<p class="muted">עוד לא הוגדר כלום.</p>`}`;
  if(!ro) h+=`<fieldset class="viaadd"><legend>הצעת קטע חדש</legend>
    <div class="field"><label for="vaName">שם</label><input id="vaName" maxlength="80"></div>
    <div class="field"><label for="vaA">נקודת כניסה (קו רוחב, קו אורך)</label><input id="vaA" dir="ltr" placeholder="31.871098, 35.134394"></div>
    <div class="field"><label for="vaB">נקודת יציאה (קו רוחב, קו אורך)</label><input id="vaB" dir="ltr" placeholder="31.865956, 35.140284"></div>
    <div class="field"><label for="vaKm">אורך הקטע בק״מ (ריק = לפי קו אווירי × 1.2)</label><input id="vaKm" class="num" inputmode="decimal" dir="ltr"></div>
    <label class="acck"><input type="checkbox" id="vaBoth"> מותר בשני הכיוונים</label>
    <div class="field"><label for="vaNote">הערה</label><input id="vaNote" maxlength="300"></div>
    <button class="btn small" id="vaAdd">הצעה</button></fieldset>`;
  return h}
// map of one link: an affected pair of the day (the one with the most empty legs; first the pairs whose cached route
// already uses the link) drawn twice: "המצב הקיים" (route without the link) and "המצב המאושר" (through the link, along
// via_links.geom). The km of both come from the same route check as the dashboard (assets/route.js).
const linkObj=x=>({id:x.id,name:x.name,a:[+x.a_lat,+x.a_lon],b:[+x.b_lat,+x.b_lon],km:+x.link_km,both:!!x.both_ways,line:Array.isArray(x.geom)&&x.geom.length>1?x.geom:null});
// pairs of the day near the link; est = km saved by the link by a rough estimate (straight lines x1.3 to the entry and
// from the exit), uses = the cached route already goes through it
function viaPairs(lk){const g=new Map();if(!D) return [];
  for(const v of D.vehicles) for(const i of v.items){if(i.kind!=="empty"||i.overlap||!i.a||!i.b||i.km==null) continue;
    const [A,B]=subPair(i.a,i.b);if(!ROUTE.relevantLinks(A,B,[lk]).length) continue;
    const k=pk(A)+">"+pk(B);let x=g.get(k);
    if(!x){const r=roadGet(A,B),uses=!!(r&&r.meta&&r.meta.via&&r.meta.via.id===lk.id);
      const est=Math.max(...(lk.both?[[lk.a,lk.b],[lk.b,lk.a]]:[[lk.a,lk.b]]).map(([E,X])=>i.km-(1.3*hav(A,E)+lk.km+1.3*hav(X,B))));
      x={A,B,frm:i.frm,to:i.to,km:i.km,n:0,uses,est,row:r};g.set(k,x)}x.n++}
  return [...g.values()].filter(p=>p.uses||p.est>0.5).sort((p,q)=>(q.uses-p.uses)||q.n-p.n||q.est-p.est)}
async function viaMap(id){const x=VIAL.find(v=>v.id===id);if(!x) return;const lk=linkObj(x),ps=viaPairs(lk);
  const back=()=>{$("#dlgSet").showModal();showTab("via_links")};
  $("#dlgSet").close();
  const ln=lk.line||[lk.a,lk.b],st=x.approved_at?"מאושר":"ממתין לאישור",nl=ps.reduce((s,p)=>s+p.n,0),nu=ps.filter(p=>p.uses);
  const cnt=!ps.length?`<div class="sub">אין כרגע נסיעות שעוברות כאן (${esc(dl(D.day))})</div>`
    :`<div class="sub">${esc(dl(D.day))}: ${nf(nl)} נסיעות ריקות ב־${nf(ps.length)} צמדים צפויות לעבור דרך הקטע${nu.length?` (${nf(nu.reduce((s,p)=>s+p.n,0))} מהן ב־${nf(nu.length)} צמדים כבר מחושבות דרכו)`:", לפי הערכה"+(x.approved_at?"":". החישוב המדויק אחרי האישור")}</div>`;
  const head=`<div class="mapkv"><span>קטע <b>${kmTxt(lk.km)}</b> ק״מ</span><span>${lk.both?"שני הכיוונים":"כניסה ← יציאה"}</span></div>${cnt}`;
  const c=await YMAP.open({title:`${x.name} · ${st}`,info:head,fit:[...ln],back});if(!c) return;
  const drawLink=(E,X,l)=>{c.line(l,{color:"#8E44AD",weight:7,label:"הקטע לתחבורה ציבורית"}).point(E,{label:"כניסה לקטע",fill:"#8E44AD",r:5}).point(X,{label:"יציאה מהקטע",fill:"#8E44AD",r:5})};
  if(!ps.length){drawLink(lk.a,lk.b,ln);c.fit(ln);c.status("אין כרגע נסיעות שעוברות כאן");return}
  // the first of the top pairs that really goes through the link (cached, else the same route check as the dashboard)
  let p=null,after=null,km0=null;
  for(const q of ps.slice(0,4)){if(!c.open) return;c.status(`מחשב את המסלול של ${q.frm} ← ${q.to}…`);
    if(q.uses){p=q;after={km:+q.row.km,via:q.row.meta.via};km0=q.row.meta.via.km0;break}
    try{const r=await RT.smartLinks(q.A,q.B,[lk]);if(r&&r.via&&r.via.id===lk.id){p=q;after=r;km0=r.via.km0;break}}catch{}}
  if(!c.open) return;
  if(!p){drawLink(lk.a,lk.b,ln);c.fit(ln);c.info(head+`<div class="sub">בצמדים שנבדקו הקטע לא מקצר את המסלול</div>`);c.status("");return}
  c.point(p.A,{label:"מוצא: "+(p.frm||""),fill:"#2E9E5B"}).point(p.B,{label:"יעד: "+(p.to||""),fill:"#C0392B"});
  try{const [E,X,l]=linkDir(lk,after.via,p.A,p.B);
    const [g0,g1,g2]=await Promise.all([YMAP.osrmLine(p.A,p.B),YMAP.osrmLine(p.A,E),YMAP.osrmLine(X,p.B)]);
    c.line(g0,{color:"#C0392B",weight:5,dash:true,label:`המצב הקיים (בלי הקטע): ${kmTxt(km0)} ק״מ`})
     .line(g1,{color:"#1F5FBF",weight:5,label:`המצב המאושר (דרך הקטע): ${kmTxt(after.km)} ק״מ`}).line(g2,{color:"#1F5FBF",weight:5});
    drawLink(E,X,l);
    c.info(head+`<div class="sub"><b>${esc(p.frm)} ← ${esc(p.to)}</b> (${nf(p.n)} נסיעות): ${kmTxt(km0)} ק״מ בלי הקטע, ${kmTxt(after.km)} ק״מ דרכו</div>`);
    c.fit([...g0,...g1,...g2,...l]);c.status("")}
  catch{c.status("לא ניתן לטעון את המסלול מהשרת",true);drawLink(lk.a,lk.b,ln)}}
async function viaChanged(msg){await loadVia();EDC.k="";showTab("via_links");render();ensureRoad();if(msg){$("#setMsg").className="msg ok";$("#setMsg").textContent=msg}}
$("#setBody").addEventListener("click",async e=>{const t=e.target,M=$("#setMsg");
  try{
    if(t.dataset.vmap){viaMap(t.dataset.vmap);return}
    if(t.dataset.vapprove){if(!confirm("לאשר את הקטע? מרגע האישור הוא משמש לחישוב המרחקים של כל המשתמשים.")) return;
      await sb(`/rest/v1/via_links?id=eq.${encodeURIComponent(t.dataset.vapprove)}&${opq()}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({approved_at:new Date().toISOString()})});
      await viaChanged("הקטע אושר")}
    else if(t.dataset.vdel){if(!confirm("למחוק את הקטע?")) return;
      await delRows("via_links",`id=eq.${encodeURIComponent(t.dataset.vdel)}&${opq()}`);await viaChanged("הקטע נמחק")}
    else if(t.id==="vaAdd"){const A=parseLoc($("#vaA").value),B=parseLoc($("#vaB").value),name=$("#vaName").value.trim();
      if(!name||!A||!B){M.className="msg err";M.textContent="צריך שם, נקודת כניסה ונקודת יציאה (קו רוחב, קו אורך)";return}
      const km=parseFloat($("#vaKm").value)||+(hav([+A[0],+A[1]],[+B[0],+B[1]])*1.2).toFixed(3);
      if(!(km>0&&km<=20)){M.className="msg err";M.textContent="אורך הקטע לא תקין";return}
      await sb("/rest/v1/via_links",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({operator_id:OP.id,name,a_lat:+A[0],a_lon:+A[1],b_lat:+B[0],b_lon:+B[1],link_km:km,both_ways:$("#vaBoth").checked,note:$("#vaNote").value.trim()||null})});
      await viaChanged("ההצעה נשמרה. היא תשמש לחישוב אחרי אישור מנהל מערכת")}
  }catch(err){M.className="msg err";M.textContent="הפעולה נכשלה: "+errText(err)}});
document.querySelectorAll("#sysTabs button").forEach(b=>b.onclick=()=>{$("#setMsg").textContent="";look=null;showTab(b.dataset.tab)});
$("#setBody").addEventListener("input",e=>{
  const el=e.target;
  if(el.dataset.i!=null){const r=draft[tab][+el.dataset.i],k=el.dataset.k;
    if(k==="lat"&&/^\s*-?\d+(\.\d+)?\s*[,\s]\s*-?\d+(\.\d+)?\s*$/.test(el.value)){const [a,b]=el.value.split(/[,\s]+/).filter(Boolean);r.lat=a;r.lon=b;showTab(tab);return}
    r[k]=el.value}
  else if(el.dataset.def){draft.defaults[el.dataset.def]={...(draft.defaults[el.dataset.def]||{}),[el.dataset.c]:el.value||null}}
  else if(el.dataset.defn){const x=parseFloat(el.value);draft.defaults[el.dataset.defn]=isFinite(x)&&x>=0?x:null}
  else if(el.dataset.defl){draft.defaults[el.dataset.defl]=el.value.split(",").map(x=>x.trim()).filter(Boolean)}
  else if(el.dataset.vb){const v=el.closest("tr").dataset.v,x=draft.vehicles[v]={...(draft.vehicles[v]||{})};
    if(el.value==="__auto"){delete x.branch;delete x.branch_confirmed} else {x.branch=el.value;x.branch_confirmed=true}
    if(!Object.keys(x).length) delete draft.vehicles[v]}
  else if(el.dataset.vk){const v=el.closest("tr").dataset.v,x=draft.vehicles[v]={...(draft.vehicles[v]||{})};if(el.type==="checkbox"){if(el.checked) x[el.dataset.vk]=true; else delete x[el.dataset.vk]} else if(el.value) x[el.dataset.vk]=el.value; else delete x[el.dataset.vk];if(!Object.keys(x).length) delete draft.vehicles[v]}
});
$("#setBody").addEventListener("click",async e=>{
  if(e.target.dataset.find!=null){const i=+e.target.dataset.find,r=draft[tab][i],q=(r.addr||"").trim();if(!q) return;
    const c=parseLoc(q); if(c){r.lat=c[0];r.lon=c[1];look={i,html:`<span class="msg ok">נמצא מיקום מהקישור</span>`};showTab(tab);return}
    if(/goo\.gl|waze\.com\/ul\/h/i.test(q)){look={i,html:`<span class="msg err">קישור מקוצר לא נתמך. פתח אותו בדפדפן והעתק את הכתובת המלאה מסרגל הכתובות.</span>`};showTab(tab);return}
    look={i,html:"מחפש…"};showTab(tab);
    try{const u="https://nominatim.openstreetmap.org/search?"+new URLSearchParams({q,format:"jsonv2",countrycodes:"il",limit:"5","accept-language":"he"});
      const res=await (await fetch(u)).json(); LOOKRES=res;
      look={i,html:res.length?res.map((x,j)=>`<button class="btn small" data-pick="${j}" style="display:block;margin:3px 0;text-align:right;white-space:normal">${esc(x.display_name)}</button>`).join(""):`<span class="msg err">לא נמצא. נסה כתובת עם רחוב ועיר, או הדבק קישור.</span>`}}
    catch(err){look={i,html:`<span class="msg err">החיפוש לא זמין כרגע. אפשר להדביק קישור או מספרים.</span>`}}
    showTab(tab);return}
  if(e.target.dataset.pick!=null&&look){const x=LOOKRES[+e.target.dataset.pick],r=draft[tab][look.i];r.lat=(+x.lat).toFixed(6);r.lon=(+x.lon).toFixed(6);look={i:look.i,html:`<span class="msg ok">נבחר: ${esc(x.display_name)}</span>`};showTab(tab);return}
  if(e.target.id==="brAll"){let n=0;
    for(const v of D.vehicles){const x=draft.vehicles[v.veh]||{},ab=autoBranch(v);if(!x.branch_confirmed&&ab){draft.vehicles[v.veh]={...x,branch:ab,branch_confirmed:true};n++}}
    if(!n){$("#setMsg").className="msg";$("#setMsg").textContent="אין שיוכים אוטומטיים לאישור";return}
    showTab(tab);applySettings();return}
  if(e.target.id==="addRow"){(draft[tab]=draft[tab]||[]).push({id:uid()});showTab(tab)}
  if(e.target.dataset.del!=null){draft[tab].splice(+e.target.dataset.del,1);showTab(tab)}
});
// the dialog edits a copy; "החלה" (and closing) turns it into drafts: the screen updates, nothing is written until "שמירה"
function applySettings(){
  const msg=$("#setMsg"); if(!canEdit()) return true;
  const out={};
  for(const key of [...Object.keys(LISTS),"defaults"]){let val=clone(draft[key]);
    if(LISTS[key]){val=(val||[]).map(r=>({...r,id:r.id||uid(),lat:r.lat===""||r.lat==null?null:r.lat,lon:r.lon===""||r.lon==null?null:r.lon})).filter(r=>(r.name||"").trim());
      for(const r of val) if((r.lat!=null&&!isFinite(parseFloat(r.lat)))||(r.lon!=null&&!isFinite(parseFloat(r.lon)))){msg.className="msg err";msg.textContent=`מיקום לא תקין ב"${r.name}"`;return false}}
    out[key]=val}
  for(const [key,val] of Object.entries(out)) if(!same(val,eff().S[key])||key in DRAFT.settings) setDraft("settings",key,val);
  const vs=new Set([...Object.keys(draft.vehicles||{}),...Object.keys(eff().S.vehicles||{})]);
  for(const veh of vs){const want=(draft.vehicles||{})[veh]||null;if(!same(want,eff().S.vehicles[veh]??null)){if(same(want,S.vehicles?.[veh]??null)) delete DRAFT.veh[veh]; else DRAFT.veh[veh]=want;touched()}}
  render();ensureRoad();msg.className="msg ok";msg.textContent=nDraft()?`עודכן בתצוגה. כדי לשמור לחצו "שמירה" (${nDraft()} שינויים)`:"אין שינויים";return true}
$("#setSave").onclick=applySettings;
$("#setClose").onclick=()=>{if(applySettings()) $("#dlgSet").close()};
$("#bSettings").onclick=openSettings;

// ---- wiring ----
$("#gantt").addEventListener("click",async e=>{const r=e.target.closest(".row");if(r&&(await selectVehicle(r.dataset.v))) openVehDlg(r)});
$("#gantt").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){const r=e.target.closest(".row");if(r){e.preventDefault();r.click()}}});
// a full vehicle number in the search box selects that vehicle (also kept when the day changes)
const knownVeh=q=>/^\d{4,}$/.test(q)&&(D&&D.vehicles.some(v=>v.veh===q)||Object.values(ENDS).some(d=>d[q]));
$("#q").oninput=async()=>{const q=$("#q").value.trim();if(knownVeh(q)&&q!==sel&&!(await selectVehicle(q))) return;
  if(lineQ(q)) openFind(q,false); render()}; $("#sort").onchange=render; $("#br").onchange=render; $("#acc").onchange=render; $("#day").onchange=e=>loadDay(e.target.value);
// a phone keyboard changes only the height: re-render only when the width changes (a re-render would drop the focused field)
let _rw=innerWidth;addEventListener("resize",()=>{if(innerWidth===_rw) return;_rw=innerWidth;clearTimeout(window._rt);window._rt=setTimeout(render,150)});
$("#q").addEventListener("keydown",async e=>{if(e.key!=="Enter") return;const q=$("#q").value.trim();if(knownVeh(q)&&(await selectVehicle(q))) openVehDlg()});
$("#bToday").onclick=()=>loadDay(today); $("#bYest").onclick=()=>loadDay(yest);
const QP=new URLSearchParams(location.search);
// ---- control room (חדר בקרה): platform admin = all users; operator admin = users of his operators. Server: manage_users ----
const ROLEHINT="צופה: רואה הכול. עורך: גם משנה הגדרות, תגבורים ומעברי לילה. מנהל: גם מנהל את המשתמשים של המפעיל. מנהל מערכת: הכול, בכל המפעילים, כולל משתמשים ומנהלי מערכת אחרים.";
const USERRE=/^[a-z0-9._-]{3,32}$/;
const roleSel=(cur,attrs="")=>`<select ${attrs}>${["viewer","editor",...(PLATFORM||cur==="admin"?["admin"]:[])].map(r=>`<option value="${r}" ${r===cur?"selected":""}>${ROLEHE[r]}</option>`).join("")}</select>`;
const fnCall=async(body,auth=true)=>http(SB+"/functions/v1/manage_users",{method:"POST",
  headers:{apikey:KEY,"Content-Type":"application/json",...(auth?{Authorization:"Bearer "+await token()}:{})},body:JSON.stringify(body)},30000);
const adminOps=()=>OPS.filter(o=>PLATFORM||MS.some(m=>m.operator_id===o.id&&m.role==="admin"));
const opName=id=>(OPS.find(o=>o.id===id)||{}).name||"מפעיל אחר";
function suggestPw(){const a="abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";for(;;){const r=crypto.getRandomValues(new Uint32Array(12)),pw=[...r].map(x=>a[x%a.length]).join("");if(!weakPw(pw)) return pw}}
// the control room (users and permissions) moved to the yalla-sa portal control panel: #bCtl links there (platform rule)

// ---- trip search: "who ran line L, direction X, at about HH:MM?" over the day as shown (block edits + drafts included) ----
let HL=null, LINEF=null; // HL = highlighted trip {veh, sched}; LINEF = {line, dir} filter of the timeline
const dayLines=()=>{const set=new Set();if(D) for(const v of D.vehicles) for(const i of v.items) if(i.kind==="trip"&&i.line&&i.line!=="?") set.add(String(i.line));
  return [...set].sort((a,b)=>a.localeCompare(b,"he",{numeric:true}))};
// a line number in the search box (short, and a line that ran that day) means "find a trip", not "filter vehicles"
const lineQ=q=>!!q&&q.length<=4&&!!D&&dayLines().includes(q);
// directions of a line: the day's routes catalog; a trip belongs to the direction whose ends are nearest to its own
const dirsOf=line=>(D.routes||[]).filter(r=>String(r.line)===String(line));
function dirOfTrip(t,dirs){let best=-1,bd=1e9;dirs.forEach((r,k)=>{if(!t.a||!t.b) return;const d=2*hav(t.a,r.o)+hav(t.b,r.d);if(d<bd){bd=d;best=k}});return best}
function lineOk(v){if(!LINEF) return true;const dirs=dirsOf(LINEF.line);
  return v.items.some(i=>i.kind==="trip"&&String(i.line)===LINEF.line&&(LINEF.dir<0||dirOfTrip(i,dirs)===LINEF.dir))}
function drawLineF(){const b=$("#bLineF");b.hidden=!LINEF;if(LINEF){const r=dirsOf(LINEF.line)[LINEF.dir];b.textContent=`קו ${LINEF.line}${r?` · ${r.frm.split(",")[0]} ←`:""} ✕`}}
$("#bLineF").onclick=()=>{LINEF=null;$("#fdOnly").checked=false;drawLineF();render()};
// the search works on one day: shown (and changed) at the top of the search, also on the phone
const WDAY=["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
const fdDayTxt=d=>`יום ${WDAY[new Date(d+"T12:00:00").getDay()]} ${d.split("-").reverse().join(".")}${d===today?" (היום)":d===yest?" (אתמול)":""}`;
$("#fdDay").onchange=e=>loadDay(e.target.value);
function openFind(line,focus){const d=$("#dlgFind");if(D) $("#fdDay").value=D.day;
  $("#fdLines").innerHTML=dayLines().map(l=>`<option value="${esc(l)}">`).join("");
  if(line!=null&&$("#fdLine").value!==line){$("#fdLine").value=line;fillDirs()}
  if(!d.open) d.show(); drawFind(); if(focus) ($("#fdLine").value?$("#fdTime"):$("#fdLine")).focus()}
function fillDirs(){const ds=dirsOf($("#fdLine").value.trim());
  $("#fdDir").innerHTML=`<option value="-1">כל הכיוונים</option>`+ds.map((r,k)=>`<option value="${k}">${esc(r.frm)} ← ${esc(r.to)}</option>`).join("")}
function drawFind(){const line=$("#fdLine").value.trim(),dir=+$("#fdDir").value,t=tParse($("#fdTime").value),win=+$("#fdWin").value;
  const box=$("#fdRes"),sum=$("#fdSum");
  if($("#fdOnly").checked&&line){LINEF={line,dir};} else if(!$("#fdOnly").checked) LINEF=null; drawLineF();
  if(!D||!line){box.innerHTML="";sum.textContent="מקלידים מספר קו, ואפשר לבחור כיוון ושעה.";return}
  const dirs=dirsOf(line),out=[];
  for(const v of D.vehicles) for(const i of v.items){
    if(i.kind!=="trip"||String(i.line)!==line) continue;
    if(dir>=0&&dirOfTrip(i,dirs)!==dir) continue;
    const dt=t==null?0:Math.min(Math.abs(i.start-t),Math.abs((i.sched??i.start)-t));
    if(t!=null&&dt>win) continue;
    out.push({v,i,dt})}
  out.sort((x,y)=>x.dt-y.dt||x.i.start-y.i.start);
  sum.textContent=out.length?`${out.length===1?"נסיעה אחת":out.length+" נסיעות"}${t!=null?` סביב ${fmt(t)}`:" ביום"} · לחיצה בוחרת את הרכב ומסמנת את הנסיעה`:`לא נמצאה נסיעה של קו ${line}${t!=null?` סביב ${fmt(t)}`:""}${dir>=0?" בכיוון הזה":""}.`;
  box.innerHTML=out.slice(0,200).map(({v,i})=>{const fl=[i.auto?(autoSt(v,i)==="rejected"?"":"תגבור אוטומטי"):"",i.edited?"✎ נערך ידנית":"",i.incomplete?"לא הושלמה לפי GPS":"",i.no_gps?"בלי GPS":"",i.late_login?"נרשם באיחור":"",i.asm?"* לפי הנחה":""].filter(Boolean);
    return `<button type="button" class="fdrow" role="listitem" data-v="${esc(v.veh)}" data-s="${i.sched}"><span class="t">${fmt(i.start)}–${fmt(i.end)}${i.sched!=null&&Math.abs(i.sched-i.start)>=2?`<span class="muted" style="display:block;font-weight:400;font-size:11px">בלוח ${fmt(i.sched)}</span>`:""}</span><b>${esc(i.line)}</b><span>${esc(i.frm)} ← ${esc(i.to)}</span><span dir="ltr" style="text-align:right">${esc(v.veh)}${accIcon(v.veh)}</span><span class="fl">${fl.map(f=>`<span class="badge">${f}</span>`).join("")}</span></button>`}).join("");
  render()}
["fdTime","fdWin","fdDir","fdOnly"].forEach(id=>$("#"+id).addEventListener(id==="fdTime"?"input":"change",drawFind));
$("#fdLine").addEventListener("input",()=>{fillDirs();drawFind()});
$("#bFind").onclick=()=>openFind(lineQ($("#q").value.trim())?$("#q").value.trim():null,true);
$("#fdClose").onclick=()=>$("#dlgFind").close();
$("#dlgFind").addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();$("#dlgFind").close();$("#bFind").focus()}});
$("#fdRes").addEventListener("click",async e=>{const b=e.target.closest(".fdrow");if(!b) return;const veh=b.dataset.v,sc=+b.dataset.s;
  if(!(await selectVehicle(veh))) return; HL={veh,sched:sc}; render();
  document.querySelector(`.row[data-v="${CSS.escape(veh)}"]`)?.scrollIntoView({block:"center"});
  document.querySelector(`.row[data-v="${CSS.escape(veh)}"] .bar.hl`)?.scrollIntoView({block:"nearest",inline:"center"});openVehDlg()});

// ---- compact layout: summary popovers, collapsible top area, density (per user, in this browser) ----
document.querySelectorAll(".card[tabindex]").forEach(c=>{c.addEventListener("click",()=>{const o=!c.classList.contains("open");document.querySelectorAll(".card.open").forEach(x=>x.classList.remove("open"));c.classList.toggle("open",o)});
  c.addEventListener("keydown",e=>{if(e.key==="Escape"){c.classList.remove("open");c.blur()}else if(e.key==="Enter"||e.key===" "){e.preventDefault();c.click()}})});
document.addEventListener("click",e=>{if(!e.target.closest(".card")) document.querySelectorAll(".card.open").forEach(x=>x.classList.remove("open"))});
const prefKey=k=>`ys_${k}_${(PROFILE&&PROFILE.username)||lsGet("ys_user")||""}`;
function setTopMin(min,save){document.body.classList.toggle("topmin",min);const b=$("#bCollapse");b.setAttribute("aria-expanded",String(!min));
  b.title=min?"הרחבת החלק העליון":"כיווץ החלק העליון";b.setAttribute("aria-label",b.title);if(save) lsSet(prefKey("topmin"),min?"1":"0");setTimeout(render,0)}
$("#bCollapse").onclick=()=>setTopMin(!document.body.classList.contains("topmin"),true);
// density: explicit choice of the user, else automatic by window height (<= 960 px = dense)
function applyDense(){const pref=lsGet(prefKey("dense")),on=pref==null?innerHeight<=960:pref==="1";
  document.body.classList.toggle("dense",on);$("#bDense").setAttribute("aria-checked",String(on));$("#bDense").textContent=`תצוגה צפופה${pref==null?" (אוטומטי)":""}`}
$("#bDense").onclick=()=>{lsSet(prefKey("dense"),document.body.classList.contains("dense")?"0":"1");applyDense();render()};
addEventListener("resize",()=>{if(lsGet(prefKey("dense"))==null) applyDense()});

// ---- my account (user menu): change password; platform admins: recovery email + one-time recovery codes ----
const meMenu=$("#meMenu"), whoBtn=$("#who");
const menuOpen=o=>{meMenu.hidden=!o;whoBtn.setAttribute("aria-expanded",String(o));if(o) meMenu.querySelector("button:not([hidden])").focus()};
whoBtn.onclick=e=>{e.stopPropagation();menuOpen(meMenu.hidden)};
document.addEventListener("click",e=>{if(!meMenu.hidden&&!meMenu.contains(e.target)) menuOpen(false)});
meMenu.addEventListener("keydown",e=>{if(e.key==="Escape"){menuOpen(false);whoBtn.focus()}});
const mmsg=(t,cls="")=>{const m=$("#meMsg");if(m){m.className="msg "+cls;m.textContent=t}};
const pwFld=(id,label,ac)=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="password" autocomplete="${ac}" dir="ltr" style="max-width:280px"></div>`;
function meDraw(view,data={}){const b=$("#meBody");
  if(view==="mfa"){$("#meTitle").textContent="אימות דו־שלבי";
    if(data.enroll){b.innerHTML=`<p>סרוק את הקוד באפליקציית אימות בטלפון (Google Authenticator, Microsoft Authenticator וכדומה), והקלד את הקוד בן 6 הספרות שהיא מציגה.</p>${mfaBox(data.enroll)}
      <form id="meMfaForm" class="inv"><div class="field"><label for="meOtp">קוד מהאפליקציה</label><input id="meOtp" dir="ltr" inputmode="numeric" autocomplete="one-time-code" maxlength="7" style="width:120px"></div>
      <button class="btn primary">הפעלה</button></form><span class="msg" id="meMsg" aria-live="polite"></span>`;return}
    b.innerHTML=data.on?`<p><b>פעיל.</b> בכל כניסה, אחרי הסיסמה, מקלידים קוד מאפליקציית האימות.</p>
      ${isAdminAny()?'<p class="hint">למנהלים זו חובה: אם תסיר, תתבקש להפעיל מחדש בכניסה הבאה.</p>':""}
      <button class="btn small danger" id="meMfaOff">הסרת האימות הדו־שלבי</button> <span class="msg" id="meMsg" aria-live="polite"></span>`
      :`<p>לא פעיל. עם אימות דו־שלבי, מי שגילה את הסיסמה שלך עדיין לא יכול להיכנס בלי הטלפון שלך.</p>
      <button class="btn small primary" id="meMfaOn">הפעלה</button> <span class="msg" id="meMsg" aria-live="polite"></span>`;return}
  if(view==="pw"){$("#meTitle").textContent="שינוי סיסמה";
    b.innerHTML=`<form id="mePwForm" autocomplete="on"><input type="text" autocomplete="username" value="${esc(PROFILE?.username||"")}" hidden>
      ${pwFld("mePw0","הסיסמה הנוכחית","current-password")}${pwFld("mePw1","סיסמה חדשה (לפחות 8 תווים, עם אותיות ומספרים)","new-password")}${pwFld("mePw2","אימות הסיסמה החדשה","new-password")}
      <button class="btn primary">שמירת הסיסמה</button> <span class="msg" id="meMsg" aria-live="polite"></span></form>`;return}
  $("#meTitle").textContent="שחזור חשבון";
  if(data.codes){b.innerHTML=`<p><b>קודי השחזור החדשים שלך.</b> הם מוצגים עכשיו פעם אחת בלבד. שמור אותם במקום בטוח (הדפסה או קובץ), לא באותו מחשב שבו אתה נכנס. כל קוד עובד פעם אחת. הקודים הקודמים כבר לא עובדים.</p>
      <div class="codes" id="meCodes">${data.codes.map(c=>`<span>${esc(c)}</span>`).join("")}</div>
      <button class="btn" id="meDl">הורדה כקובץ</button> <button class="btn" id="mePrint">הדפסה</button> <button class="btn primary" id="meDone">שמרתי אותם</button>`;return}
  b.innerHTML=`<p class="hint">אם תשכח את הסיסמה ואין מנהל מערכת אחר שיכול לקבוע לך סיסמה זמנית, אלה שתי הדרכים לחזור לחשבון.</p>
    <h4 style="margin-top:6px">מייל לשחזור</h4>
    <p class="hint">${data.recovery_email?`מוגדר: <b dir="ltr">${esc(data.recovery_email)}</b>. במסך הכניסה יופיע "שכחתי סיסמה" ויישלח קישור למייל הזה.`:"לא מוגדר. בלי מייל, במסך הכניסה לא יופיע \"שכחתי סיסמה\"."}</p>
    <div class="inv"><div class="field"><label for="meEm">כתובת מייל</label><input id="meEm" type="email" dir="ltr" style="width:240px" value="${esc(data.recovery_email||"")}"></div>
      <button class="btn small" id="meEmSave">שמירה</button>${data.recovery_email?`<button class="btn small danger" id="meEmDel">הסרה</button>`:""}</div>
    <h4>קודי שחזור חד־פעמיים</h4>
    <p class="hint">${data.codes_left?`נותרו ${nf(data.codes_left)} קודים שלא נוצלו.`:"עוד אין קודים."} במסך הכניסה: "אין לי גישה (קוד שחזור)", שם משתמש + קוד אחד + סיסמה חדשה. יצירה מחדש מבטלת את הקודים הקודמים.</p>
    <button class="btn small" id="meGen">${data.codes_left?"יצירת קודים חדשים":"יצירת 8 קודים"}</button>
    ${pwFld("meSecPw","הסיסמה הנוכחית שלך (נדרשת לשמירת מייל או ליצירת קודים)","current-password")}
    <span class="msg" id="meMsg" aria-live="polite"></span>`}
async function meOpen(view){menuOpen(false);
  if(view==="mfa"){$("#meBody").innerHTML='<div class="empty-state">טוען…</div>';$("#dlgMe").showModal();
    try{meDraw("mfa",{on:(await myFactors()).some(f=>f.status==="verified")})}catch(e){$("#meBody").innerHTML=`<p class="msg err">${esc(errText(e))}</p>`};return}
  if(view==="sec"){$("#meBody").innerHTML='<div class="empty-state">טוען…</div>';$("#dlgMe").showModal();
    try{meDraw("sec",await fnCall({action:"my_security"}))}catch(e){$("#meBody").innerHTML=`<p class="msg err">${esc(errText(e))}</p>`}}
  else{meDraw("pw");$("#dlgMe").showModal();$("#mePw0").focus()}}
meMenu.addEventListener("click",e=>{const v=e.target.dataset.me;if(v){menuOpen(false);location.assign("/?panel=sec")} // the code (aal2) is asked there, not here
  else if(e.target.id==="bCtl"||e.target.id==="bEdit") menuOpen(false)});
$("#meClose").onclick=()=>$("#dlgMe").close();
let MECODES=null;
$("#meBody").addEventListener("submit",async e=>{e.preventDefault();
  if(e.target.id==="meMfaForm"){mmsg("בודק…");try{await mfaVerify(MEENR.id,$("#meOtp").value);MEENR=null;meDraw("mfa",{on:true});mmsg("האימות הדו־שלבי הופעל","ok")}catch(err){mmsg(errText(err),"err")}return}
  const cur=$("#mePw0").value,pw=$("#mePw1").value;
  if(weakPw(pw)) return mmsg(ERR["Password should be"],"err"); if(pw!==$("#mePw2").value) return mmsg("הסיסמאות לא זהות","err");
  mmsg("שומר…");
  try{await fnCall({action:"change_password",current_password:cur,new_password:pw});
    try{await signIn(PROFILE?.username||lsGet("ys_user")||"",pw)}catch{} // a password change may end the old session
    mmsg("הסיסמה הוחלפה","ok");setTimeout(()=>$("#dlgMe").close(),1200)}
  catch(err){mmsg(errText(err),"err")}});
let MEENR=null;
$("#meBody").addEventListener("click",async e=>{const id=e.target.id;
  if(id==="meMfaOn"){mmsg("מכין קוד…");try{MEENR=await mfaEnroll();meDraw("mfa",{enroll:MEENR});$("#meOtp").focus()}catch(err){mmsg(errText(err),"err")}return}
  if(id==="meMfaOff"){if(!confirm("להסיר את האימות הדו־שלבי? מכאן הכניסה תהיה בסיסמה בלבד.")) return;mmsg("מסיר…");
    try{await fnCall({action:"remove_my_mfa"});try{await refresh()}catch{}meDraw("mfa",{on:false});mmsg("הוסר","ok")}catch(err){mmsg(errText(err),"err")}return}
  if(id==="meDl"&&MECODES){const t=`יאללה־סע · קודי שחזור לחשבון ${PROFILE?.username||""}\nנוצרו ${new Date().toLocaleString("he-IL")}. כל קוד עובד פעם אחת.\n\n${MECODES.join("\n")}\n`;
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([t],{type:"text/plain;charset=utf-8"}));a.download="yalla-sa-recovery-codes.txt";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);return}
  if(id==="mePrint"&&MECODES){const w=open("","_blank","width=480,height=600");if(!w) return;
    w.document.write(`<html dir="rtl" lang="he"><title>קודי שחזור</title><body style="font-family:Arial;padding:24px"><h3>יאללה־סע · קודי שחזור לחשבון ${esc(PROFILE?.username||"")}</h3><p>כל קוד עובד פעם אחת.</p><pre style="font-size:18px;direction:ltr">${MECODES.map(esc).join("\n")}</pre></body></html>`);
    w.document.close();w.focus();w.print();return}
  if(id==="meDone"){MECODES=null;meOpen("sec");return}
  if(!["meEmSave","meEmDel","meGen"].includes(id)) return;
  const pw=$("#meSecPw").value; if(!pw){mmsg("צריך להקליד את הסיסמה הנוכחית","err");$("#meSecPw").focus();return}
  mmsg("שומר…");
  try{
    if(id==="meGen"){const r=await fnCall({action:"gen_recovery_codes",current_password:pw});MECODES=r.codes;meDraw("sec",{codes:r.codes});return}
    await fnCall({action:"set_recovery_email",current_password:pw,email:id==="meEmDel"?null:$("#meEm").value.trim()});
    meDraw("sec",await fnCall({action:"my_security"}));mmsg(id==="meEmDel"?"המייל הוסר":"המייל נשמר","ok")}
  catch(err){mmsg(errText(err),"err")}});

// ---- two-step verification (TOTP, Supabase Auth MFA). A user with a verified factor gets data only from an aal2
// session (DB: private.mfa_ok). Platform admins must enrol before they get in. ----
const jwtOf=t=>{try{return JSON.parse(atob(String(t).split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch{return {}}};
const aal=()=>SES?jwtOf(SES.access_token).aal:null;
const authReq=async(method,path,body)=>http(SB+"/auth/v1/"+path,{method,headers:{apikey:KEY,"Content-Type":"application/json",Authorization:"Bearer "+await token()},...(body?{body:JSON.stringify(body)}:{})});
const myFactors=async()=>((await authReq("GET","user")).factors||[]).filter(f=>f.factor_type==="totp");
async function mfaVerify(fid,code){code=String(code||"").replace(/\D/g,"");if(code.length!==6) throw new Error("mfa_verification_failed");
  const ch=await authReq("POST",`factors/${fid}/challenge`,{});setSes(await authReq("POST",`factors/${fid}/verify`,{challenge_id:ch.id,code}))}
async function mfaEnroll(){ // a fresh factor (unfinished ones are removed first): {id, totp:{qr_code, secret}}
  for(const f of (await myFactors()).filter(f=>f.status!=="verified")) try{await authReq("DELETE",`factors/${f.id}`)}catch{}
  return authReq("POST","factors",{factor_type:"totp",friendly_name:"yalla-sa "+new Date().toISOString().slice(0,16)})}
const qrSrc=q=>String(q).startsWith("data:")?q:"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(q); // GoTrue returns raw SVG
const mfaBox=e=>`<div class="mfaqr"><img src="${esc(qrSrc(e.totp.qr_code))}" alt="קוד QR לאפליקציית האימות" width="180" height="180"></div>
  <p class="hint">אין אפשרות לסרוק? הקלד באפליקציה את המפתח: <b dir="ltr" class="mono">${esc(e.totp.secret)}</b></p>`;
let MFAF=null, ENR=null;
const isAdminAny=()=>PLATFORM||(MS||[]).some(m=>m.role==="admin"); // any admin must use two-step verification (privacy procedure §3)

// ---- entry: first platform admin (once), login, two-step code, forced password change, no access ----
async function unlock(){
  await loadAccess();
  const fs=await myFactors(), ver=fs.filter(f=>f.status==="verified");
  // step-up (David, 2026-11-18): no code at sign-in; the portal's control panel asks for it (manage_users enforces aal2).
  // A forced password change goes through manage_users, which wants the code when the account has a factor.
  if(PROFILE&&PROFILE.must_change_password){if(ver.length&&aal()!=="aal2"){MFAF=ver[0].id;gateMode("mfa");return false} gateMode("changepw");return false}
  if(!OP){gateMode("noaccess");return false}
  const k=await rpc("get_operator_key",{p_operator:OP.id}); if(!k||!k.keys||!Object.keys(k.keys).length) throw new Error("no_key");
  CKEYS={};for(const [kid,v] of Object.entries(k.keys)) CKEYS[kid]=await crypto.subtle.importKey("raw",b64(v),"AES-GCM",false,["decrypt"]);
  applyOperator(); await initDays(); await Promise.all([loadSettings(),loadRoad(),loadEnds(),loadChoices(),loadVia(),loadRok()]); drawSaveBar();
  // the day loads behind the gate while the logo intro is still playing
  if(!days.length) $("#gantt").innerHTML='<div class="empty-state">אין עדיין נתונים למפעיל הזה</div>';
  else loadDay(days.includes(QP.get("day"))?QP.get("day"):days.includes(yest)?yest:days[days.length-1],()=>{
    const v=QP.get("veh"); if(v){sel=v;render();document.querySelector(`.row[data-v="${CSS.escape(v)}"]`)?.scrollIntoView({block:"center"})}});
  await introEnd;
  logoHome(); document.body.classList.remove("locked"); $("#gate").remove();
  return true;
}
// entry screen intro: the header logo moves into the gate, plays large, then the form fades in
const LOGO=$("#logoBtn"), LOGO_HOME=[LOGO.parentNode,LOGO.nextSibling];
function logoHome(){if(LOGO.parentNode!==LOGO_HOME[0]){LOGO_HOME[0].insertBefore(LOGO,LOGO_HOME[1]);LOGO.removeAttribute("aria-hidden");LOGO.tabIndex=0}}
let introEnd=Promise.resolve(), introOver=false, AUTO=false, GMODE="login", LASTPW=null;
// the logo takes only the height left over by the form, so the form is always fully visible (laptop windows, zoom)
function fitGate(){const g=$("#gate");if(!g||!g.classList.contains("ready")) return;const f=$("#gateForm");
  const left=innerHeight-f.offsetHeight-18-32-8;g.style.setProperty("--logoH",Math.max(48,Math.min(220,left))+"px")}
addEventListener("resize",fitGate);
const showForm=()=>{const g=$("#gate");if(g&&!g.classList.contains("ready")){fitGate();g.classList.add("ready");g.querySelector("#gateFields input:not([hidden]),#gateBtn")?.focus()}};
function gateIntro(){const g=$("#gate");let done=false,res;introEnd=new Promise(r=>res=r);
  const show=()=>{if(done) return;done=true;introOver=true;clearTimeout(tm);removeEventListener("keydown",show,true);g.removeEventListener("pointerdown",show);res();if(!AUTO) showForm()};
  g.insertBefore(LOGO,g.firstChild); LOGO.setAttribute("aria-hidden","true"); LOGO.tabIndex=-1; g.classList.add("intro");
  window.playLogo(); const tm=setTimeout(show,window.LOGO_MS);
  addEventListener("keydown",show,true); g.addEventListener("pointerdown",show);}
const fld=(id,label,type,ac,extra="")=>`<div class="field" style="text-align:right;margin-top:14px"><label for="${id}">${label}</label><input id="${id}" type="${type}" autocomplete="${ac}" ${type!=="password"&&id!=="gName"?'dir="ltr"':""} required ${extra}></div>`;
const userFld=v=>fld("gUser","שם משתמש","text","username",`value="${esc(v)}" autocapitalize="off" spellcheck="false"`);
// short notice under section 11 of the Privacy Protection Law, shown at the first sign-in (draft until a lawyer approves it)
const PRIVNOTE=`<div class="gpnote"><b>פרטיות (טיוטה):</b> לצורך כניסה מאובטחת והרשאות לפי מפעיל נשמרים עליך שם משתמש, שם לתצוגה, ההרשאה, פרטי אבטחה ותיעוד כניסות ועריכות. אין חובה חוקית למסור, אבל בלי זה אין חשבון. המנהלים אצל המפעיל שלך רואים את פרטי החשבון והעריכות. האחסון אצל Supabase (גרמניה). אפשר לבקש לעיין במידע ולתקן אותו. <a href="privacy.html" target="_blank" rel="noopener">מדיניות הפרטיות</a></div>`;
function gateMode(m,{msg="",err=""}={}){
  GMODE=m; const uname=(PROFILE&&PROFILE.username)||lsGet("ys_user")||"";
  const F=$("#gateFields"),A=$("#gateAlt"),B=$("#gateBtn"),S=$("#gateSub"); B.disabled=false;
  if(m==="login"){S.textContent="כניסה עם שם משתמש וסיסמה";F.innerHTML=userFld(uname)+fld("gpw","סיסמה","password","current-password");
    B.textContent="כניסה";A.innerHTML=`<span class="muted" id="forgotBox">שכחת סיסמה? פנה למנהל המערכת.</span><button type="button" class="linkbtn dim" data-gm="code">אין לי גישה (קוד שחזור)</button>`;
    checkForgot()}
  else if(m==="code"){S.textContent="כניסה עם קוד שחזור חד־פעמי (למנהלי מערכת)";
    F.innerHTML=userFld(uname)+fld("gCode","קוד שחזור (למשל ABCDE-23456)","text","one-time-code",'autocapitalize="characters" spellcheck="false"')+
      fld("gpw","סיסמה חדשה (לפחות 8 תווים, עם אותיות ומספרים)","password","new-password",'minlength="8"')+fld("gpw2","אימות סיסמה","password","new-password",'minlength="8"');
    B.textContent="קביעת סיסמה חדשה וכניסה";A.innerHTML=`<button type="button" class="linkbtn dim" data-gm="login">חזרה לכניסה רגילה</button>`}
  else if(m==="recoverpw"){S.textContent="בחירת סיסמה חדשה (מהקישור שנשלח למייל)";
    F.innerHTML=fld("gpw","סיסמה חדשה (לפחות 8 תווים, עם אותיות ומספרים)","password","new-password",'minlength="8"')+fld("gpw2","אימות סיסמה","password","new-password",'minlength="8"');
    B.textContent="שמירת הסיסמה וכניסה";A.innerHTML=`<button type="button" class="linkbtn dim" data-gm="logout">ביטול</button>`}
  else if(m==="bootstrap"){S.textContent="יצירת חשבון מנהל ראשי (פעם אחת בלבד)";
    F.innerHTML=userFld("")+fld("gName","שם לתצוגה","text","name",'maxlength="80"')+fld("gpw","סיסמה (לפחות 8 תווים, עם אותיות ומספרים)","password","new-password",'minlength="8"')+fld("gpw2","אימות סיסמה","password","new-password",'minlength="8"');
    B.textContent="יצירת החשבון וכניסה";A.innerHTML=`<span class="muted">שם משתמש: אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון.</span>`}
  else if(m==="changepw"){S.textContent=`צריך לבחור סיסמה חדשה${uname?" לחשבון "+uname:""}`;
    F.innerHTML=`<input type="text" autocomplete="username" value="${esc(uname)}" hidden>`+(LASTPW?"":fld("gpw0","הסיסמה הנוכחית (הזמנית)","password","current-password"))+
      fld("gpw","סיסמה חדשה (לפחות 8 תווים, עם אותיות ומספרים)","password","new-password",'minlength="8"')+fld("gpw2","אימות סיסמה","password","new-password",'minlength="8"');
    F.insertAdjacentHTML("afterbegin",PRIVNOTE);
    B.textContent="שמירת הסיסמה וכניסה";A.innerHTML=`<button type="button" class="linkbtn dim" data-gm="logout">יציאה</button>`}
  else if(m==="error"){S.textContent="לא ניתן לטעון את הנתונים כרגע.";F.innerHTML="";B.textContent="נסה שוב";
    A.innerHTML=`<a class="linkbtn dim" href="${esc(PORTAL)}">חזרה ל־yalla-sa</a>`}
  else if(m==="noaccess"){S.textContent=`החשבון ${uname} עוד לא שויך לאף מפעיל. פנה למנהל המערכת.`;F.innerHTML="";B.textContent="יציאה";A.innerHTML=""}
  else if(m==="mfa"){S.textContent="אימות דו־שלבי: הקלד את הקוד שמוצג עכשיו באפליקציית האימות בטלפון";
    F.innerHTML=fld("gOtp","קוד בן 6 ספרות","text","one-time-code",'inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7"');
    B.textContent="אישור";A.innerHTML=`<span class="muted">הטלפון לא איתך? מנהל מערכת יכול לאפס לך את האימות, או כניסה עם קוד שחזור.</span><button type="button" class="linkbtn dim" data-gm="code">קוד שחזור</button><button type="button" class="linkbtn dim" data-gm="logout">יציאה</button>`}
  else if(m==="mfa_enroll"){S.textContent="מנהל חייב אימות דו־שלבי. סרוק את הקוד באפליקציית אימות (Google Authenticator, Microsoft Authenticator וכדומה) והקלד את הקוד שהיא מציגה.";
    F.innerHTML=`<div id="gQr" class="empty-state">מכין קוד…</div>`+fld("gOtp","קוד בן 6 ספרות מהאפליקציה","text","one-time-code",'inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7"');
    B.textContent="הפעלה וכניסה";A.innerHTML=`<button type="button" class="linkbtn dim" data-gm="logout">יציאה</button>`;
    ENR=null;mfaEnroll().then(e=>{ENR=e;const q=$("#gQr");if(q){q.className="";q.innerHTML=mfaBox(e);fitGate()}}).catch(e=>{const q=$("#gQr");if(q) q.textContent=errText(e)})}
  const gm=$("#gateMsg"); gm.className="msg"+(err?" err":msg?" ok":""); gm.textContent=err||msg; $("#gateWarn").textContent=""; fitGate();
  if(introOver) {showForm();(F.querySelector("input:not([hidden])")||B).focus()}
}
const signOut=async()=>{try{await authPost("logout",{},SES&&SES.access_token)}catch{} setSes(null);lsSet(TRUST,null);LASTPW=null};
// username: trimmed + lower-case. An account with a recovery email has a real Auth email: manage_users signs it in.
const signIn=async(user,pw)=>{user=String(user||"").trim().toLowerCase();
  try{setSes(await authPost("token?grant_type=password",{email:user+"@"+DOMAIN,password:pw}))}
  catch(e){if(!/invalid_credentials|Invalid login/i.test(e.message)) throw e;
    let r=null;try{r=await fnCall({action:"sign_in",username:user,password:pw},false)}catch(e2){if(/rate limit/i.test(e2.message)) throw e2}
    if(!r||!r.session) throw e; setSes(r.session)}
  lsSet("ys_user",user);touchAct();PROFILE=null};
// "שכחתי סיסמה" only for an account that has a recovery email (asked when the username is typed)
let forgotFor="";
async function checkForgot(){const u=($("#gUser")?.value||"").trim().toLowerCase(),box=$("#forgotBox");if(!box||!/^[a-z0-9._-]{3,32}$/.test(u)||u===forgotFor) return;forgotFor=u;
  try{const r=await fnCall({action:"recovery_options",username:u},false);if($("#gUser")?.value.trim().toLowerCase()!==u) return;
    box.innerHTML=r.email?`<button type="button" class="linkbtn" data-gm="forgot">שכחתי סיסמה</button>`:"שכחת סיסמה? פנה למנהל המערכת."}catch{}}
$("#gateForm").addEventListener("focusout",e=>{if(e.target.id==="gUser"){e.target.value=e.target.value.trim().toLowerCase();if(GMODE==="login") checkForgot()}});
// keyboard warnings: Hebrew layout (the password is typed in Hebrew letters) or Caps Lock
let CAPS=false;
const kbWarn=()=>{const heb=[...document.querySelectorAll("#gateFields input")].some(i=>i.id!=="gName"&&/[\u0590-\u05FF]/.test(i.value));
  $("#gateWarn").textContent=heb?"שים לב: יש אותיות בעברית. כנראה המקלדת בעברית: עבור לאנגלית (Alt+Shift) והקלד שוב.":CAPS?"שים לב: Caps Lock פועל (אותיות גדולות).":""};
$("#gateForm").addEventListener("keydown",e=>{if(!(e.target instanceof HTMLInputElement)||e.target.id==="gName") return;
  if(e.getModifierState) CAPS=e.getModifierState("CapsLock");
  if(/[\u0590-\u05FF]/.test(e.key||"")){$("#gateWarn").textContent="שים לב: המקלדת בעברית. עבור לאנגלית (Alt+Shift) לפני הקלדת שם המשתמש והסיסמה.";return}
  kbWarn()});
$("#gateForm").addEventListener("input",kbWarn);
$("#gateAlt").addEventListener("click",async e=>{const m=e.target.dataset.gm;
  if(m==="logout"){await signOut();toPortal()}
  else if(m==="login") toPortal();
  else if(m==="code") gateMode(m);
  else if(m==="forgot"){const u=$("#gUser").value.trim().toLowerCase(),g=$("#gateMsg");g.className="msg";g.textContent="שולח…";
    try{await fnCall({action:"forgot",username:u},false);g.className="msg ok";g.textContent="אם לחשבון מוגדר מייל לשחזור, נשלח אליו עכשיו קישור לבחירת סיסמה חדשה. בדוק גם בדואר זבל."}
    catch(err){g.className="msg err";g.textContent=errText(err)}}});
$("#gateForm").addEventListener("submit",async e=>{
  e.preventDefault(); const m=$("#gateMsg"); m.className="msg"; m.textContent="רגע…"; $("#gateBtn").disabled=true;
  try{
    if(GMODE==="login"){const user=$("#gUser").value.trim().toLowerCase(),pw=$("#gpw").value; $("#gUser").value=user; await signIn(user,pw); LASTPW=pw;
      if(!(await unlock())) return; LASTPW=null}
    else if(GMODE==="bootstrap"){const user=$("#gUser").value.trim().toLowerCase(),pw=$("#gpw").value;
      if(!USERRE.test(user)) throw new Error("bad_username"); if(weakPw(pw)) throw new Error("Password should be"); if(pw!==$("#gpw2").value) throw new Error("הסיסמאות לא זהות");
      await fnCall({action:"bootstrap",username:user,display_name:$("#gName").value.trim(),password:pw},false);
      await signIn(user,pw); if(!(await unlock())) return}
    else if(GMODE==="changepw"){const cur=LASTPW||$("#gpw0").value,pw=$("#gpw").value;
      if(weakPw(pw)) throw new Error("Password should be"); if(pw!==$("#gpw2").value) throw new Error("הסיסמאות לא זהות");
      await fnCall({action:"change_password",current_password:cur,new_password:pw});
      await signIn(lsGet("ys_user")||PROFILE?.username||"",pw); LASTPW=null; // a password change ends the old sessions
      // came from the portal's "finish your account" step: back to the portal home, signed in (shared ys_session)
      if(new URLSearchParams(location.search).get("then")==="portal"){location.replace(PORTAL);return}
      if(!(await unlock())) return}
    else if(GMODE==="noaccess"){await signOut();toPortal()}
    else if(GMODE==="error"){location.reload()}
    else if(GMODE==="mfa"){await mfaVerify(MFAF,$("#gOtp").value);if(!(await unlock())) return}
    else if(GMODE==="mfa_enroll"){if(!ENR) throw new Error("רגע, הקוד עוד נטען");await mfaVerify(ENR.id,$("#gOtp").value);ENR=null;if(!(await unlock())) return}
    else if(GMODE==="code"){const user=$("#gUser").value.trim().toLowerCase(),pw=$("#gpw").value;
      if(weakPw(pw)) throw new Error("Password should be"); if(pw!==$("#gpw2").value) throw new Error("הסיסמאות לא זהות");
      const r=await fnCall({action:"recover_code",username:user,code:$("#gCode").value,new_password:pw},false);
      await signIn(user,pw); if(r&&r.left!=null&&r.left<3) alert(`נותרו ${r.left} קודי שחזור. מומלץ ליצור קודים חדשים בתפריט החשבון.`);
      if(!(await unlock())) return}
    else if(GMODE==="recoverpw"){const pw=$("#gpw").value;
      if(weakPw(pw)) throw new Error("Password should be"); if(pw!==$("#gpw2").value) throw new Error("הסיסמאות לא זהות");
      const r=await fnCall({action:"recovery_set_password",new_password:pw}); // server-side, only from the mail's session
      await signIn(r.username,pw); if(!(await unlock())) return}
  }catch(err){m.className="msg err";m.textContent=errText(err);$("#gateBtn").disabled=false;if(GMODE==="login") $("#gpw")?.select()}
});
(async()=>{
  // a reset-password mail lands here with #access_token=…&type=recovery: choose a new password first
  const HP=new URLSearchParams(location.hash.slice(1));
  if(location.hash) history.replaceState(null,"",location.pathname+location.search);
  if(HP.get("type")==="recovery"&&HP.get("access_token")){setSes({access_token:HP.get("access_token"),refresh_token:HP.get("refresh_token"),expires_in:HP.get("expires_in"),expires_at:HP.get("expires_at")});
    gateIntro();gateMode("recoverpw");return}
  if(HP.get("error_description")){gateIntro();gateMode("login",{err:"הקישור מהמייל לא תקף או שפג תוקפו. בקש קישור חדש."});return}
  // recovery code (the portal's "אין לי גישה" link): the one sign-in step still done here
  if(new URLSearchParams(location.search).get("recover")==="1"){gateIntro();gateMode("code");return}
  if(!SES){toPortal();return}
  // signed in through the portal: straight to the tool, no intro; the gate shows only for a step this account still owes
  try{if(await unlock()) return}catch(e){console.warn(e); if(e.status===401||e.status===403||e.message==="not_signed_in"){setSes(null);toPortal();return}}
  if(["changepw","noaccess","mfa","mfa_enroll"].includes(GMODE)){gateIntro();return}
  gateIntro(); gateMode("error");
})();
