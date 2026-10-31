'use strict';
const {app,BrowserWindow,Tray,Menu,nativeImage,ipcMain,screen,nativeTheme,shell,dialog,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {parseIni,writeIni,wavProblem,fetchStation,fetchHistory,dayStats,startOfDay,publicError,nextDelay,track,stateClock,inferStateSince,trayPixels,newSession,resetSession,DEMO,UPLOAD_PERIOD,MIN_INTERVAL,DEV_BASE}=require('./core.cjs');
const SOUND_DEFAULT={grid_lost:'sounds/grid_lost.wav',grid_back:'sounds/grid_back.wav'};
// Secrets at rest. The two values that can reach the account - the app secret and the account
// password - are never written to disk in the clear; safeStorage is Windows DPAPI underneath, so the
// ciphertext is readable only by this user on this machine. That binding would normally be a cost,
// because a config file could no longer be carried to another machine, but the app ships as a bare
// EXE: config.ini is written fresh wherever it lands, so there is nothing to carry and nothing lost.
// The password has to be stored at all because renewing the token needs it again, and the API gives
// no usable refresh flow - it returns a refreshToken but documents no endpoint that accepts one.
const SEALED='enc:';
// The async safeStorage calls, not the synchronous ones: Electron has deprecated the sync API and
// says it will be removed, and the async side reads blobs the sync side wrote, so nothing already
// on disk has to be rewritten to move over.
const SECRET_KEYS=['app_secret','password'];
// Plaintext secrets, in memory only. Decrypted once at startup instead of on every read, which keeps
// readConfig() synchronous for the rest of the app and costs one DPAPI call per change rather than
// two every five minutes.
let secrets={app_secret:'',password:''};
async function canSeal(){try{return await safeStorage.isAsyncEncryptionAvailable()}catch{return false}}
// null, not a plaintext fallback: if Windows cannot encrypt, the caller refuses to save rather than
// quietly writing the password where it said it would not.
async function sealSecret(plain){
  if(!plain)return plain;
  if(!await canSeal())return null;
  try{return SEALED+(await safeStorage.encryptStringAsync(String(plain))).toString('base64')}catch{return null}
}
// A sealed value that will not open belongs to another user or another machine - DPAPI binds it to
// both - and the honest reading of that is "no credential here", which sends the user to the
// settings form rather than to a login failure they cannot act on.
async function openSecret(text){
  try{
    const answer=await safeStorage.decryptStringAsync(Buffer.from(text.slice(SEALED.length),'base64'));
    // The platform can ask for a refresh when its key has moved on; honouring it is nearly free.
    return {value:answer.result,reseal:!!answer.shouldReEncrypt};
  }catch{return {value:''};}
}
// Reads the secrets into memory and writes back anything that needs sealing: plaintext left by a
// hand edit or by a version that had none, or a blob the platform wants refreshed. Best-effort - a
// failure here must not stop the widget from starting.
async function loadSecrets(){
  let stored;try{stored=parseIni(fs.readFileSync(configPath,'utf8')).Deye||{}}catch{return}
  const updates={};
  for(const key of SECRET_KEYS){
    const raw=stored[key];
    if(!raw||raw.includes('YOUR_')){secrets[key]='';continue}
    const {value,reseal}=raw.startsWith(SEALED)?await openSecret(raw):{value:raw,reseal:true};
    secrets[key]=value;
    if(value&&reseal){const sealed=await sealSecret(value);if(sealed)updates[key]=sealed;}
  }
  if(!Object.keys(updates).length)return;
  try{fs.writeFileSync(configPath,writeIni(fs.readFileSync(configPath,'utf8'),{Deye:updates}))}catch{}
}
// Every read of config.ini goes through here, so nothing downstream - core.cjs least of all - ever
// has to know that anything was encrypted.
function readConfig(){
  const raw=parseIni(fs.readFileSync(configPath,'utf8'));
  if(!raw.Deye)return raw;
  const merged={...raw.Deye};
  let handEdited=false;
  for(const key of SECRET_KEYS){
    const stored=merged[key];
    // A hand-edited secret is plaintext, because nobody can type DPAPI ciphertext. It is used at
    // once - so editing the file by hand still works on the next poll, as it always did - and
    // sealed in the background. Anything already sealed comes from the cache read at startup.
    if(stored&&!String(stored).startsWith(SEALED)&&!String(stored).includes('YOUR_')){
      merged[key]=String(stored);handEdited=true;
    }else merged[key]=secrets[key];
  }
  if(handEdited)loadSecrets();
  raw.Deye=merged;
  return raw;
}
// Poll schedule: the inverter timestamp of the newest record seen, which the next poll is aimed
// from, and the learned gap between records. The jitter is drawn once per process so several
// widgets on one station spread out instead of firing in one synchronised burst.
const SCALE_OPTIONS=[.5,.75,1,1.25,1.5];
const TRAY_TICK_MS=1000, HISTORY_REFRESH_MS=3600*1000;
let schedule={sourceTime:null,period:UPLOAD_PERIOD};const jitter=Math.floor(Math.random()*30);
let win,setupWin,tray,timer,busy=false,quitting=false,lastGrid=null,snapshot={data:null,error:null,loading:true},history=[];
let settingsAutoOpened=false;
let prefs={},config={},stateFile,historyFile,configPath,dragTimer=null;
// How long the current state has held. Lives in prefs so a restart does not reset a running outage,
// but stateClock itself refuses to count across a gap it did not observe.
let clock=null,trayKey='';
// How long each state has held today, worked out from the cloud's own series rather than from what
// this process watched. Null until the first backfill answers; the page is given it as it is.
let today=null;
const demo=process.argv.includes('--demo');
function readJSON(p,fallback){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return fallback}}
function persist(){try{fs.writeFileSync(stateFile,JSON.stringify(prefs,null,2))}catch{}}
// The same five states the card and the chart use, as RGB, so the tray icon cannot drift into its
// own colour language. Kept here rather than in core.cjs because the CSS next to it is the source.
const STATE_RGB={grid:[0,233,149],discharging:[0,198,223],charging:[255,183,36],outage:[255,93,104],critical:[255,93,104]};
const STATE_LABEL={grid:'GRID ONLINE',discharging:'ON BATTERY',charging:'CHARGING',outage:'GRID OUTAGE',critical:'LOW BATTERY'};
// h:mm:ss once past an hour, m:ss before that. An outage is read in minutes for the first hour and
// in hours after it, and a leading "0:" on every short reading would just be noise.
function elapsed(ms){const s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;}
// The tray is the only thing left when the window is hidden, so it carries the reading rather than
// a logo: SOC as an arc and a number, the state as its colour, the rest in the tooltip. Redrawn on
// every send, because a stale number in the tray is worse than no number.
function updateTray(){
  if(!tray||tray.isDestroyed?.())return;
  const d=snapshot.data, offline=!d||snapshot.error||d.stale;
  const rgb=offline?[138,151,167]:STATE_RGB[d.state]||STATE_RGB.grid;
  // The tooltip is rebuilt every second for its clock; the bitmap is not, because redrawing an
  // identical icon once a second is work with no visible result.
  const key=`${d?Math.round(d.soc):-1}:${rgb}`;
  if(key!==trayKey){trayKey=key;tray.setImage(nativeImage.createFromBitmap(trayPixels({soc:d?d.soc:null,rgb}),{width:32,height:32}));}
  const lines=['Deye Glass'+(demo?' · DEMO':'')];
  if(d){
    lines.push(`${Math.round(d.soc)}% · ${offline?'NO DATA':STATE_LABEL[d.state]||d.state}`);
    if(!offline&&clock?.since)lines.push(`for ${elapsed(Date.now()-clock.since)}`);
    lines.push(`Load ${d.load.toFixed(2)} kW · Grid ${d.gridPower.toFixed(2)} kW`);
  }
  if(snapshot.error)lines.push(snapshot.error);
  tray.setToolTip(lines.join('\n'));
}
function broadcast(){updateTray();if(win && !win.isDestroyed())win.webContents.send('snapshot',{...snapshot,history,demo,mode:prefs.mode,scale:prefs.scale,lang:prefs.lang||'en',pinned:!!prefs.pinned,mute:!!prefs.mute,stateSince:clock?.since||null,capacity:Number(config.Widget?.battery_capacity_kwh)||16,model:config.Widget?.model||'SUN-8K',today});}
// The chart is filled from the cloud, not only from what this machine happened to witness: without
// this it starts empty on a new machine and keeps a hole after every sleep or restart. One request
// carries the whole day, and the same series answers how long each state has lasted today - the
// cloud keeps no such counter, so it is integrated from the samples.
// Cloud points win on collision because they are the authoritative copy of the same readings; the
// local file can still hold the newest poll, which the cloud lags by about 90 seconds. Buckets of
// two minutes, so re-running this never doubles a bar.
function mergeHistory(local,cloud){
  const bucket=t=>Math.round(t/120000),byTime=new Map();
  for(const p of local||[]) if(p&&Number.isFinite(p.t)&&Number.isFinite(p.v)) byTime.set(bucket(p.t),p);
  for(const p of cloud||[]) byTime.set(bucket(p.t),{t:p.t,v:p.load,s:p.state});
  return [...byTime.values()].sort((a,b)=>a.t-b.t);
}
// Best-effort throughout: a failure here costs the backfill and the day's figures, never the
// widget. The live reading is what the card shows, and it comes from poll().
async function refreshHistory(){
  if(demo||quitting)return;
  const now=Date.now();
  let points;
  try{points=await fetchHistory(config,fetch,undefined,{from:now-86400000,to:now})}catch{return}
  if(points.length){
    history=mergeHistory(history,points).filter(p=>p.t>now-86400000).slice(-3000);
    try{fs.writeFileSync(historyFile,JSON.stringify(history))}catch{}
  }
  // Computed over today only, while the series fetched above spans a full day - the chart wants 24
  // hours, the figures want "since midnight", and one request serves both.
  today=dayStats(points,{from:startOfDay(now),to:now});
  // Correct clock.since using server history: if the machine was off during a state change (e.g. a
  // power outage started while the PC was off), stateClock restarted from boot. History knows the
  // true start. Only update if the server tells us the state started earlier than we thought.
  if(clock&&points.length){
    const inferred=inferStateSince(points,clock.state);
    if(inferred&&inferred<clock.since){clock={...clock,since:inferred};prefs.clock=clock;persist();}
  }
  broadcast();
}
// Must match #widget in index.html exactly: the window is the card, so a mismatch shows as empty
// area around it or as a clipped edge. A test compares the two, because nothing else would notice.
function size(){return prefs.mode==='full'?[640,580]:[440,220];}
// On Windows a window created with resizable:false silently ignores setSize,
// which left the window at the old mode's size and exposed empty area around the card.
function applySize(){const [w,h]=size();win.setResizable(true);win.setSize(Math.round(w*prefs.scale),Math.round(h*prefs.scale));win.setResizable(false);broadcast();persist();}
// The card is dragged by hand rather than with -webkit-app-region:drag: a drag region makes
// Windows swallow every mouse event inside it, which is what killed double click and right click.
// The position is followed from the cursor here in the main process, not from renderer mousemove
// deltas - during a fast drag the cursor leaves the window and the renderer stops getting events.
function dragStop(){if(!dragTimer)return;clearInterval(dragTimer);dragTimer=null;[prefs.x,prefs.y]=win.getPosition();persist();}
function dragStart(){dragStop();const origin=screen.getCursorScreenPoint(),[wx,wy]=win.getPosition();
  dragTimer=setInterval(()=>{if(!win||win.isDestroyed()||!win.isVisible()){dragStop();return}
    const p=screen.getCursorScreenPoint();win.setPosition(wx+p.x-origin.x,wy+p.y-origin.y)},16);}
