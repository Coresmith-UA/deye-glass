'use strict';
const crypto=require('node:crypto');
function parseIni(text) {
  const result = {}; let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^[;#]/.test(line)) continue;
    const m = line.match(/^\[([^\]]+)\]$/);
    if (m) { section=m[1]; result[section] ??= {}; continue; }
    const i=line.indexOf('='); if (i>=0 && section) result[section][line.slice(0,i).trim()]=line.slice(i+1).trim();
  }
  return result;
}
// Why this exists at all: System.Media.SoundPlayer takes plain PCM WAV only, and on anything else it
// fails without a sound - so an MP3 renamed to .wav looks accepted and then stays silent during the
// one outage it was meant to announce. Checking the header turns that into an error at the moment the
// file is chosen. Pure function over the first bytes of the file; the caller reads them.
// Layout: 'RIFF' size 'WAVE' then chunks. Only the format tag is inspected - sample rate, bit depth
// and channel count are all accepted, because the files in this project are 24-bit and do play.
const WAV_PCM=1, WAV_FLOAT=3, WAV_EXTENSIBLE=0xfffe;
// bytes is the real length of the file on disk, which buf may be only the beginning of. The RIFF size
// field has to be checked against it: a field claiming more bytes than exist (a bad export, an
// interrupted download) is exactly the case where ordinary players ignore the field and play the data
// chunk anyway, while SoundPlayer follows the header and produces silence without an error. One of the
// shipped files arrived that way, so this is a bug that happened, not a hypothetical.
function wavProblem(buf,bytes){
  if(!buf||buf.length<44)return 'Not a WAV file';
  if(buf.toString('latin1',0,4)!=='RIFF'||buf.toString('latin1',8,12)!=='WAVE')return 'Not a WAV file';
  // Larger than the field is fine: trailing metadata chunks sit outside the RIFF size in real files.
  if(Number.isFinite(bytes)&&buf.readUInt32LE(4)+8>bytes)return 'WAV header size is wrong - re-save the file';
  // The format chunk is not always the first one, so it is searched for rather than assumed at 12.
  for(let at=12;at+8<=buf.length;){
    const id=buf.toString('latin1',at,at+4),size=buf.readUInt32LE(at+4);
    if(id==='fmt '){
      if(size<16||at+8+2>buf.length)return 'Damaged WAV file';
      const tag=buf.readUInt16LE(at+8);
      if(tag===WAV_PCM||tag===WAV_EXTENSIBLE)return null;
      // Named rather than lumped in with "not a WAV": a float or compressed WAV really is a WAV, and
      // "convert it to PCM" is actionable where "not a WAV file" would look like a wrong-file error.
      return tag===WAV_FLOAT?'WAV is float, not PCM - convert it':'WAV is compressed - save it as PCM';
    }
    at+=8+size+(size%2); // chunks are word-aligned, so an odd size carries a pad byte
  }
  return 'Damaged WAV file';
}
// Surgical, line-based INI update. Rendering parseIni's output back to text would be shorter but
// would destroy comments, key order, letter case and the hand-written [Sounds] paths, so the file is
// edited as text instead. A key whose value is undefined is left untouched - that is how "the token
// field was left empty, keep the stored one" is expressed. Pure function: the caller does the I/O.
function writeIni(text, updates) {
  const bom = text.startsWith('﻿') ? '﻿' : '', body = bom ? text.slice(1) : text;
  // Keep the file's own line endings: rewriting CRLF as LF shows the whole file as one line in Notepad.
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const pending = new Map();
  for (const [section, keys] of Object.entries(updates)) {
    const want = new Map();
    for (const [k, v] of Object.entries(keys)) if (v !== undefined) want.set(k, String(v));
    if (want.size) pending.set(section.toLowerCase(), {name: section, keys: want});
  }
  // The first block holds anything before the first header; it has no section and is never touched.
  const blocks = [{section: null, lines: []}];
  for (const raw of body.split(/\r?\n/)) {
    const head = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (head) { blocks.push({section: head[1].trim(), lines: [raw]}); continue; }
    const block = blocks[blocks.length - 1], want = block.section && pending.get(block.section.toLowerCase());
    const kv = raw.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)/);
    if (kv && want) {
      const hit = [...want.keys.keys()].find(k => k.toLowerCase() === kv[2].toLowerCase());
      if (hit !== undefined) { block.lines.push(kv[1] + kv[2] + kv[3] + want.keys.get(hit)); want.keys.delete(hit); continue; }
    }
    block.lines.push(raw);
  }
  // Keys whose section exists but which have no line yet go after its last non-blank line, so they
  // stay inside their section instead of drifting below the blank line that separates sections.
  for (const block of blocks) {
    const want = block.section && pending.get(block.section.toLowerCase());
    if (!want || !want.keys.size) continue;
    let end = block.lines.length; while (end > 1 && !block.lines[end - 1].trim()) end--;
    block.lines.splice(end, 0, ...[...want.keys].map(([k, v]) => `${k} = ${v}`));
    want.keys.clear();
  }
  const tail = [];
  for (const {name, keys} of pending.values()) if (keys.size) tail.push('', `[${name}]`, ...[...keys].map(([k, v]) => `${k} = ${v}`));
  return bom + [...blocks.flatMap(b => b.lines), ...tail].join(nl);
}
// The logger uploads to the cloud every ~5 minutes, so polling faster returns the same answer:
// measured on a live station, 12 of 13 requests spaced 30 s apart carried an identical
// lastUpdateTime, and a record was already 73 s old when it first became visible. Hence the
// schedule is anchored to the data rather than to a wall clock.
const UPLOAD_PERIOD = 300, APPEAR_LAG = 90, RETRY = 45, MIN_INTERVAL = 60;
// Seconds until the next poll should happen. `max` is the user's interval, used as a ceiling for the
// wait rather than as the rate: a fixed interval equal to the upload period keeps whatever phase
// offset it started with, so it can show data a full period old forever. Aiming just past the
// predicted arrival locks the phase to the logger instead.
// `jitter` is per-process, because every machine sharing a station anchors to the same
// lastUpdateTime - without it four widgets would hit the API in one synchronised burst.
function nextDelay({now, sourceTime, period = UPLOAD_PERIOD, max, jitter = 0}) {
  const ceiling = Math.max(MIN_INTERVAL, numeric(max) || UPLOAD_PERIOD);
  const wait = sourceTime ? (sourceTime + (period + APPEAR_LAG) * 1000 - now) / 1000 : 0;
  // A non-positive wait means the upload is late or its period moved; step back at a fixed retry
  // instead of polling flat out, since nothing can make the cloud answer sooner.
  return Math.min(ceiling, (wait > 0 ? wait : RETRY) + jitter);
}
// Upload period learned from two consecutive records. An implausible gap - a logger reboot, a clock
// jump, a backfilled record - keeps the previous estimate: one bad sample must not strand the
// schedule somewhere it cannot recover from, and the ceiling above bounds the damage either way.
function learnPeriod(previous, current, period = UPLOAD_PERIOD) {
  if (!previous || !current || current <= previous) return period;
  const gap = (current - previous) / 1000;
  return gap >= 30 && gap <= 1800 ? gap : period;
}
// Which record the schedule is anchored to. The cloud sometimes serves a timestamp a second behind
// the one before it - observed live: 00:06:05, then 00:06:04 carrying different readings. Anchoring
// on whatever arrived last would walk the schedule backwards on every such wobble, so the anchor
// only moves forward. A jump back by more than a whole period is a logger or clock reset rather than
// a wobble, and re-anchors: otherwise the schedule would sit permanently overdue, retrying forever.
function track(state, current) {
  const {sourceTime, period = UPLOAD_PERIOD} = state || {};
  if (!current) return {sourceTime, period};
  if (!sourceTime || current > sourceTime || sourceTime - current > period * 1000)
    return {sourceTime: current, period: learnPeriod(sourceTime, current, period)};
  return {sourceTime, period};
}
// Below this SOC a discharging battery is reported as critical.
const CRITICAL_SOC = 30;
// Battery power in kW is noisy around zero, so treat a small band as "idle" rather than flow.
// The critical alarm uses the sensitive threshold; the informational "on battery" state uses the
// generous one, so a system idling on grid does not flicker between colours.
const IDLE_KW = 0.1, DISCHARGE_KW = 0.5;
function numeric(value) { if(value===null || value===undefined || value==='') return null; const n=Number(value); return Number.isFinite(n)?n:null; }
// Flow and state from the three readings they depend on. Separate from the mapping above it so the
// one place that decides "should I worry" cannot drift from the one place that reads the API, and so
// the state machine stays testable without a payload.
function deriveState({soc, battery, grid}) {
  return {
    // Physical direction of the battery flow, which is NOT the state: the state answers "should I
    // worry", this answers "where is the energy going". It exists so the sign of the kW reading is
    // readable without knowing the API convention, and it lives here rather than in the renderer so
    // the idle band stays the single IDLE_KW and cannot drift from the state machine below.
    flow: battery < -IDLE_KW ? 'in' : battery > IDLE_KW ? 'out' : 'idle',
    // First match wins. 'outage' means the grid is confirmed absent; not knowing the state at all is
    // a separate concern handled by the 'stale' flag.
    state: soc<CRITICAL_SOC && battery>IDLE_KW ? 'critical'
         : battery < -IDLE_KW ? 'charging'
         : !grid ? 'outage'
         : battery > DISCHARGE_KW ? 'discharging'
         : 'grid'};
}
// ---------------------------------------------------------------------------
// Official Deye developer API (developer.deyecloud.com).
//
// Why not the API the widget used before: that one is the web app's own backend, reached with a token
// copied out of a browser session, and such a token dies after 60 days with no way to renew it except
// by hand. The official API issues a token from credentials the user owns, so the widget renews it
// itself and the user never touches a token again. That is the entire point of this path.
const DEV_BASE='https://eu1-developer.deyecloud.com/v1.0';
// Envelope codes. The API answers HTTP 200 with a code inside the body, so the code is the real
// status. The auth codes are the ones worth a retry with a fresh token rather than a message.
const API_OK=new Set(['0','1000000','1106000']);
const API_AUTH=new Set(['1001','1002','1003','2101017']);
// Grid presence. The official API exposes no relay status at all - the field the widget used before
// does not exist here - so it is read from the grid frequency. Measured on this station over 139
// samples in 12 hours: 49.95-50.05 Hz while the grid was up, exactly 0 while it was down, and
// nothing in between, so any threshold inside that gap works and 10 Hz is far from both clusters.
// Grid voltage is the obvious alternative and was rejected: it carries a residual 4.8 V with the
// grid down, so it is the noisier of the two signals.
const GRID_FREQ_MIN=10;
// Measure points, which are the inverter's names rather than the widget's. Mapped in one place so
// the rest of the app keeps the shape it already had and nothing downstream needs to change.
const POINTS={soc:'SOC', battery:'BatteryPower', gridPower:'TotalGridPower',
  load:'TotalConsumptionPower', freq:'GridFrequency'};