// A real OS-framed dialog, unlike the frameless widget: a form needs a title bar, a close button and
// system dragging, and reimplementing those by hand is what made the widget's drag logic above hard.
function openSettings(){
  if(setupWin&&!setupWin.isDestroyed()){setupWin.show();setupWin.focus();return}
  // useContentSize: without it the height includes the system title bar, so the client area came out
  // ~30px shorter than the form and the dialog scrolled. The height here is only a starting value -
  // ready-to-show below measures the rendered form and resizes to it.
  setupWin=new BrowserWindow({width:520,height:620,useContentSize:true,parent:win,resizable:false,minimizable:false,maximizable:false,
    fullscreenable:false,backgroundColor:'#101820',title:'Deye Glass',show:false,
    webPreferences:{preload:path.join(__dirname,'preload-settings.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname,'settings.html'));
  // The height is measured, not guessed. The form cannot be resized and must not scroll, so every
  // field added to it used to mean re-tuning a constant by hand - and the right constant depends on
  // the system font and the chosen language, which no constant can know. Clamped so a broken
  // measurement cannot produce a window taller than the screen.
  setupWin.once('ready-to-show',async()=>{
    try{
      const h=await setupWin.webContents.executeJavaScript('document.documentElement.scrollHeight');
      const limit=screen.getPrimaryDisplay().workAreaSize.height-60;
      if(Number.isFinite(h)&&h>200)setupWin.setContentSize(520,Math.min(Math.max(Math.ceil(h)+24,360),limit));
    }catch{}
    if(setupWin&&!setupWin.isDestroyed())setupWin.show();
  });
  // Closing the form must not take the app with it: window-all-closed only quits while quitting.
  setupWin.on('closed',()=>{setupWin=null});
  setupWin.webContents.setWindowOpenHandler(()=>({action:'deny'}));setupWin.webContents.on('will-navigate',e=>e.preventDefault());
}
// Secrets are never part of an answer to the page - only whether one is stored. The form shows
// "saved" from those flags, and an empty secret field on save means "keep the stored one". The app
// secret and the account password are the two values that must not leave this process; the app id,
// the email and the station id are identifiers the user typed and can see again.
function settingsPayload(){const d=config.Deye||{},w=config.Widget||{};
  const set=k=>{const v=d[k];return !!v&&!String(v).includes('YOUR_');};
  const shown=k=>set(k)?String(d[k]):'';
  return {hasSecret:set('app_secret'),hasPassword:set('password'),
    app_id:shown('app_id'),email:shown('email'),station_id:shown('station_id'),
    base_url:d.base_url||'',refresh_interval:w.refresh_interval||String(UPLOAD_PERIOD),
    battery_capacity_kwh:w.battery_capacity_kwh||'16',model:w.model||'SUN-8K',lang:prefs.lang||'en',
    grid_lost:config.Sounds?.grid_lost||SOUND_DEFAULT.grid_lost,grid_back:config.Sounds?.grid_back||SOUND_DEFAULT.grid_back,
    mute:!!prefs.mute};
}
// Resolved the same way sound() resolves it: relative to the folder holding config.ini, so a path
// stays portable when the widget is copied to another machine.
// A path chosen by the user wins; the copies shipped inside the app are the fallback. Both are
// needed because the app travels as a bare EXE: there is no sounds folder next to it on a fresh
// machine, and without the bundled copies the one feature that has to make a noise would be silent.
function soundPath(rel){
  const beside=path.resolve(path.dirname(configPath),rel);
  if(fs.existsSync(beside))return beside;
  const inside=path.join(app.isPackaged?process.resourcesPath:path.resolve(__dirname,'..'),rel);
  // The user's own path is returned when neither exists, so the error names what they asked for.
  return fs.existsSync(inside)?inside:beside;
}
// An unreadable or non-PCM file is refused here rather than at the moment of an outage, which is the
// only other time anyone would find out. A path is checked only when it is actually being set.
function soundProblem(rel){
  if(!rel)return null;
  let buf;try{buf=fs.readFileSync(soundPath(rel))}catch{return 'Sound file not found'}
  return wavProblem(buf.subarray?buf.subarray(0,4096):buf,buf.length);
}
// Shared by test and save: the form's strings become either an INI update or a complaint, in one
// place, so "Test connection" can never pass values that saving would then reject.
function settingsUpdate(form){
  const f=form||{},clean=v=>typeof v==='string'?v.trim():v===undefined||v===null?'':String(v);
  // An empty secret field means "keep the stored one", so the user can change the station id without
  // retyping a password. Both secrets follow the rule the token used to.
  const kept=(typed,key)=>clean(typed)||config.Deye?.[key]||'';
  const appId=clean(f.app_id),secret=kept(f.app_secret,'app_secret'),
        email=clean(f.email),password=kept(f.password,'password'),station=clean(f.station_id);
  const blank=v=>!v||v.includes('YOUR_');
  if(blank(appId))return {error:'App ID is required'};
  if(blank(secret))return {error:'App Secret is required'};
  if(blank(email))return {error:'Account email is required'};
  if(blank(password))return {error:'Account password is required'};
  if(blank(station))return {error:'Station ID is required'};
  const base=clean(f.base_url)||DEV_BASE;
  try{if(new URL(base).protocol!=='https:')return {error:'Server must start with https://'}}catch{return {error:'Server is not a valid URL'}}
  const num=(v,min,fallback)=>{const s=clean(v);if(s==='')return String(fallback);const n=Number(s);
    return Number.isFinite(n)?String(Math.max(min,n)):null};
  // The interval is a ceiling on the wait, not the poll rate - the schedule follows the upload
  // cadence. Values below MIN_INTERVAL only re-ask for data the cloud does not have yet.
  const refresh=num(f.refresh_interval,MIN_INTERVAL,UPLOAD_PERIOD),capacity=num(f.battery_capacity_kwh,0.1,16);
  if(refresh===null)return {error:'Refresh interval must be a number'};
  if(capacity===null)return {error:'Battery capacity must be a number'};
  // An empty sound field falls back to the stored path and only then to the file shipped with the
  // project - never to silence, which is what the mute switch is for. Same rule as the token: a form
  // that did not send a field must not be able to erase a hand-edited path, and the only way to get
  // an empty field here at all is to clear one that load() had filled in.
  const sounds={};
  for(const key of ['grid_lost','grid_back']){
    const typed=clean(f[key]),stored=config.Sounds?.[key];
    const rel=typed||stored||SOUND_DEFAULT[key];
    const bad=soundProblem(rel);if(bad)return {error:`${bad}: ${rel}`};
    sounds[key]=typed||(stored?undefined:rel);
  }
  return {config:{Deye:{app_id:appId,app_secret:secret,email,password,station_id:station,base_url:base}},
    // A secret is written only when its field was filled; undefined leaves the stored line alone.
    updates:{Deye:{app_id:appId,app_secret:clean(f.app_secret)||undefined,email,
      password:clean(f.password)||undefined,station_id:station,base_url:base},
      Widget:{refresh_interval:refresh,battery_capacity_kwh:capacity,model:clean(f.model)||'SUN-8K'},
      Sounds:sounds}};
}
// 'Show Widget' only belongs in the tray menu, where it is the discoverable way back from a hidden
// window. In the menu opened from the widget itself the window is visible by definition, so the item
// was a no-op taking the first slot.
// Autostart belongs to the OS, so it is asked and told, never cached here. Unpackaged the entry has
// to name electron.exe plus the project folder: the bare runtime would start with no app to run.
// The portable build unpacks itself into a temp folder, so process.execPath there points at a copy
// that will not exist at the next logon. PORTABLE_EXECUTABLE_FILE is the real EXE the user clicked,
// and it is the only value worth writing into the registry.
function loginOptions(){
  const portable=process.env.PORTABLE_EXECUTABLE_FILE;
  if(portable)return {path:portable};
  return app.isPackaged?{}:{path:process.execPath,args:[path.resolve(app.getAppPath())]};
}
function autostart(){try{return !!app.getLoginItemSettings(loginOptions()).openAtLogin}catch{return false}}
function setAutostart(on){try{app.setLoginItemSettings({...loginOptions(),openAtLogin:!!on})}catch{}menus();}
function makeMenu(fromTray){return Menu.buildFromTemplate([
  ...(fromTray?[{label:'Show Widget',click:()=>{win.show();win.focus()}}]:[]),
  {label:'Large',type:'radio',checked:prefs.mode==='full',click:()=>{prefs.mode='full';applySize()}},
  {label:'Compact',type:'radio',checked:prefs.mode==='compact',click:()=>{prefs.mode='compact';applySize()}},
  {label:'Scale',submenu:SCALE_OPTIONS.map(s=>({label:`${s*100}%`,type:'radio',checked:prefs.scale===s,click:()=>{prefs.scale=s;applySize()}}))},
  {label:'Language',submenu:[
    {label:'English',type:'radio',checked:prefs.lang==='en',click:()=>{prefs.lang='en';broadcast();persist()}},
    {label:'Русский',type:'radio',checked:prefs.lang==='ru',click:()=>{prefs.lang='ru';broadcast();persist()}},
    {label:'Українська',type:'radio',checked:prefs.lang==='uk',click:()=>{prefs.lang='uk';broadcast();persist()}}
  ]},
  // This setting controls stacking immediately, independently of the pin.
  {label:'Always on Top',type:'checkbox',checked:!!prefs.top,click:i=>{prefs.top=i.checked;onTop();persist()}},
  // Also in the menu, not only on the toolbar: a pinned widget refuses to hide, so without a second
  // way out a user who pinned it and forgot the button would have no way to unpin it.
  {label:'Pinned',type:'checkbox',checked:!!prefs.pinned,click:i=>setPinned(i.checked)},
  // A 5-second alert with no off switch is worse than no alert. Stored like the other prefs, so a
  // muted widget stays muted after a restart.
  {label:'Sound',type:'checkbox',checked:!prefs.mute,click:i=>setMute(!i.checked)},
  // Read from Windows every time the menu is built rather than from window.json: the registry entry
  // is the truth, and a stored copy would start lying the moment it is removed by hand or the folder
  // is moved.
  {label:'Start with Windows',type:'checkbox',checked:autostart(),click:i=>setAutostart(i.checked)},
  {type:'separator'}, {label:'Refresh',enabled:!demo,click:()=>poll()},
  {label:'Settings…',click:()=>openSettings()},
  // Kept even though every key is now in the form: hand-editing the file is still the fastest way to
  // fix a bad path, and the form cannot show what a comment in the file says.
  {label:'Open config.ini',click:()=>shell.openPath(configPath)},
  {label:'Hide',click:()=>win.hide()},
  {label:'Exit',click:()=>{quitting=true;app.quit()}}
]);}
function menus(){if(tray)tray.setContextMenu(makeMenu(true));}
// The lock lives in the main process, not in the page: the renderer can be stale or reloaded, and
// the window is moved and hidden from here. setMovable additionally blocks the OS from moving the
// window - the hand-rolled drag below is not the only way it can travel.
// The shell can take a window off the screen without the window hearing about it, so blocking the
// 'minimize' and 'close' events is not enough on its own: while pinned the OUTCOME is watched rather
// than the cause - if the window ended up minimised or hidden, it goes back. This does NOT cover
// Win+D, which leaves the window visible and merely stacks the desktop above it; that is now simply
// what Win+D does to a pinned widget, since pinning no longer overrides "Always on Top".
// Polling is the wrong shape for an event, and it is used anyway because it is the only thing that
// does not depend on guessing which mechanism the shell used this time. 400 ms is below the blink
// threshold for "it came back by itself" while costing nothing measurable.
let keepVisible=null;
function watchVisible(on){
  if(keepVisible){clearInterval(keepVisible);keepVisible=null}
  if(!on)return;
  keepVisible=setInterval(()=>{
    if(!win||win.isDestroyed()||quitting||!prefs.pinned)return;
    if(win.isMinimized())win.restore();
    if(!win.isVisible())win.show();
  },400);
}
// Stacking order is the menu setting and nothing else. Pinning used to force always-on-top, because
// that is the only thing that beats Win+D: with minimising refused the shell raises the desktop ABOVE
// the widget, so the window is never hidden - it is simply behind the desktop, and no amount of
// show()/restore() helps. But a lock against accidental dragging is not a request to cover every
// other window, and taking that decision away from the user was the wrong trade. So Win+D now hides
// a pinned widget like any other window, and "Always on Top" is the one place that decides.
function onTop(){win.setAlwaysOnTop(!!prefs.top);}
// A child of the desktop is positioned in the desktop's client coordinates, whose origin is the
// top-left of the VIRTUAL screen - which is negative as soon as a second monitor sits left of or
// above the primary one. On a single-monitor machine this is (0,0) and the conversion is a no-op;
// computing it anyway is cheaper than discovering it as "the widget jumps when I pin it".
function setPinned(on){
  // The lock: no dragging, hiding or closing while pinned.
  if(!!on!==!!prefs.pinned&&on){prefs.x??=win.getPosition()[0];prefs.y??=win.getPosition()[1]}
  prefs.pinned=!!on;
  win.setMovable(!prefs.pinned);watchVisible(prefs.pinned);onTop();
  // Win+M and "Minimise all" go through none of the paths above. setMinimizable has Windows skip the
  // widget outright; the 'minimize' handler below is the fallback for when it does not, since the
  // event itself cannot be cancelled.
  win.setMinimizable(!prefs.pinned);
  if(prefs.pinned)dragStop();broadcast();persist();menus();}
// Three ways in - the toolbar button, the menu item and the settings form - and one place that
// decides, so they cannot drift apart. Muting also stops the alert already playing: the usual
// reason to reach for it is that one is going off right now.
function setMute(on){prefs.mute=!!on;if(prefs.mute)stopSound();broadcast();persist();menus();
  if(setupWin&&!setupWin.isDestroyed())setupWin.webContents.send('settings:mute',prefs.mute);}
function stopSound(){if(player&&!player.killed)try{player.kill()}catch{}}
// Played in a separate process, not by the page: the renderer can be hidden, reloaded or absent,
// and a grid outage is exactly when the sound matters most. PlaySync blocks that process, not this
// one. The files shipped with the project are 44.1 kHz stereo 24-bit and SoundPlayer accepts them,
// but it only handles plain PCM WAV - an MP3 renamed to .wav fails silently, by design here.
// A second alert interrupts the first instead of overlapping it: grid flapping would otherwise
// stack several players on top of each other.
let player=null;
// The path goes through the environment, not into the command line: a folder name with a quote or a
// dollar sign would otherwise be read as PowerShell syntax.
function play(file){
  const {spawn}=require('node:child_process'); const script='$p = New-Object System.Media.SoundPlayer($env:DEYE_SOUND); $p.PlaySync()';
  stopSound();
  player=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,DEYE_SOUND:file},stdio:'ignore'});player.on('error',()=>{});
}
// A missing file is silence, not an error: the alert is a nice-to-have, and an outage is the worst
// possible moment to pop a dialog. The settings form is where a bad path gets reported.
function sound(grid){if(process.platform!=='win32'||prefs.mute)return;
  const key=grid?'grid_back':'grid_lost',file=soundPath(config.Sounds?.[key]||SOUND_DEFAULT[key]);
  if(!fs.existsSync(file))return;
  play(file);
}
async function poll(){
  if(busy||quitting)return;busy=true;clearTimeout(timer);
  try{config=readConfig();const data=demo?{...DEMO}:await fetchStation(config);
    if(!data.stale){if(lastGrid!==null&&data.grid!==lastGrid)sound(data.grid);lastGrid=data.grid;}
    const now=Date.now();snapshot={data,error:null,loading:false,updatedAt:now};
    // Stale data says nothing about the state, so it must not restart the clock either: an outage
    // that outlives the logger's upload would otherwise look like it had just begun.
    if(!data.stale){clock=stateClock(clock,{state:data.state,now});prefs.clock=clock;persist();}
    schedule=track(schedule,data.sourceTime);
    // Store the state computed in core.cjs, not the raw readings: the chart colours bars by it,
    // and deriving it a second time would let the chart and the status card disagree.
    if(!demo&&!data.stale){history.push({t:now,v:data.load,s:data.state});history=history.filter(p=>p.t>now-86400000).slice(-3000);try{fs.writeFileSync(historyFile,JSON.stringify(history))}catch{}}
  }catch(e){snapshot={...snapshot,loading:false,error:publicError(e)};
    // First run has nothing to poll with. Showing the error alone would leave a new user with no
    // idea where to go, so the form opens itself - once, so a closed window stays closed.
    if(e.needsSetup&&!settingsAutoOpened){settingsAutoOpened=true;openSettings()}}
  finally{busy=false;broadcast();
    if(!quitting)timer=setTimeout(poll,nextDelay({now:Date.now(),...schedule,max:config.Widget?.refresh_interval,jitter})*1000);}
}
if(!app.requestSingleInstanceLock())app.quit();
else{
app.on('second-instance',()=>{win?.show();win?.focus()});
app.whenReady().then(async()=>{
  nativeTheme.themeSource='dark';
  const dir=process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged?path.dirname(process.execPath):path.resolve(__dirname,'..'));
  configPath=path.join(dir,'config.ini');
  if(!fs.existsSync(configPath))fs.writeFileSync(configPath,
    '[Deye]\n; From https://developer.deyecloud.com/ - create an app, then copy its App ID and App Secret.\n'+
    'app_id = YOUR_APP_ID_HERE\napp_secret = YOUR_APP_SECRET_HERE\n'+
    '; The Deye Cloud account you log into in the phone app.\nemail = YOUR_EMAIL_HERE\npassword = YOUR_PASSWORD_HERE\n'+
    'station_id = YOUR_STATION_ID_HERE\n; eu1 / us1 / india\nbase_url = '+DEV_BASE+'\n\n'+
    '[Widget]\nrefresh_interval = 300\nbattery_capacity_kwh = 16\nmodel = SUN-8K\n');
  // Before the first read: the secrets come into memory, and a file carrying them in the clear -
  // hand-edited, or written by a version that had no encryption - is upgraded in place.
  await loadSecrets();
  config=readConfig();stateFile=path.join(app.getPath('userData'),'window.json');historyFile=path.join(app.getPath('userData'),'history.json');
  prefs=readJSON(stateFile,{mode:'full',scale:0.5,top:config.Window?.always_on_top==='true',lang:'en',pinned:false,mute:false});
  prefs.pinned=!!prefs.pinned;prefs.mute=!!prefs.mute;
  clock=prefs.clock&&typeof prefs.clock.state==='string'&&Number.isFinite(prefs.clock.since)?prefs.clock:null;
  if(!['full','compact'].includes(prefs.mode))prefs.mode='full';if(!SCALE_OPTIONS.includes(prefs.scale))prefs.scale=0.5;if(!['en','ru','uk'].includes(prefs.lang))prefs.lang='en';
  history=readJSON(historyFile,[]);if(!Array.isArray(history))history=[];history=history.filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.v)&&p.t>Date.now()-86400000);
  const [w,h]=size();
  // Fully transparent window: the only visible surface is #widget, which does its own glass in CSS.
  // Windows backgroundMaterial:'acrylic' is deliberately NOT used - it fills the whole window rect
  // with an opaque grey material that sticks out around the card's rounded corners.
  win=new BrowserWindow({width:Math.round(w*prefs.scale),height:Math.round(h*prefs.scale),frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,minimizable:!prefs.pinned,fullscreenable:false,skipTaskbar:true,alwaysOnTop:!!prefs.top,movable:!prefs.pinned,show:false,roundedCorners:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  if(Number.isFinite(prefs.x)&&Number.isFinite(prefs.y)&&screen.getAllDisplays().some(d=>prefs.x>=d.workArea.x&&prefs.x<d.workArea.x+d.workArea.width-80&&prefs.y>=d.workArea.y&&prefs.y<d.workArea.y+d.workArea.height-40))win.setPosition(prefs.x,prefs.y);
  win.loadFile(path.join(__dirname,'index.html'));win.once('ready-to-show',()=>{win.show();watchVisible(prefs.pinned);});
  // While dragging, 'moved' fires on every 16 ms step; dragStop persists once at the end instead.
  win.on('moved',()=>{if(dragTimer||prefs.pinned)return;[prefs.x,prefs.y]=win.getPosition();persist()});
  win.on('hide',dragStop);win.on('blur',dragStop);
  // Win+D, "Minimise all" and Win+M all arrive here rather than as a close or a hide. The event is
  // not cancellable, so a pinned widget undoes it: it does vanish for a moment and then comes back.
  win.on('minimize',()=>{if(prefs.pinned&&!quitting){win.restore();win.show()}});
  // Alt+F4 and the taskbar's Close both arrive here. A pinned widget swallows them: 'pinned' is
  // meant to mean "nothing I do by accident removes this from the screen". Exit in the menu still
  // quits, since that sets `quitting` and never reaches this branch.
  win.on('close',e=>{if(!quitting){e.preventDefault();if(!prefs.pinned)win.hide()}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
  // Generated raw RGBA tray icon; no font or external asset dependency. The empty grey ring here is
  // only what is shown before the first reading arrives - updateTray replaces it on every send.
  tray=new Tray(nativeImage.createFromBitmap(trayPixels({soc:null,rgb:[138,151,167]}),{width:32,height:32}));
  tray.setToolTip(demo?'Deye Glass · DEMO':'Deye Glass');tray.on('double-click',()=>win.show());
  // The arc and the number only change with a reading, but the "for 1:23" line in the tooltip is a
  // clock, and Windows re-reads the tooltip text only when it is set. One second is what the widget
  // already ticks at, and setToolTip on an unchanged string costs nothing visible.
  setInterval(()=>{if(!quitting)updateTray()},TRAY_TICK_MS);
  menus();
  ipcMain.on('ready',e=>{if(e.sender===win.webContents)broadcast()});
  ipcMain.on('action',(e,a)=>{
    if(e.sender!==win.webContents)return;
    switch(a){
      case 'drag-start': if(!prefs.pinned)dragStart(); break;
      case 'drag-end':   dragStop(); break;
      case 'menu':       dragStop();menus();makeMenu(false).popup({window:win}); break;
      case 'togglePin':  setPinned(!prefs.pinned); break;
      case 'toggleMute': setMute(!prefs.mute); break;
      case 'hide':       if(!prefs.pinned)win.hide(); break;
      case 'refresh':    poll(); break;
      case 'toggleMode': prefs.mode=prefs.mode==='full'?'compact':'full';applySize();menus(); break;
    }
  });
  // invoke/handle rather than the widget's one-way 'action' channel: the form needs answers back.
  // Every handler checks the sender, so the widget page cannot reach the settings channels.
  const fromSetup=e=>!!setupWin&&!setupWin.isDestroyed()&&e.sender===setupWin.webContents;
  ipcMain.handle('settings:load',e=>fromSetup(e)?settingsPayload():null);
  ipcMain.handle('settings:test',async(e,form)=>{
    if(!fromSetup(e))return {ok:false,error:'Unavailable'};
    const u=settingsUpdate(form);if(u.error)return {ok:false,error:u.error};
    // A session of its own, so testing unsaved credentials cannot replace the token the running
    // widget is polling with - nor leave its own behind if the test fails.
    // publicError, not e.message: the raw error can carry the URL and headers of the failed request.
    try{const d=await fetchStation(u.config,fetch,newSession());return {ok:true,soc:d.soc}}catch(err){return {ok:false,error:publicError(err)}}
  });
  ipcMain.handle('settings:save',async(e,form)=>{
    if(!fromSetup(e))return {ok:false,error:'Unavailable'};
    const u=settingsUpdate(form);if(u.error)return {ok:false,error:u.error};
    // The two secrets are sealed on the way to the file. undefined means the field was left empty,
    // which leaves the stored line untouched - already sealed, so there is nothing to do.
    for(const key of SECRET_KEYS){
      const typed=u.updates.Deye[key];
      if(typed===undefined)continue;
      const sealed=await sealSecret(typed);
      if(sealed===null)return {ok:false,error:'Windows cannot encrypt on this machine, so the secret was not saved'};
      u.updates.Deye[key]=sealed;
      // The cache has to move with the file, or the next poll would still use the old password.
      secrets[key]=typed;
    }
    try{fs.writeFileSync(configPath,writeIni(fs.readFileSync(configPath,'utf8'),u.updates))}
    catch{return {ok:false,error:'Could not write config.ini'}}
    // Re-poll at once so the widget reacts to fixed credentials without a restart.
    config=readConfig();
    // The cached token and the discovered inverter belong to the credentials that are being replaced,
    // so they go with them: otherwise a corrected password would keep failing, or a changed station
    // would keep answering with the old inverter's readings.
    resetSession();
    // Mute is a window preference, not an INI key: it belongs with the other things the menu owns.
    if(typeof form?.mute==='boolean'&&!!form.mute!==!!prefs.mute)setMute(form.mute);
    poll();
    // A changed station means the chart and the day's figures belong to a different plant, so they
    // are refetched rather than left showing the previous one's history.
    refreshHistory();
    return {ok:true};
  });
  // Typing a path by hand is a typo that surfaces during the next outage, so the form offers a
  // picker. The answer is made relative to config.ini when the file sits inside that folder, so the
  // common case stays portable; anything outside stays absolute rather than becoming ../../..
  ipcMain.handle('settings:browse',async e=>{
    if(!fromSetup(e))return null;
    const r=await dialog.showOpenDialog(setupWin,{title:'Deye Glass',properties:['openFile'],
      filters:[{name:'WAV',extensions:['wav']}]});
    const file=r?.canceled?null:r?.filePaths?.[0];if(!file)return null;
    const whole=(()=>{try{return fs.readFileSync(file)}catch{return Buffer.alloc(0)}})();
    const bad=wavProblem(whole.subarray(0,4096),whole.length);
    const root=path.dirname(configPath),rel=path.relative(root,file);
    return {path:rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel.split(path.sep).join('/'):file,error:bad||undefined};
  });
  // Listening to the chosen file is the sound equivalent of 'Test connection': the point is to find
  // out before the file is written, not after. Deliberately plays even while muted - the user asked
  // for this one specifically, unlike an alert that arrives on its own.
  ipcMain.handle('settings:play',(e,rel)=>{
    if(!fromSetup(e))return {ok:false,error:'Unavailable'};
    const file=String(rel||'').trim()||SOUND_DEFAULT.grid_lost;
    const bad=soundProblem(file);if(bad)return {ok:false,error:`${bad}: ${file}`};
    if(process.platform!=='win32')return {ok:false,error:'Sound is Windows only'};
    play(soundPath(file));return {ok:true};
  });
  poll();
  // Backfill once at startup, then hourly. Hourly rather than per-poll because the figures move by
  // minutes and the series costs a request: 24 a day against the ~288 the polling already makes.
  // The retry also heals a chart that grew a hole while the machine slept.
  refreshHistory();
  setInterval(()=>{if(!quitting)refreshHistory()},HISTORY_REFRESH_MS);
}).catch(e=>{dialog.showErrorBox('Deye Glass', 'Failed to start widget. Check folder access and config.ini.\n'+e.message);app.quit()});
app.on('before-quit',()=>{quitting=true;clearTimeout(timer);if(dragTimer){clearInterval(dragTimer);dragTimer=null}watchVisible(false);
  // Otherwise a 5-second alert keeps playing after the widget is gone, with nothing left to stop it.
  stopSound();
  if(setupWin&&!setupWin.isDestroyed())setupWin.destroy();tray?.destroy()});
app.on('window-all-closed',()=>{if(quitting)app.quit()});
}