// Day totals the inverter keeps itself, in kWh. Named by what they mean rather than by the API's
// spelling, which mixes conventions ("...Active", "...Energy", "...Purchased").
const DAY_ENERGY={purchased:'DailyEnergyPurchased', consumed:'DailyConsumption',
  charged:'DailyChargingEnergy', discharged:'DailyDischargingEnergy',
  fedIn:'DailyGridFeedIn', solar:'PVDailyPowerGenerationActive'};
// The same five readings, asked for over a window instead of right now. Five is the most the API
// takes in one call - seven answers "list too long" - and five is exactly what a point needs, so a
// whole day of history costs one request.
const HISTORY_POINTS=[POINTS.soc,POINTS.battery,POINTS.gridPower,POINTS.load,POINTS.freq];
function sha256hex(value){return crypto.createHash('sha256').update(String(value)).digest('hex').toLowerCase();}
// Credentials, checked before anything is sent. needsSetup is a stable marker for "there is nothing
// usable configured yet", so the shell can open the settings window instead of matching on text.
function credentials(config){
  const d=config.Deye||{};
  const missing=k=>{const v=d[k];return !v||String(v).includes('YOUR_');};
  if(['app_id','app_secret','email','password','station_id'].some(missing)){
    const e=new Error();e.publicMessage='Open Settings in the menu and enter your Deye developer credentials';e.needsSetup=true;throw e;
  }
  // A base_url left over from the old internal API points at a different host entirely, where none of
  // these endpoints exist, so only a developer endpoint is honoured and anything else falls back to
  // the default region. Silently keeping the stale host would look like a dead API instead.
  const stored=String(d.base_url||'').replace(/\/+$/,'');
  const base=/-developer\.deyecloud\.com/.test(stored)?stored:DEV_BASE;
  let url;
  try{url=new URL(base)}catch{const e=new Error();e.publicMessage='Server is not a valid URL';throw e;}
  if(url.protocol!=='https:'){const e=new Error();e.publicMessage='API requires HTTPS';throw e;}
  return {app_id:String(d.app_id),app_secret:String(d.app_secret),email:String(d.email),
    password:String(d.password),station_id:String(d.station_id),base};
}
async function apiCall({base, endpoint, body, token, fetcher}){
  const r=await fetcher(base+endpoint,{method:'POST',
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify(body||{}),signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok){
    const e=new Error();e.authFailed=[401,403].includes(r.status);
    e.publicMessage=r.status===429?'Deye Cloud rate limit reached - retrying later'
      :e.authFailed?'Credentials rejected - check them in Settings':`API error: HTTP ${r.status}`;
    throw e;
  }
  const body200=await r.json();
  const code=body200&&body200.code!==undefined&&body200.code!==null?String(body200.code):null;
  if(code!==null&&!API_OK.has(code)){
    const e=new Error();e.authFailed=API_AUTH.has(code);
    // The server's own message is shown for anything else: it says useful things like "invalid param
    // type". It is the API's text about the request, never an echo of what was sent, so no credential
    // can travel out through it.
    e.publicMessage=e.authFailed?'Credentials rejected - check them in Settings'
      :`Deye Cloud: ${body200.msg||'error '+code}`;
    throw e;
  }
  return body200;
}
// The token, cached in the session the caller owns. Renewed a day before it expires: it is valid for
// 60 days, and the whole purpose here is that it never expires while the widget is running.
async function apiToken(cred, session, fetcher){
  if(session.token && Date.now() < session.expiresAt) return session.token;
  const j=await apiCall({base:cred.base,endpoint:`/account/token?appId=${encodeURIComponent(cred.app_id)}`,
    body:{appSecret:cred.app_secret,email:cred.email,password:sha256hex(cred.password)},fetcher});
  if(!j.accessToken){const e=new Error();e.publicMessage='Deye Cloud returned no access token';throw e;}
  // The value arrives with the scheme inside it ("Bearer eyJ..."), so using it raw would build a
  // header reading "Bearer Bearer eyJ...".
  session.token=String(j.accessToken).split(' ').pop();
  const life=numeric(j.expiresIn)||60*86400;
  session.expiresAt=Date.now()+Math.max(0,life-86400)*1000;
  return session.token;
}
// The readings the widget needs live on the inverter, not on the station: the station endpoint has no
// grid signal. The user configures a station id, because that is what they can see in the Deye app,
// so the inverter behind it is looked up once and remembered for as long as that station is the
// configured one.
async function inverterSn(cred, session, token, fetcher){
  if(session.sn && session.snFor===cred.station_id) return session.sn;
  const j=await apiCall({base:cred.base,endpoint:'/station/device',token,fetcher,
    body:{stationIds:[numeric(cred.station_id)??cred.station_id],page:1,size:50}});
  // /station/device answers in deviceListItems; /device/list uses deviceList. Both are accepted so
  // the lookup does not depend on which of the two the account happens to serve.
  const devices=j.deviceListItems||j.deviceList||[];
  const found=devices.find(d=>d&&String(d.deviceType).toUpperCase()==='INVERTER');
  if(!found||!found.deviceSn){const e=new Error();e.publicMessage='No inverter on that station - check the Station ID';throw e;}
  session.sn=String(found.deviceSn);session.snFor=cred.station_id;
  return session.sn;
}
// Shared core of normalizeDevice and normalizeHistory: reads the five measure points from a Map,
// converts units and derives state. Returns null when any required reading is missing so that
// both callers can handle the gap in one place without duplicating the null-check.
function readPoints(by){
  const read=name=>numeric(by.get(name));
  const rawSoc=read(POINTS.soc),batteryW=read(POINTS.battery),gridW=read(POINTS.gridPower),
        loadW=read(POINTS.load),freq=read(POINTS.freq);
  if([rawSoc,batteryW,gridW,loadW,freq].some(v=>v===null))return null;
  const soc=Math.max(0,Math.min(100,rawSoc)),battery=batteryW/1000,grid=freq>GRID_FREQ_MIN;
  return {soc,battery,grid,gridPower:gridW/1000,load:loadW/1000,...deriveState({soc,battery,grid})};
}
function normalizeDevice(entry){
  const list=entry&&entry.dataList;
  if(!Array.isArray(list)){const e=new Error();e.publicMessage='Deye Cloud returned no measurements';throw e;}
  const by=new Map();
  for(const item of list) if(item&&item.key!==undefined) by.set(String(item.key), item.value);
  const pts=readPoints(by);
  // A missing reading must never become a convincing zero: the widget is read at a glance and a
  // confident "0 kW, grid fine" is worse than an error.
  if(!pts){const e=new Error();e.publicMessage='Deye Cloud returned incomplete data';throw e;}
  let sourceTime=numeric(entry.collectionTime); if(sourceTime && sourceTime<1e12) sourceTime*=1000;
  const read=name=>numeric(by.get(name));
  return {...pts, sourceTime:sourceTime||null,
    // The inverter's own day counters, which ride along in the reading that was fetched anyway - no
    // extra request, and exact, unlike anything integrated from five-minute samples. Absent points
    // stay null rather than becoming 0: a station without PV does not report every one of them, and
    // "0.00 kWh of solar" and "no solar meter" are different statements.
    dayEnergy:Object.fromEntries(Object.entries(DAY_ENERGY).map(([name,key])=>[name,read(key)])),
    // Age is the whole staleness test here. The old API carried its own network flag; this one does
    // not, and what actually matters is the same either way: readings that stopped arriving.
    stale: !!sourceTime && Date.now()-sourceTime>600000};
}
// How long the current state has held. The widget only runs while the machine does, so the one thing
// this must not do is invent a duration across a gap it did not watch: if the last reading is older
// than maxGap - the app was closed, the machine slept - the clock restarts instead of claiming an
// outage lasted all night. A change of state always restarts it. Pure; the caller stores the result.
function stateClock(previous, {state, now, maxGap = 900000}) {
  if (!state) return previous || null;
  const same = previous && previous.state === state;
  const watched = same && previous.seenAt && now - previous.seenAt <= maxGap;
  return {state, since: watched ? previous.since : now, seenAt: now};
}
// Scan history backwards to find the server-side timestamp when the current state began continuously.
// Used after loading cloud history to correct clock.since when the machine was off during a state
// change: without this, outage timers restart from boot rather than from when the outage actually began.
// Returns null if history is empty, state is falsy, or the most recent point is not in that state.
function inferStateSince(points, state) {
  if (!points || !points.length || !state) return null;
  if (points[points.length - 1].state !== state) return null;
  let i = points.length - 1;
  while (i > 0 && points[i - 1].state === state) i--;
  return points[i].t;
}
// 3x5 pixel digits, drawn at double size. No font and no asset: the tray icon is generated, and a
// font would have to be shipped, found by name, and would still not be legible at this size.
const TRAY_DIGITS=['111101101101111','010010010010010','111001111100111','111001111001111',
  '101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
// SOC as an arc plus the number inside it, in the colour of the state. 100 is drawn as a complete
// ring with no digits: three double-width digits do not fit the 18px hole, and a full ring is what
// "full" looks like anyway. Returns raw RGBA for nativeImage.createFromBitmap.
function trayPixels({soc = null, rgb = [0, 231, 152], size = 32} = {}) {
  const px=Buffer.alloc(size*size*4), mid=(size-1)/2, [r,g,b]=rgb;
  const set=(x,y)=>{if(x<0||y<0||x>=size||y>=size)return;const i=(y*size+x)*4;
    // BGRA: nativeImage.createFromBitmap takes the platform byte order, not RGB.
    px[i]=b;px[i+1]=g;px[i+2]=r;px[i+3]=255;};
  // A null SOC is "not known yet", not zero: it draws the plain ring the icon used to be, in the
  // grey the caller passes for offline. Printing "0" there would be a reading the widget does not have.
  const level=soc===null||!Number.isFinite(soc)?null:Math.max(0,Math.min(100,soc)), full=level===null||level>=99.5;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const dist=Math.hypot(x-mid,y-mid);
    if(dist<size*0.28||dist>size*0.44)continue;
    // Angle from 12 o'clock, clockwise, so the arc fills the way the ring in the widget does.
    const angle=(Math.atan2(x-mid,mid-y)+Math.PI*2)%(Math.PI*2);
    if(full||angle<=level/100*Math.PI*2)set(x,y);
  }
  if(full)return px;
  const text=String(Math.round(level)),w=text.length*6+(text.length-1)*2;
  let left=Math.round(mid-w/2+0.5);
  for(const ch of text){
    const glyph=TRAY_DIGITS[Number(ch)]||'';
    for(let gy=0;gy<5;gy++)for(let gx=0;gx<3;gx++)if(glyph[gy*3+gx]==='1')
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)set(left+gx*2+dx,Math.round(mid-5+gy*2+dy));
    left+=8;
  }
  return px;
}
function publicError(e) {
  if(e.name==='TimeoutError'||e.name==='AbortError') return 'API timeout exceeded';
  return e.publicMessage || 'No connection to Deye Cloud';
}
// A window of history, in the shape the rest of the app already uses. The payload nests differently
// from the live reading - the timestamp sits on the row and the readings in an itemList under it -
// so it gets its own parser, but the derivation is the shared one, which is the point: a bar drawn
// from history and a bar drawn from a live poll cannot end up different colours.
// Rows missing any of the five readings are dropped rather than patched: a gap in the chart is
// honest, a bar invented from partial data is not.
function normalizeHistory(payload){
  const out=[];
  for(const row of (payload&&payload.dataList)||[]){
    let time=numeric(row&&row.time); if(time===null)continue;
    if(time<1e12)time*=1000;
    const by=new Map();
    for(const item of (row.itemList||[])) if(item&&item.key!==undefined) by.set(String(item.key),item.value);
    const pts=readPoints(by);
    if(!pts)continue;
    out.push({t:time, ...pts});
  }
  // The API returns the window in order, but the order is what every caller depends on, so it is
  // made true here rather than assumed.
  return out.sort((a,b)=>a.t-b.t);
}
// How long each state held across a window. The cloud keeps no such counter - there is a run-time
// counter for the generator and nothing for the grid - so it is integrated from the samples, which
// bounds the precision: a transition is only known to within one sampling interval (~5 min on this
// station), so a reported 2:28 is really 2:23-2:33. That is accurate enough to answer "how long was
// the power out today" and nowhere near enough to answer "when exactly did it go".
// Each interval is credited to the state of the sample that opened it. An interval longer than
// maxGap is a hole in the data, not a long steady state, so it is counted as unknown instead of
// being attributed - the same rule stateClock uses, for the same reason.
function dayStats(points, {from, to, maxGap=1800000}={}){
  const span=Math.max(0,(to||0)-(from||0));
  const states={grid:0,outage:0,charging:0,discharging:0,critical:0};
  // The four figures worth reading, each measured from the readings rather than from the state name.
  // That distinction is not pedantry: 'critical' is tested before 'outage' in the state machine, so
  // a flat battery during a blackout is labelled 'critical', and counting state names would file
  // that blackout under "the grid was there" - backwards, and precisely during the event that
  // matters most. withGrid and withoutGrid come from the grid reading itself and cannot invert.
  const figures={withGrid:0,withoutGrid:0,charging:0,onBattery:0};
  let accounted=0;
  // A point has to say outright whether the grid was there. Treating a missing flag as falsy would
  // invent a blackout out of a malformed reading, and "there was no power for two hours" is not a
  // claim to make from a default. Such a point is not counted at all, so its time lands in unknown.
  const inside=(points||[]).filter(p=>p&&Number.isFinite(p.t)&&typeof p.grid==='boolean'
    &&Number.isFinite(p.battery)&&p.t>=from&&p.t<=to);
  for(let i=0;i<inside.length;i++){
    // The last sample is credited up to `to`, so the state the station is in right now counts
    // towards the totals instead of being dropped for not having a successor yet.
    const next=i+1<inside.length?inside[i+1].t:to;
    const point=inside[i],dt=next-point.t;
    if(dt<=0||dt>maxGap)continue;
    if(states[point.state]!==undefined)states[point.state]+=dt;
    if(point.grid)figures.withGrid+=dt; else figures.withoutGrid+=dt;
    if(point.battery<-IDLE_KW)figures.charging+=dt;
    // Grid present and the battery being drained anyway - the inverter choosing the battery over
    // the grid. Includes the critical case, which is the same thing with a low battery.
    if(point.grid&&point.battery>DISCHARGE_KW)figures.onBattery+=dt;
    accounted+=dt;
  }
  return {...figures,states,
    // Everything the samples cannot speak for: holes, and the stretch of the window before the
    // first sample arrived. Reported rather than hidden, so withGrid + withoutGrid + unknown is
    // always the whole window. charging and onBattery are SUBSETS of those two, not more parts of
    // the split - a reader adding all four together would get nonsense.
    unknown:Math.max(0,span-accounted),
    from:from||null,to:to||null,samples:inside.length};
}
// Local midnight, not UTC and not "24 hours ago": "today" is the day the user is looking at.
function startOfDay(now=Date.now()){const d=new Date(now);d.setHours(0,0,0,0);return d.getTime();}
// The live session: a token and the inverter behind the configured station. Process-wide by default
// so the token is fetched once rather than on every poll, but passed in explicitly so a test - and
// the settings window's "Test connection", which must not disturb the running widget - can use its
// own. Credentials never land here; only what was derived from them.
function newSession(){return {token:null,expiresAt:0,sn:null,snFor:null};}
const SESSION=newSession();
// Called when the configuration is saved: new credentials must not keep answering with a token and
// an inverter discovered for the old ones.
function resetSession(session=SESSION){Object.assign(session,newSession());return session;}
async function fetchStation(config, fetcher=fetch, session=SESSION) {
  const cred=credentials(config);
  // One retry, with the cached token discarded first. A token can be revoked or invalidated
  // server-side long before the expiry it was issued with, and re-authenticating is the recovery -
  // without this the widget would sit on a dead token until it was restarted.
  for(let attempt=0;;attempt++){
    try{
      const token=await apiToken(cred,session,fetcher);
      const sn=await inverterSn(cred,session,token,fetcher);
      const j=await apiCall({base:cred.base,endpoint:'/device/latest',token,fetcher,body:{deviceList:[sn]}});
      const entry=(j.deviceDataList||[]).find(d=>d&&d.dataList)||null;
      if(!entry){const e=new Error();e.publicMessage='Deye Cloud returned no data for the inverter';throw e;}
      return normalizeDevice(entry);
    }catch(e){
      if(e.authFailed&&attempt===0){session.token=null;session.expiresAt=0;continue;}
      throw e;
    }
  }
}
// One request, one window. Used twice: to fill the chart at startup with what actually happened
// rather than with what this machine happened to witness, and to work out how long today's states
// have lasted. Both want the same series, so they share the call.
async function fetchHistory(config, fetcher=fetch, session=SESSION, {from, to=Date.now()}={}){
  const cred=credentials(config);
  const start=Number.isFinite(from)?from:to-86400000;
  for(let attempt=0;;attempt++){
    try{
      const token=await apiToken(cred,session,fetcher);
      const sn=await inverterSn(cred,session,token,fetcher);
      const j=await apiCall({base:cred.base,endpoint:'/device/historyRaw',token,fetcher,
        body:{deviceSn:sn,startTimestamp:Math.floor(start/1000),endTimestamp:Math.floor(to/1000),
          measurePoints:HISTORY_POINTS}});
      return normalizeHistory(j);
    }catch(e){
      if(e.authFailed&&attempt===0){session.token=null;session.expiresAt=0;continue;}
      throw e;
    }
  }
}
const DEMO={soc:92,battery:-3.10,grid:true,gridPower:3.75,load:.49,state:'charging',flow:'in',stale:false,sourceTime:null,
  dayEnergy:{purchased:8.6,consumed:10,charged:1.7,discharged:3.1,fedIn:0,solar:0}};
module.exports={
  // Constants
  CRITICAL_SOC,IDLE_KW,DISCHARGE_KW,UPLOAD_PERIOD,APPEAR_LAG,RETRY,MIN_INTERVAL,GRID_FREQ_MIN,DEV_BASE,HISTORY_POINTS,DEMO,
  // Pure utilities
  parseIni,writeIni,wavProblem,numeric,sha256hex,startOfDay,
  // State machine
  deriveState,stateClock,inferStateSince,nextDelay,learnPeriod,track,
  // Normalisation
  normalizeDevice,normalizeHistory,
  // Tray
  trayPixels,
  // API
  credentials,newSession,resetSession,publicError,fetchStation,fetchHistory,dayStats,
};
