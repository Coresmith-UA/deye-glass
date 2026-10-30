const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {parseIni,writeIni,wavProblem,normalizeDevice,deriveState,fetchStation,publicError,nextDelay,learnPeriod,track,stateClock,inferStateSince,trayPixels,
 sha256hex,newSession,credentials,normalizeHistory,fetchHistory,dayStats,startOfDay,CRITICAL_SOC,IDLE_KW,
 UPLOAD_PERIOD,APPEAR_LAG,RETRY,MIN_INTERVAL,GRID_FREQ_MIN,DEV_BASE,HISTORY_POINTS}=require('./core.cjs');
// Minimal valid PCM WAV header, used both to test wavProblem and to answer .wav reads in the mock
// filesystem. Built rather than read from disk so the test does not depend on the shipped files.
function wavHeader(formatTag=1){
 const b=Buffer.alloc(44);b.write('RIFF',0,'latin1');b.writeUInt32LE(36,4);b.write('WAVE',8,'latin1');
 b.write('fmt ',12,'latin1');b.writeUInt32LE(16,16);b.writeUInt16LE(formatTag,20);b.writeUInt16LE(2,22);
 b.writeUInt32LE(44100,24);b.write('data',36,'latin1');b.writeUInt32LE(0,40);return b;
}
const PCM_WAV=wavHeader(1);
// The official API answers with a flat list of the inverter's own measure points, so the fixture is
// built in that shape. The names and the units are the real ones, taken from a live SUN-8K; the
// values mirror the readings the renderer tests were written against (92%, charging at 3.1 kW).
// GridFrequency is what tells the widget the grid is there at all - the measured values are 49.95-50.05
// with the grid up and exactly 0 with it down, which is why the tests use 50 and 0 and nothing between.
const DEVICE_POINTS={SOC:92,BatteryPower:-3100,TotalGridPower:3750,TotalConsumptionPower:490,GridFrequency:50};
// Keys the widget ignores, present so the mapping is proven to pick its five out of a real payload
// rather than out of a list tailored to it.
const DEVICE_NOISE={RatedPower:8000,BatteryVoltage:53.05,'AC Temperature':39.3,UPSLoadPower:490,GridVoltageL1L2:244.2};
function devicePayload(overrides={},{collectionTime=Date.now()/1000}={}){
 const values={...DEVICE_POINTS,...DEVICE_NOISE,...overrides};
 return {deviceSn:'2511121900',collectionTime,
  dataList:Object.entries(values).filter(([,v])=>v!==undefined).map(([key,value])=>({key,value:String(value)}))};
}
// Values arrive as strings from the real API, which devicePayload reproduces, so every one of these
// also pins that the mapping coerces them.
const norm=(overrides,opts)=>normalizeDevice(devicePayload(overrides,opts));
const deviceReply=(overrides,opts)=>({code:'1000000',success:true,deviceDataList:[devicePayload(overrides,opts)]});
test('INI: BOM, Cyrillic, equals signs in tokens, comments',()=>{const c=parseIni('\uFEFF[Deye]\n# comment\ntoken = abc==\nstation_id = 12\n[Widget]\nmodel = Тест');assert.equal(c.Deye.token,'abc==');assert.equal(c.Widget.model,'Тест')});
// Polling faster than the logger uploads returns identical data and only multiplies API calls -
// measured at ~5 min on a live station. These pin the schedule to the data instead of a wall clock.
test('poll schedule aims just past the next expected upload, not at a fixed rate',()=>{
 const now=Date.now(),period=300;
 // A record just seen: wait out the rest of its period plus the delay before the next one surfaces.
 assert.equal(nextDelay({now,sourceTime:now,period,max:600}),period+APPEAR_LAG);
 // Mid-cycle the wait shrinks by exactly the elapsed time, so the phase stays locked to the logger.
 assert.equal(nextDelay({now,sourceTime:now-120000,period,max:600}),period+APPEAR_LAG-120);
 // Overdue: the upload is late. Step back at a fixed retry - nothing makes the cloud answer sooner.
 assert.equal(nextDelay({now,sourceTime:now-900000,period,max:600}),RETRY);
 // Nothing known yet (first run, or an error before any reading) is the same situation.
 assert.equal(nextDelay({now,sourceTime:null,max:600}),RETRY);
});
test('the configured interval caps the wait and can never set a pointless rate',()=>{
 const now=Date.now();
 // The user's value is a ceiling on the wait, so a short one still bounds how stale data can get.
 assert.equal(nextDelay({now,sourceTime:now,period:300,max:120}),120);
 // Below the floor it is not honoured: those extra calls can only re-read a record already held.
 assert.equal(nextDelay({now,sourceTime:now-900000,period:300,max:5}),RETRY);
 assert.ok(nextDelay({now,sourceTime:now,period:300,max:5})<=MIN_INTERVAL);
 assert.equal(nextDelay({now,sourceTime:now,period:300,max:'rubbish'}),UPLOAD_PERIOD,'a broken value falls back, it does not become zero');
 // Several widgets on one station anchor to the same timestamp, so the offset must be per process.
 assert.equal(nextDelay({now,sourceTime:now,period:300,max:600,jitter:17}),300+APPEAR_LAG+17);
});
test('the upload period is learned from consecutive records and ignores implausible gaps',()=>{
 const t=Date.now();
 assert.equal(learnPeriod(t,t+312000,UPLOAD_PERIOD),312,'the measured cadence must replace the guess');
 assert.equal(learnPeriod(null,t,250),250,'the first record is not a gap');
 assert.equal(learnPeriod(t,t,250),250,'the same record twice says nothing about the interval');
 assert.equal(learnPeriod(t+1000,t,250),250,'a record older than the last one is not a gap either');
 // A logger reboot or a clock jump must not strand the schedule hours away.
 assert.equal(learnPeriod(t,t+5000,250),250);
 assert.equal(learnPeriod(t,t+7200000,250),250);
});
// Observed live: the API served lastUpdateTime 00:06:05 and then 00:06:04, a second earlier, with
// different readings. Anchoring on whatever arrived last would walk the schedule backwards.
test('the schedule anchor only moves forward, except on a real clock reset',()=>{
 const t=Date.UTC(2026,9,29,0,6,5),back=t-1000;
 const s=track({sourceTime:t,period:312},back);
 assert.equal(s.sourceTime,t,'a one-second wobble must not move the anchor back');
 assert.equal(s.period,312,'nor must it be mistaken for a cadence sample');
 assert.equal(track({sourceTime:t,period:312},t+312000).sourceTime,t+312000);
 assert.equal(track({sourceTime:t,period:312},t+312000).period,312);
 // A jump back by more than a period is a logger or clock reset: re-anchor, or the schedule stays
 // permanently overdue and retries forever.
 assert.equal(track({sourceTime:t,period:312},t-400000).sourceTime,t-400000);
 assert.equal(track({sourceTime:t,period:312},t-400000).period,312,'a reset is not a measurement');
 assert.equal(track({sourceTime:t,period:312},null).sourceTime,t,'a reading with no timestamp changes nothing');
 assert.equal(track(null,t).sourceTime,t);
});
// The settings form writes this file, and the file is hand-maintained: comments, key order and the
// [Sounds] paths must survive a save. Rendering parseIni's output back to text would not.
const SAMPLE='[Deye]\n# keep me\ntoken = old\nstation_id = 1\n\n[Widget]\nrefresh_interval = 30\n\n[Sounds]\ngrid_lost = sounds/a.wav\n';
test('writeIni replaces values in place and keeps everything it was not asked to change',()=>{
 const out=writeIni(SAMPLE,{Deye:{token:'new',station_id:'7'}});
 assert.match(out,/^\[Deye\]\n# keep me\ntoken = new\nstation_id = 7\n/,'comment, order and spacing around = must survive');
 assert.match(out,/grid_lost = sounds\/a\.wav/,'an untouched section must not be rewritten');
 assert.equal(parseIni(out).Widget.refresh_interval,'30');
});
test('writeIni appends a missing key inside its section and a missing section at the end',()=>{
 const out=writeIni(SAMPLE,{Widget:{model:'SUN-8K'},Window:{always_on_top:'false'}});
 // The key must land above the blank line that separates sections, not below it in [Sounds].
 assert.match(out,/refresh_interval = 30\nmodel = SUN-8K\n\n\[Sounds\]/);
 assert.match(out,/\[Window\]\nalways_on_top = false$/);
 assert.equal(parseIni(out).Widget.model,'SUN-8K');
});
test('writeIni leaves undefined values alone - that is how an empty token field keeps the stored one',()=>{
 const out=writeIni(SAMPLE,{Deye:{token:undefined,station_id:'7'}});
 assert.match(out,/token = old/,'an untyped token must not be erased');
 assert.match(out,/station_id = 7/);
});
test('writeIni preserves the BOM and the file CRLF style',()=>{
 const out=writeIni('﻿[Deye]\r\ntoken = old\r\n',{Deye:{token:'new'}});
 assert.ok(out.startsWith('﻿'),'dropping the BOM changes how other tools read the file');
 assert.equal(out,'﻿[Deye]\r\ntoken = new\r\n');
 assert.ok(!writeIni('[Deye]\ntoken = old\n',{Deye:{token:'new'}}).includes('\r'),'an LF file must stay LF');
 // Letter case of an existing key is kept even when the update spells it differently.
 assert.match(writeIni('[Deye]\nToken = old\n',{Deye:{token:'new'}}),/Token = new/);
});
// SoundPlayer takes plain PCM only and fails silently on anything else, so a renamed MP3 would look
// accepted and then stay quiet during the one outage it was chosen for.
test('wavProblem accepts real PCM WAV and names what is wrong with anything else',()=>{
 assert.equal(wavProblem(PCM_WAV),null);
 // WAVE_FORMAT_EXTENSIBLE is what 24-bit files use - the ones shipped with this project.
 assert.equal(wavProblem(wavHeader(0xfffe)),null,'24-bit extensible WAV does play and must be accepted');
 assert.match(wavProblem(wavHeader(3)),/float/,'a float WAV is a WAV, so say what to do about it');
 assert.match(wavProblem(wavHeader(0x55)),/compressed/);
 // An MP3 renamed to .wav: no RIFF header at all.
 assert.equal(wavProblem(Buffer.alloc(64,0x49)),'Not a WAV file');
 assert.equal(wavProblem(Buffer.alloc(10)),'Not a WAV file','a truncated file is not silently accepted');
 assert.equal(wavProblem(null),'Not a WAV file');
 // The format chunk is not always first: a file carrying LIST metadata before it must still pass.
 const pre=Buffer.alloc(56);PCM_WAV.copy(pre,0,0,12);
 pre.write('LIST',12,'latin1');pre.writeUInt32LE(4,16);pre.write('INFO',20,'latin1');
 PCM_WAV.copy(pre,24,12);
 assert.equal(wavProblem(pre),null,'fmt must be searched for, not assumed at a fixed offset');
 // The bug this check exists for: one of the shipped files had a RIFF size of 1.4 GB for 589 KB of
 // data. Ordinary players ignore the field, SoundPlayer follows it and plays nothing at all.
 assert.equal(wavProblem(PCM_WAV,44),null,'a sound file whose header matches its length is fine');
 assert.match(wavProblem(PCM_WAV,40),/header size/,'a header claiming more bytes than the file has is the silent-playback case');
 const big=Buffer.from(PCM_WAV);big.writeUInt32LE(1424675616,4);
 assert.match(wavProblem(big,589456),/header size/);
 // Real files carry metadata chunks after the RIFF block, so being longer than the field is normal.
 assert.equal(wavProblem(PCM_WAV,44+1612),null,'trailing metadata must not be reported as damage');
 assert.equal(wavProblem(PCM_WAV),null,'without a known length the check is skipped, not guessed');
});
test('charging units and sign match API contract',()=>{const d=norm();assert.equal(d.battery,-3.1);assert.equal(d.load,.49);assert.equal(d.state,'charging')});
test('zero grid consumption does not imply grid outage',()=>assert.equal(norm({BatteryPower:0,TotalGridPower:0}).state,'grid'));
test('grid outage and critical discharge',()=>{assert.equal(norm({GridFrequency:0,BatteryPower:1250}).state,'outage');assert.equal(norm({GridFrequency:0,BatteryPower:1250,SOC:14}).state,'critical')});
// A confirmed grid outage and a battery that is merely draining while the grid is up are
// different situations and must not collapse into one state again.
test('draining on grid is distinct from a grid outage',()=>{
  assert.equal(norm({BatteryPower:1250}).state,'discharging');
  assert.equal(norm({GridFrequency:0,BatteryPower:1250}).state,'outage');
  assert.equal(norm({BatteryPower:200}).state,'grid','small idle draw stays healthy, no colour flicker');
});
test('critical threshold is CRITICAL_SOC and only applies while discharging',()=>{
  const below=CRITICAL_SOC-5, above=CRITICAL_SOC+5;
  assert.equal(norm({SOC:below,BatteryPower:1250}).state,'critical');
  assert.equal(norm({SOC:above,BatteryPower:1250}).state,'discharging');
  assert.equal(norm({SOC:below,BatteryPower:-1250}).state,'charging','recovering, not alarming');
});
// Flow is the physical direction, not the state: it must stay readable against the signed kW in the
// same row, and it must use the same idle band as the state machine so neither flickers alone.
test('flow direction follows the sign of the battery power, with the same idle band',()=>{
  const flow=watts=>norm({BatteryPower:watts}).flow;
  assert.equal(flow(-3100),'in');assert.equal(flow(1250),'out');assert.equal(flow(0),'idle');
  const w=IDLE_KW*1000;
  assert.equal(flow(w),'idle','exactly at the threshold is still noise, not flow');
  assert.equal(flow(-w),'idle');
  assert.equal(flow(w+1),'out');assert.equal(flow(-w-1),'in');
  // A draining battery on a healthy grid is state 'grid' but flow 'out' - that is the whole point
  // of the second field, and the reason it is not derived from the state.
  const d=norm({BatteryPower:200});assert.equal(d.state,'grid');assert.equal(d.flow,'out');
});
test('numeric strings, SOC clamping and the W -> kW conversion',()=>{
 // The API sends every value as a string with its unit in a separate field, so coercion is not
 // optional, and SOC has been seen above 100 on a real station.
 const d=norm({SOC:'105',BatteryPower:'-3100',TotalGridPower:'3750',TotalConsumptionPower:'490'});
 assert.equal(d.soc,100);assert.equal(d.battery,-3.1);assert.equal(d.gridPower,3.75);assert.equal(d.load,.49);
});
test('charging is the negative sign, confirmed against the live inverter',()=>{
 // Read off this inverter's own history rather than assumed: BatteryPower ran negative while the
 // battery charged and to +1446 W while it discharged. Getting this backwards would paint a charging
 // battery as a draining one, so the direction is pinned on both sides.
 assert.equal(norm({BatteryPower:-1250}).flow,'in');
 assert.equal(norm({BatteryPower:-1250}).state,'charging');
 assert.equal(norm({BatteryPower:1446}).flow,'out');
 // The smallest charging sample the station actually recorded was -66 W, which is inside the idle
 // band on purpose: a battery trickling at 66 W is not "charging" worth a colour change.
 assert.equal(norm({BatteryPower:-66}).flow,'idle');
});
test('bad/missing data never becomes a convincing zero reading',()=>{
 // Every one of the five readings the widget maps: absent must raise, never read as a confident zero.
 for(const key of ['SOC','BatteryPower','TotalGridPower','TotalConsumptionPower','GridFrequency'])
   assert.throws(()=>norm({[key]:undefined}),`a missing ${key} must not become a reading`);
 assert.throws(()=>norm({SOC:'broken'}),'and neither must an unparsable one');
 // A payload with no measurements at all is the other shape the cloud can answer with.
 assert.throws(()=>normalizeDevice({collectionTime:Date.now()/1000}));
 assert.throws(()=>normalizeDevice(null));
});
// The old API carried its own network flag; this one does not, so age is the whole staleness test -
// which is what actually matters either way: readings that stopped arriving.
test('readings that stopped arriving are flagged stale by their age',()=>{
 assert.ok(norm({},{collectionTime:(Date.now()-700000)/1000}).stale);
 assert.ok(!norm({},{collectionTime:Date.now()/1000}).stale);
 // Seconds, not milliseconds: the API answers with a 10-digit Unix timestamp.
 const t=1793273384;assert.equal(norm({},{collectionTime:t}).sourceTime,t*1000);
});
test('grid presence is read from the frequency, which is binary in practice',()=>{
 // Measured values: 49.95-50.05 up, exactly 0 down. Both sides of the threshold are pinned so a
 // future edit cannot quietly invert the one signal the outage alarm depends on.
 assert.equal(norm({GridFrequency:49.95,BatteryPower:1250}).state,'discharging');
 assert.equal(norm({GridFrequency:50.05,BatteryPower:1250}).state,'discharging');
 assert.equal(norm({GridFrequency:0,BatteryPower:1250}).state,'outage');
 assert.equal(norm({GridFrequency:GRID_FREQ_MIN+0.1}).grid,true);
 assert.equal(norm({GridFrequency:GRID_FREQ_MIN-0.1}).grid,false);
});
// --- the official API: token, inverter lookup, readings -------------------------------------
// Credentials in the shape config.ini now holds. The password is deliberately different from the app
// secret, so a test can tell which of the two travelled where.
const CRED={app_id:'202610294942036',app_secret:'app-secret-value',email:'user@example.com',
 password:'account-password',station_id:'61908939'};
const cfg=(over={})=>({Deye:{...CRED,...over}});
// A fake API answering the three calls a poll makes, recording each one.
function fakeApi({expires=5183999,token='Bearer eyJ-issued',devices,latest,fail}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  const body=JSON.parse(options.body||'{}');
  calls.push({url,headers:options.headers,body,options});
  const bad=fail&&fail(calls.length,url);
  if(bad)return bad;
  if(url.includes('/account/token'))return {ok:true,json:async()=>({code:'1000000',success:true,accessToken:token,expiresIn:String(expires)})};
  if(url.includes('/station/device'))return {ok:true,json:async()=>devices??({code:'1000000',success:true,deviceListItems:[
    {deviceSn:'3180969441',deviceType:'COLLECTOR'},{deviceSn:'2511121900',deviceType:'INVERTER'},
    {deviceSn:'2511121900M01',deviceType:'BATTERY'}]})};
  if(url.includes('/device/latest'))return {ok:true,json:async()=>latest??deviceReply()};
  assert.fail('unexpected endpoint '+url);
 };
 return {fetcher,calls};
}
test('token: appId goes in the query, the password is hashed, nothing plaintext is sent',async()=>{
 const api=fakeApi();
 await fetchStation(cfg(),api.fetcher,newSession());
 const auth=api.calls[0];
 assert.ok(auth.url.startsWith(DEV_BASE+'/account/token?appId='),'appId is a query parameter, not a body field');
 assert.ok(auth.url.includes(CRED.app_id));
 assert.equal(auth.body.appSecret,CRED.app_secret);
 assert.equal(auth.body.email,CRED.email);
 // The account password must never travel in the clear: the API takes a sha256 of it.
 assert.equal(auth.body.password,sha256hex(CRED.password));
 assert.ok(!JSON.stringify(auth.body).includes(CRED.password),'the plaintext password must not appear in the request');
 assert.equal(auth.headers.Authorization,undefined,'the token call cannot carry a token');
 assert.equal(auth.options.redirect,'error');
});
test('token: the scheme inside the value is stripped, so no header reads Bearer Bearer',async()=>{
 const api=fakeApi({token:'Bearer eyJ-abc'});
 await fetchStation(cfg(),api.fetcher,newSession());
 assert.equal(api.calls.at(-1).headers.Authorization,'Bearer eyJ-abc');
});
test('token: fetched once and reused, renewed a day before it expires',async()=>{
 const session=newSession(),api=fakeApi();
 await fetchStation(cfg(),api.fetcher,session);
 assert.deepEqual(api.calls.map(c=>c.url.split('?')[0].replace(DEV_BASE,'')),
  ['/account/token','/station/device','/device/latest'],'a first poll authenticates and finds the inverter');
 await fetchStation(cfg(),api.fetcher,session);
 assert.equal(api.calls.length,4,'a second poll is one request: the token and the inverter are cached');
 assert.equal(api.calls.at(-1).url.replace(DEV_BASE,''),'/device/latest');
 // 60 days minus the one-day margin. The point of this whole path is that it never expires in use.
 const days=(session.expiresAt-Date.now())/86400000;
 assert.ok(days>58.9&&days<59.1,'renews a day early, got '+days);
 session.expiresAt=Date.now()-1;
 await fetchStation(cfg(),api.fetcher,session);
 assert.ok(api.calls.at(-2).url.includes('/account/token'),'an expired token is replaced without being asked');
});
test('token: a revoked token is retried once with a fresh one, not left to rot',async()=>{
 let refused=false;
 const api=fakeApi({fail:(n,url)=>{
  if(url.includes('/device/latest')&&!refused){refused=true;return {ok:false,status:401}}
  return null;}});
 const d=await fetchStation(cfg(),api.fetcher,newSession());
 assert.equal(d.soc,92,'the poll still succeeds');
 assert.equal(api.calls.filter(c=>c.url.includes('/account/token')).length,2,
  'it re-authenticated instead of returning an error');
});
test('inverter lookup: the INVERTER is picked out of the station and remembered',async()=>{
 const session=newSession(),api=fakeApi();
 await fetchStation(cfg(),api.fetcher,session);
 const lookup=api.calls.find(c=>c.url.includes('/station/device'));
 assert.deepEqual(lookup.body.stationIds,[61908939],'the station id is sent as a number');
 assert.equal(session.sn,'2511121900','the collector and the batteries are not the inverter');
 assert.deepEqual(api.calls.at(-1).body.deviceList,['2511121900']);
 // Changing the station must re-discover: the remembered inverter belongs to the old one.
 await fetchStation(cfg({station_id:'62406003'}),api.fetcher,session);
 assert.ok(api.calls.at(-2).url.includes('/station/device'),'a different station is looked up again');
});
test('inverter lookup: a station with no inverter says so instead of failing obscurely',async()=>{
 const api=fakeApi({devices:{code:'1000000',success:true,deviceListItems:[{deviceSn:'x',deviceType:'COLLECTOR'}]}});
 await assert.rejects(fetchStation(cfg(),api.fetcher,newSession()),
  e=>publicError(e)==='No inverter on that station - check the Station ID');
});
test('readings: the five measure points are mapped out of a full payload',async()=>{
 const api=fakeApi();
 const d=await fetchStation(cfg(),api.fetcher,newSession());
 assert.equal(d.soc,92);assert.equal(d.battery,-3.1);assert.equal(d.gridPower,3.75);
 assert.equal(d.load,.49);assert.equal(d.grid,true);assert.equal(d.state,'charging');
});
test('errors are safe to show and never carry a credential',async()=>{
 const fails=[
  [{ok:false,status:401},'Credentials rejected - check them in Settings'],
  [{ok:false,status:429},'Deye Cloud rate limit reached - retrying later'],
  [{ok:false,status:500},'API error: HTTP 500'],
  // The API answers HTTP 200 with the real status inside the body, so the code is what counts.
  [{ok:true,json:async()=>({code:'2101017',msg:'token invalid'})},'Credentials rejected - check them in Settings'],
  [{ok:true,json:async()=>({code:'2101008',msg:'invalid param type'})},'Deye Cloud: invalid param type'],
 ];
 for(const [reply,message] of fails){
  const api=fakeApi({fail:()=>reply});
  const e=await fetchStation(cfg(),api.fetcher,newSession()).catch(x=>x);
  assert.equal(publicError(e),message);
  assert.ok(!publicError(e).includes(CRED.app_secret)&&!publicError(e).includes(CRED.password));
 }
 // An error with no public message of its own must not leak whatever it does carry.
 assert.equal(publicError(new Error('app_secret=app-secret-value')),'No connection to Deye Cloud');
});
test('missing credentials and an insecure endpoint are refused before anything is sent',async()=>{
 const noFetch=()=>assert.fail('fetch must not run');
 for(const key of ['app_id','app_secret','email','password','station_id']){
  const broken=cfg();delete broken.Deye[key];
  const e=await fetchStation(broken,noFetch).catch(x=>x);
  assert.equal(e.needsSetup,true,'a missing '+key+' must open Settings, not just fail');
 }
 // The template the first run writes must not look like credentials.
 await assert.rejects(fetchStation(cfg({app_secret:'YOUR_APP_SECRET_HERE'}),noFetch),e=>e.needsSetup===true);
 await assert.rejects(fetchStation(cfg({base_url:'http://eu1-developer.deyecloud.com/v1.0'}),noFetch),
  e=>publicError(e)==='API requires HTTPS');
});
// --- history and the day's figures -----------------------------------------------------------
// The history payload nests differently from a live reading: the timestamp is on the row, the
// readings in an itemList under it. Built in that shape, with the real key names.
function historyReply(rows){
 return {code:'1000000',success:true,deviceSn:'2511121900',
  dataList:rows.map(([t,over={}])=>{
   const values={...DEVICE_POINTS,...over};
   return {time:String(Math.floor(t/1000)),
    itemList:HISTORY_POINTS.filter(k=>values[k]!==undefined).map(k=>({key:k,value:String(values[k]),unit:''}))};
  })};
}
test('history: rows become points, and a bar from history matches a bar from a live poll',()=>{
 const t=1793276194000;
 const pts=normalizeHistory(historyReply([[t,{GridFrequency:0,BatteryPower:1250}]]));
 assert.equal(pts.length,1);
 // The state must come out of the shared derivation, or the chart and the card disagree on colour.
 assert.equal(pts[0].state,'outage');assert.equal(pts[0].grid,false);
 assert.equal(pts[0].t,t,'the row timestamp is in seconds and has to be widened to ms');
 assert.equal(pts[0].load,.49);assert.equal(pts[0].battery,1.25);
 const live=norm({GridFrequency:0,BatteryPower:1250});
 for(const k of ['soc','battery','grid','gridPower','load','flow','state'])
   assert.equal(pts[0][k],live[k],`history and live must agree on ${k}`);
});
test('history: unusable rows are dropped, not patched, and the order is made true',()=>{
 const base=1793200000000;
 const reply=historyReply([[base+2000],[base+1000]]);
 // A row short of any of the five readings cannot be drawn honestly, so it goes.
 reply.dataList.push({time:String(base/1000+3),itemList:[{key:'SOC',value:'50'}]});
 reply.dataList.push({time:'not-a-number',itemList:[]});
 const pts=normalizeHistory(reply);
 assert.equal(pts.length,2,'only the two complete rows survive');
 assert.ok(pts[0].t<pts[1].t,'and they come back in time order whatever order they arrived in');
 assert.deepEqual(normalizeHistory({}),[],'an empty or missing payload is no points, not a throw');
});
test('day figures: durations are integrated from the samples and always add up to the window',()=>{
 const step=300000,from=1793224800000;
 // Each sample is spelled out by the state it should produce, so the test does not depend on what
 // the default fixture happens to be.
 const AS={grid:{BatteryPower:0,TotalGridPower:0},charging:{BatteryPower:-3100},
   discharging:{BatteryPower:1250},outage:{GridFrequency:0,BatteryPower:1250}};
 const order=['grid','grid','outage','outage','charging','discharging'];
 const pts=normalizeHistory(historyReply(order.map((name,i)=>[from+i*step,AS[name]])));
 assert.deepEqual(pts.map(p=>p.state),order,'the fixture produces the states the test is about');
 const to=from+6*step;
 const st=dayStats(pts,{from,to});
 assert.equal(st.states.grid,2*step);
 assert.equal(st.states.outage,2*step,'two intervals of grid absent');
 assert.equal(st.states.charging,step);
 // The last sample has no successor, so it is credited up to the end of the window - otherwise the
 // state the station is in right now would be missing from the figures.
 assert.equal(st.states.discharging,step,'the final sample runs to the end of the window');
 assert.equal(st.withoutGrid,2*step);
 assert.equal(st.withGrid,4*step,'charging and discharging both happened with the grid there');
 assert.equal(st.charging,step,'the charging figure is the time the battery was taking energy in');
 assert.equal(st.onBattery,step,'and onBattery is the time the grid was there but the battery paid');
 assert.equal(st.unknown,0);
 assert.equal(st.samples,6);
 assert.equal(st.withGrid+st.withoutGrid+st.unknown,to-from,
  'with-grid, without-grid and unknown must account for the whole window or the figures lie');
});
// The state machine tests 'critical' before 'outage', so a flat battery during a blackout is
// labelled 'critical'. Counting state names would then file that blackout under "the grid was
// there". This is the test that stops that from coming back.
test('day figures: a blackout with a flat battery still counts as time without the grid',()=>{
 const step=300000,from=1793224800000;
 // soc below CRITICAL_SOC, discharging, grid absent: the state is 'critical', the grid is not there.
 const flat={GridFrequency:0,BatteryPower:1250,SOC:14};
 const pts=normalizeHistory(historyReply([[from,flat],[from+step,flat]]));
 assert.deepEqual(pts.map(p=>p.state),['critical','critical'],'the state really is critical here');
 assert.equal(pts[0].grid,false,'while the grid reading says the grid is gone');
 const st=dayStats(pts,{from,to:from+2*step});
 assert.equal(st.withoutGrid,2*step,'a blackout is a blackout whatever the battery was doing');
 assert.equal(st.withGrid,0,'and none of it may be reported as time with the grid');
 assert.equal(st.onBattery,0,'onBattery means the grid was there and unused - not a blackout');
 assert.equal(st.states.critical,2*step);
});
test('day figures: a hole in the data is reported as unknown, never as a long steady state',()=>{
 const from=1793224800000,step=300000,ON={BatteryPower:0,TotalGridPower:0};
 // Two samples, then a four-hour gap, then two more: the gap is not four hours of "grid fine".
 const pts=normalizeHistory(historyReply([[from,ON],[from+step,ON],
   [from+step+4*3600000,ON],[from+step+4*3600000+step,ON]]));
 const to=from+step+4*3600000+2*step;
 const st=dayStats(pts,{from,to,maxGap:1800000});
 assert.equal(st.unknown,4*3600000,'the gap is time nobody watched');
 assert.equal(st.withGrid,3*step);
 assert.equal(st.withGrid+st.unknown,to-from);
 // Samples outside the window are not counted at all - "today" means today.
 const outside=dayStats(pts,{from:to,to:to+step});
 assert.equal(outside.samples,0);assert.equal(outside.unknown,step);
});
test('day figures: the window is local midnight, not UTC and not 24 hours ago',()=>{
 const noon=new Date(2026,9,29,12,34,56).getTime();
 const start=startOfDay(noon);
 const d=new Date(start);
 assert.equal(d.getHours(),0);assert.equal(d.getMinutes(),0);assert.equal(d.getSeconds(),0);
 assert.equal(d.getDate(),29);
 assert.ok(noon-start>0&&noon-start<86400000);
});
test('history: one request carries the whole window, with all five measure points',async()=>{
 const session=newSession();
 const now=1793276194000;
 const api=fakeApi();
 // The history endpoint is not one fakeApi answers by default, so it is added here.
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body||'{}')});
  if(url.includes('/device/historyRaw'))return {ok:true,json:async()=>historyReply([[now-600000,{}],[now,{}]])};
  return api.fetcher(url,options);
 };
 const pts=await fetchHistory(cfg(),fetcher,session,{from:now-86400000,to:now});
 assert.equal(pts.length,2);
 const hist=calls.find(c=>c.url.includes('/device/historyRaw'));
 assert.deepEqual(hist.body.measurePoints,HISTORY_POINTS);
 assert.equal(hist.body.measurePoints.length,5,'five is the most the API accepts in one call');
 assert.deepEqual(hist.body.deviceSn,'2511121900','the inverter is reused, not looked up again per call');
 // Timestamps go out in seconds, which is what the endpoint documents.
 assert.equal(hist.body.startTimestamp,Math.floor((now-86400000)/1000));
 assert.equal(hist.body.endTimestamp,Math.floor(now/1000));
});
test('a base_url left over from the old internal API is not used',()=>{
 // The widget used to talk to eu1.deyecloud.com, where none of these endpoints exist. Keeping that
 // host would look like a dead API; falling back to the developer default is the honest behaviour.
 assert.equal(credentials(cfg({base_url:'https://eu1.deyecloud.com'})).base,DEV_BASE);
 assert.equal(credentials(cfg({base_url:''})).base,DEV_BASE);
 // A real region is kept, with or without a trailing slash.
 assert.equal(credentials(cfg({base_url:'https://us1-developer.deyecloud.com/v1.0/'})).base,
  'https://us1-developer.deyecloud.com/v1.0');
});
// Run the actual inline renderer JS against a minimal DOM contract. This checks state
// mapping and output, NOT browser layout, fonts, CSS or desktop integration.
function renderer(){const elements=new Map();function element(s){if(!elements.has(s)){
  // classList and className share one Set so that assigning className resets the tracked classes,
  // exactly as in the browser - the renderer does both on every frame.
  const el={textContent:'',style:{setProperty(k,v){this[k]=v}},dataset:{},setAttribute(k,v){this[k]=v},replaceChildren(){this.children=[]},append(v){(this.children??=[]).push(v)},addEventListener(){}};
  let classes=new Set();
  Object.defineProperty(el,'className',{get:()=>[...classes].join(' '),set:v=>{classes=new Set(String(v).split(/\s+/).filter(Boolean))}});
  el.classList={add:(...c)=>c.forEach(x=>classes.add(x)),toggle:(c,on)=>{on?classes.add(c):classes.delete(c)},contains:c=>classes.has(c)};
  elements.set(s,el);}return elements.get(s)}
 const context={document:{querySelector:element,querySelectorAll:s=>[element(s)],createElement:()=>element('created-'+Math.random()),addEventListener(){}},window:{deye:{subscribe:cb=>context.receive=cb,action(){}}},Date,URLSearchParams,setInterval(){},console};vm.createContext(context);const html=fs.readFileSync(__dirname+'/index.html','utf8');vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);return {receive:context.receive,element};}
test('actual renderer: real startup shows no fake SOC; live data, modes, offline retain last known values',()=>{const r=renderer();r.receive({data:null,loading:true,mode:'full'});assert.equal(r.element('#soc').textContent,'—');for(const mode of ['full','compact']){r.receive({data:norm(),mode,capacity:16});assert.equal(r.element('#battery').textContent,'-3.10');assert.equal(r.element('#energy').textContent,'14.7');assert.equal(r.element('#widget').style['--progress'],'92%')}
 r.receive({data:norm(),mode:'full',error:'No connection'});assert.equal(r.element('#connection').textContent,'No connection');assert.equal(r.element('#soc').textContent,92);
});
test('renderer: SOC 0,1,50,100, critical and stale states',()=>{const r=renderer();for(const soc of [0,1,50,100]){r.receive({data:norm({SOC:soc}),mode:'compact'});assert.equal(r.element('#widget').style['--p2'],`${soc*.78}%`)}r.receive({data:norm({BatteryPower:1250,SOC:14}),mode:'full'});assert.equal(r.element('.status-title').textContent,'LOW BATTERY');r.receive({data:norm({},{collectionTime:(Date.now()-700000)/1000}),mode:'compact'});assert.equal(r.element('.status-name').textContent,'DATA STALE')});
// The original bug: .grid and .charging had no CSS theme, so they silently inherited a hardcoded
// amber and "GRID ONLINE" rendered yellow. This fails if a state ever loses its colour again.
test('every state core.cjs can emit has its own CSS theme',()=>{
 const css=fs.readFileSync(__dirname+'/index.html','utf8');const states=new Set();
 for(const SOC of [10,50]) for(const BatteryPower of [-1250,0,200,1250]) for(const GridFrequency of [50,0])
   states.add(norm({SOC,BatteryPower,GridFrequency}).state);
 assert.deepEqual([...states].sort(),['charging','critical','discharging','grid','outage']);
 for(const s of states){
   assert.match(css,new RegExp(`\\.${s}\\{--accent:`),`state ${s} has no colour theme`);
   assert.match(css,new RegExp(`\\.bar\\.s-${s}[,{]`),`state ${s} has no bar colour, its bars would be unstyled`);
   assert.match(css,new RegExp(`${s}:'`),`state ${s} has no label in the English dictionary`);
 }
 // The hint next to BATTERY was hardcoded amber, the same bug class as the yellow GRID ONLINE.
 const hint=css.match(/\.power-hint\{([^}]*)\}/)[1];
 assert.match(hint,/color:var\(--accent\)/,'the battery hint must take its colour from the theme');
 assert.doesNotMatch(hint,/#[0-9a-f]{3,8}/i,'no colour literal belongs in .power-hint');
});
// The status card used to have 4px above it and 11px below. One token now feeds both, so the two
// gaps cannot drift apart again by editing only one of them.
test('the gaps above and below the status card come from one token',()=>{
 const css=fs.readFileSync(__dirname+'/index.html','utf8');
 assert.match(css,/\.right\{[^}]*--card-gap:\d+px/,'--card-gap must be declared on the column that owns both gaps');
 assert.match(css,/\.right\{[^}]*top:calc\([^)]*var\(--card-gap\)\)/,'the gap above the card must use the token');
 assert.match(css,/\.metrics\{margin-top:var\(--card-gap\)\}/,'the gap below the card must use the same token');
});
// Three digits do not fit the hole in the ring: measured in Segoe UI, '100%' is 120px of text in a
// 111px opening (compact) and 241 in 230 (large), which is why it was sitting on the ring itself.
test('renderer: a three-digit SOC steps down a size so it stays inside the ring',()=>{
 const r=renderer();
 r.receive({data:norm({SOC:92}),mode:'compact'});
 assert.ok(!r.element('.soc').classList.contains('wide'),'two digits fit as they are');
 r.receive({data:norm({SOC:100}),mode:'compact'});
 assert.ok(r.element('.soc').classList.contains('wide'));
 // And back: a widget that reached 100% once must not keep the smaller number forever.
 r.receive({data:norm({SOC:99.6}),mode:'full'});
 assert.equal(r.element('#soc').textContent,100,'the rounded value is what is shown, so it drives the step');
 assert.ok(r.element('.soc').classList.contains('wide'));
 r.receive({data:norm({SOC:7}),mode:'full'});
 assert.ok(!r.element('.soc').classList.contains('wide'));
 r.receive({data:null,loading:true,mode:'compact'});
 assert.ok(!r.element('.soc').classList.contains('wide'),'the placeholder dash is not three digits');
});
test('renderer: each state lands on the widget as a class and a localised title',()=>{const r=renderer();
 const cases={grid:{BatteryPower:0,TotalGridPower:0},discharging:{BatteryPower:1250},charging:{},
   outage:{GridFrequency:0,BatteryPower:1250},critical:{GridFrequency:0,BatteryPower:1250,SOC:14}};
 const titles={grid:'GRID ONLINE',discharging:'ON BATTERY',charging:'CHARGING',outage:'GRID OUTAGE',critical:'LOW BATTERY'};
 for(const [state,patch] of Object.entries(cases)){
   r.receive({data:norm({...patch}),mode:'full',lang:'en'});
   assert.ok(r.element('#widget').classList.contains(state),`#widget must carry class ${state}`);
   assert.equal(r.element('.status-title').textContent,titles[state]);
 }
});
// The hint next to BATTERY used to carry the same glyph as the status card, so it duplicated the
// card and explained nothing. It now shows the flow direction and says so in words.
test('renderer: the battery hint shows the flow direction and is labelled',()=>{const r=renderer();
 const cases={in:-3100,out:1250,idle:0};
 const titles={in:'Charging',out:'Discharging',idle:'Battery idle'};
 for(const [flow,watts] of Object.entries(cases)){
   r.receive({data:norm({BatteryPower:watts}),mode:'full',lang:'en'});
   assert.equal(r.element('#power-symbol').href,'#i-flow-'+flow);
   assert.equal(r.element('.power-hint').title,titles[flow],`flow ${flow} has no tooltip`);
   assert.equal(r.element('.power-hint')['aria-label'],titles[flow],`flow ${flow} is unlabelled for a screen reader`);
 }
 r.receive({data:null,loading:true,mode:'full',lang:'en'});
 assert.equal(r.element('#power-symbol').href,'#i-flow-idle','an unknown flow must not be drawn as a direction');
});
test('renderer: the pin button reflects the lock held by the main process and says what it does',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'ru',pinned:false});
 assert.equal(r.element('#pin')['aria-pressed'],'false');
 assert.match(r.element('#pin').title,/^Закрепить/,'the label must say what pressing it will do');
 assert.ok(!r.element('#widget').classList.contains('pinned'));
 r.receive({data:norm(),mode:'full',lang:'ru',pinned:true});
 assert.equal(r.element('#pin')['aria-pressed'],'true','aria-pressed is both the state and the CSS hook');
 assert.match(r.element('#pin').title,/^Открепить/);
 assert.equal(r.element('#pin')['aria-label'],r.element('#pin').title);
 assert.ok(r.element('#widget').classList.contains('pinned'));
});
// The muted state is carried by a different glyph, not by a filled background: a highlighted button
// would read as "sound is on" at exactly the moment it means the opposite.
test('renderer: the mute button swaps the glyph rather than relying on a highlight',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'ru',mute:false});
 assert.equal(r.element('#mute')['aria-pressed'],'false');
 assert.equal(r.element('#mute-symbol').href,'#i-sound');
 assert.match(r.element('#mute').title,/^Выключить/,'the label must say what pressing it will do');
 r.receive({data:norm(),mode:'full',lang:'ru',mute:true});
 assert.equal(r.element('#mute')['aria-pressed'],'true');
 assert.equal(r.element('#mute-symbol').href,'#i-sound-off','the crossed speaker is the state');
 assert.match(r.element('#mute').title,/^Включить/);
 assert.equal(r.element('#mute')['aria-label'],r.element('#mute').title);
});
test('renderer: the hint and the status icon are no longer the same glyph',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en'});
 assert.equal(r.element('#status-symbol').href,'#i-bolt','the status card still marks charging with a bolt');
 assert.equal(r.element('#power-symbol').href,'#i-flow-in','the battery row answers a different question');
});
// The 24h strip used to colour bars by height/max, so the same load was grey one day and amber
// the next. Colour now means the state; these pin that down, including the bins nothing fills.
const binAt=i=>Date.now()-86400000+(i+.5)*86400000/64;
test('chart: colour is the state, height is the load against the day max',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en',history:[
   {t:binAt(10),v:.5,s:'grid'},{t:binAt(20),v:2,s:'outage'},{t:binAt(30),v:1,s:'discharging'}]});
 const bars=r.element('.bars').children;assert.equal(bars.length,64);
 assert.ok(bars[10].classList.contains('s-grid'));
 assert.ok(bars[20].classList.contains('s-outage'));
 assert.ok(bars[30].classList.contains('s-discharging'));
 assert.ok(bars[0].classList.contains('s-none'),'a bin with no polls must read as absent');
 assert.equal(bars[20].style.height,'48px','the day max fills the strip');
 assert.equal(bars[10].style.height,'12px','0.5 kW against a 2 kW max');
 assert.match(r.element('.chart-label').textContent,/^2\.0 kW/,'the label carries the scale');
});
test('chart: the worst state in a bin wins',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en',history:[
   {t:binAt(5),v:1,s:'grid'},{t:binAt(5),v:1,s:'outage'},{t:binAt(5),v:1,s:'grid'},
   {t:binAt(6),v:1,s:'discharging'},{t:binAt(6),v:1,s:'critical'}]});
 const bars=r.element('.bars').children;
 assert.ok(bars[5].classList.contains('s-outage'),'a short outage must not dissolve into its bin');
 assert.ok(bars[6].classList.contains('s-critical'));
});
test('chart: history written before states were stored still renders',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en',history:[{t:binAt(8),v:1.5}]});
 const bar=r.element('.bars').children[8];
 assert.ok(bar.classList.contains('s-unknown'),'a legacy record keeps its height but has no colour');
 assert.ok(!bar.classList.contains('s-none'),'it is data, not a gap');
 assert.equal(bar.style.height,'48px');
});
test('chart: an empty history promises no scale',()=>{const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en',history:[]});
 const kids=r.element('.bars').children;assert.equal(kids.length,1);
 assert.ok(kids[0].classList.contains('empty-chart'));
 assert.equal(r.element('.chart-label').textContent,'24h','no max is known, so none is shown');
});
test('preload passes through only whitelisted actions',()=>{
 let api;const sent=[];
 const ctx={require:()=>({contextBridge:{exposeInMainWorld:(_n,a)=>{api=a}},ipcRenderer:{on(){},send:(_c,n)=>sent.push(n)}})};
 vm.runInNewContext(fs.readFileSync(__dirname+'/preload.cjs','utf8'),ctx);
 const allowed=['menu','hide','refresh','toggleMode','togglePin','drag-start','drag-end'];
 allowed.forEach(n=>api.action(n));assert.deepEqual(sent,allowed);
 sent.length=0;['quit','','drag','../x',undefined].forEach(n=>api.action(n));assert.deepEqual(sent,[],'unknown names must not reach the main process');
});
test('the settings preload exposes only the settings channels and cannot read the token',()=>{
 let api;const invoked=[];
 const ctx={require:()=>({contextBridge:{exposeInMainWorld:(_n,a)=>{api=a}},ipcRenderer:{invoke:(c,a)=>{invoked.push([c,a]);return Promise.resolve()}}})};
 vm.runInNewContext(fs.readFileSync(__dirname+'/preload-settings.cjs','utf8'),ctx);
 assert.deepEqual(Object.keys(api).sort(),['browse','load','onMute','play','save','test']);
 api.load();api.test({station_id:'1'});api.save({station_id:'1'});api.browse();api.play('x.wav');
 assert.deepEqual(invoked.map(([c])=>c),['settings:load','settings:test','settings:save','settings:browse','settings:play']);
 // Nothing here reads anything back out of the main process except through these calls, and none of
 // them is a generic 'invoke' escape hatch.
 assert.equal(typeof api.invoke,'undefined');
});
// The form is run the same way as index.html: real script, mock DOM. This checks the wiring, not
// the layout - in particular that the token field is never filled from the payload.
test('settings form: load fills the fields and says the secrets are saved without showing them',async()=>{
 const html=fs.readFileSync(__dirname+'/settings.html','utf8');
 // The credit is markup, not a dictionary entry: it must not be translated and must not land in the
 // status area, which belongs to the answer from Test connection and Save.
 assert.match(html,/Developed by Coresmith/);
 assert.ok(!/Coresmith/.test(html.split('<script>')[1]||''),'the signature is static text, not a localized string');
 // dataset is part of the contract here: the browse and play buttons name their field with data-for
 // rather than each having its own handler.
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',placeholder:'',textContent:'',className:'',disabled:false,
   checked:false,dataset:{for:id.replace(/^(browse|play)_/,m=>'grid_')},
   addEventListener(_e,fn){this.click=fn}});return nodes.get(id)};
 const saved=[],played=[];let browse={path:'sounds/chosen.wav'},muteHook=null;
 const ctx={document:{getElementById:byId,documentElement:{}},
  window:{setup:{load:async()=>({hasSecret:true,hasPassword:true,app_id:'202610294942036',email:'user@example.com',
    station_id:'61',base_url:'',refresh_interval:'30',battery_capacity_kwh:'16',model:'SUN-8K',lang:'ru',
    grid_lost:'sounds/grid_lost.wav',grid_back:'sounds/grid_back.wav',mute:false}),
   test:async()=>({ok:true,soc:100}),save:async f=>{saved.push(f);return {ok:true}},
   browse:async()=>browse,play:async f=>{played.push(f);return {ok:true}},
   onMute:fn=>{muteHook=fn}}},console};
 ctx.window.document=ctx.document;vm.createContext(ctx);
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(byId('station_id').value,'61');assert.equal(byId('model').value,'SUN-8K');
 // Identifiers come back and are shown; the two secrets never do.
 assert.equal(byId('app_id').value,'202610294942036');assert.equal(byId('email').value,'user@example.com');
 for(const f of ['app_secret','password']){
   assert.equal(byId(f).value,'',`a stored ${f} is not sent here, so the field stays empty`);
   assert.match(byId(f).placeholder,/сохранён/,`the field must say a ${f} exists, in the widget's language`);
 }
 assert.equal(byId('t-title').textContent,'Настройки');
 await byId('save').click();
 assert.equal(saved[0].station_id,'61');
 for(const f of ['app_secret','password'])
   assert.equal(byId(f).value,'',`a typed ${f} must not be left on the page after saving`);
 await byId('test').click();
 assert.match(byId('status').textContent,/100%/);assert.equal(byId('status').className,'ok');
 // Sound wiring: the paths are filled from the payload, the checkbox is the inverse of mute, and
 // the picker writes into the field named by data-for.
 assert.equal(byId('grid_lost').value,'sounds/grid_lost.wav');
 assert.equal(byId('sound_on').checked,true,'the checkbox asks about sound, the setting stores mute');
 await byId('browse_lost').click();
 assert.equal(byId('grid_lost').value,'sounds/chosen.wav');
 // A file that cannot be played is still filled in, with the reason shown, so it can be corrected
 // rather than silently dropped.
 browse={path:'sounds/bad.wav',error:'WAV is float, not PCM - convert it'};
 await byId('browse_back').click();
 assert.equal(byId('grid_back').value,'sounds/bad.wav');
 assert.match(byId('status').textContent,/float/);assert.equal(byId('status').className,'bad');
 await byId('play_lost').click();
 assert.deepEqual(played,['sounds/chosen.wav'],'play must send the field it belongs to');
 byId('sound_on').checked=false;await byId('save').click();
 assert.equal(saved.at(-1).mute,true,'unchecking the box must save as muted');
 assert.equal(saved.at(-1).grid_lost,'sounds/chosen.wav');
 // Muting from the toolbar or the menu while the window is open must update the box.
 muteHook(true);assert.equal(byId('sound_on').checked,false);
 muteHook(false);assert.equal(byId('sound_on').checked,true);
});
// main.cjs is run in a vm against a mock Electron. The harness is shared by the tests below so
// the settings channels are exercised against the same startup path as the widget itself.
async function desktop({ini='[Deye]\napp_id = 1\napp_secret = s\nemail = e@x.co\npassword = p\nstation_id = 1',station=async()=>norm(),history=async()=>[],env={},state=null}={}){
 const {EventEmitter}=require('node:events');const app=new EventEmitter();app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();app.getPath=()=>'/test';app.quit=()=>{};
 // Autostart lives in the OS, so the mock plays the part of the registry: what was set is what is
 // read back, including the launcher path, which is what makes an unpackaged entry work at all.
 app.isPackaged=false;app.getAppPath=()=>'C:/project/electron';let login={openAtLogin:false};
 app.getLoginItemSettings=options=>({...login,options});app.setLoginItemSettings=v=>{login=v};
 // ipcMain in the real Electron keeps invoke handlers in a separate map from 'on' listeners; the
 // mock needs the same split so the settings channels can be called directly below.
 const ipcMain=new EventEmitter();const handlers=new Map();ipcMain.handle=(ch,fn)=>handlers.set(ch,fn);
 let window, windows=[], menuItems, trayMenu, cursor={x:100,y:100}, dragTick=null, nextTimer=1;const timers=new Map();class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.sent=[];this.webContents.send=(c,d)=>this.webContents.sent.push([c,d]);this.webContents.setWindowOpenHandler=()=>{};this.webContents.executeJavaScript=async()=>640;windows.push(this);
  // Only the first window is the widget. Letting the settings window overwrite `window` would
  // silently repoint every assertion below at the dialog.
  window??=this;}setMenuBarVisibility(){}destroy(){this.destroyed=true}setSize(w,h){assert.equal(this.resizable,true,'setSize must run while the window is resizable');this.size=[w,h]}setResizable(v){this.resizable=v}setPosition(x,y){(this.moved??=[]).push([x,y])}loadFile(p){this.file=p}show(){this.shown=true;this.hidden=false}focus(){}hide(){this.hidden=true}setMovable(v){this.movable=v}setMinimizable(v){this.minimizable=v}restore(){this.restored=true;this.minimized=false}isDestroyed(){return !!this.destroyed}isVisible(){return !this.hidden&&!this.minimized}getPosition(){return [10,20]}isMinimized(){return !!this.minimized}setAlwaysOnTop(v){this.onTop=v}getNativeWindowHandle(){return Buffer.alloc(8,7)}setContentSize(w,h){this.content=[w,h]}}
 const trayState={tip:'',images:0};
 class Tray extends EventEmitter{constructor(img){super();trayState.images++;this.image=img}setImage(img){trayState.images++;this.image=img}setToolTip(v){trayState.tip=v}setContextMenu(){}destroy(){}}
 // safeStorage is Windows DPAPI in the real thing. The stand-in is reversible and obvious, so a test
 // can both decrypt what was written and prove the plaintext is not in the file. `vault.available`
 // plays the machine that cannot encrypt; `vault.foreign` plays a blob from another user or machine.
 const vault={available:true,foreign:false};
 const safeStorage={
  isAsyncEncryptionAvailable:async()=>vault.available,
  encryptStringAsync:async s=>Buffer.from('SEALED:'+s,'utf8'),
  // The real call answers {shouldReEncrypt, result}, not a bare string, so the mock does too.
  decryptStringAsync:async b=>{
    if(vault.foreign)throw new Error('cannot decrypt');
    const t=Buffer.from(b).toString('utf8');
    if(!t.startsWith('SEALED:'))throw new Error('not ours');
    return {shouldReEncrypt:!!vault.reseal,result:t.slice(7)};
  }};
 const unseal=v=>String(v||'').startsWith('enc:')
   ? Buffer.from(String(v).slice(4),'base64').toString('utf8').replace(/^SEALED:/,'') : String(v||'');
 const fakeElectron={app,BrowserWindow:Window,Tray,ipcMain,safeStorage,nativeImage:{createFromBitmap:(p,o)=>{assert.equal(p.length,32*32*4);return {}}},Menu:{buildFromTemplate:items=>{menuItems=items;return {popup(){}}}},screen:{getAllDisplays:()=>[],getCursorScreenPoint:()=>cursor},nativeTheme:{},shell:{openPath(){}},dialog:{showErrorBox:(_t,e)=>assert.fail(e),showOpenDialog:async()=>picked}};
 let picked={canceled:true,filePaths:[]};
 const writes=[];let iniText=ini;
 // config.ini is read back after every save, so the mock has to remember what was written to it.
 // Sound paths are validated by reading the file header, so .wav reads answer with a real one.
 const fakeFS={existsSync:()=>true,
  // window.json is absent unless the case under test is "the widget was already pinned last time".
  readFileSync:p=>p.endsWith('config.ini')?iniText:String(p).endsWith('window.json')&&state?JSON.stringify(state):String(p).endsWith('.wav')?PCM_WAV:(()=>{throw Error('absent')})(),
  writeFileSync:(p,d)=>{writes.push([p,d]);if(p.endsWith('config.ini'))iniText=d}};
 // The alert is played by spawning a player, so the mock records the spawns instead of making noise.
 const spawns=[];const fakeChild={spawn:(cmd,args,opts)=>{const c=new EventEmitter();c.killed=false;c.kill=()=>{c.killed=true};spawns.push({cmd,args,opts,child:c});return c}};
 const ctx={require:n=>n==='electron'?fakeElectron:n==='node:fs'?fakeFS:n==='node:child_process'?fakeChild:n==='./core.cjs'?{...require('./core.cjs'),fetchStation:station,fetchHistory:history}:require(n),process:{argv:[],platform:'win32',env},__dirname:__dirname,Buffer,URL,
 // Electron has fetch as a global and main.cjs passes it down, so the harness has to have one too -
 // without it the call was a ReferenceError that the best-effort catch swallowed in silence. It
 // throws rather than works: every API call in these tests is supposed to come from a mock, and a
 // test that reaches the real network should fail loudly instead of going quiet or slow.
 fetch:()=>{throw new Error('a test tried to reach the real network')}, // Two intervals exist now - the 16 ms drag follower and the visibility watchdog - so the mock has
 // to keep them apart instead of letting the second overwrite the first.
 setTimeout:()=>1,clearTimeout(){},
 setInterval:(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,ms});if(ms===16)dragTick=fn;return id},
 clearInterval(id){const t=timers.get(id);if(t&&t.ms===16)dragTick=null;timers.delete(id)}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.cjs','utf8'),ctx);
 // Two ticks, not one: startup is async now - it decrypts the secrets before the first config read.
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 trayMenu=menuItems;
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 return {app,ipcMain,window,windows,writes,trayMenu,settle,spawns,pick:v=>{picked=v},login:()=>login,
  invoke:(ch,sender,arg)=>handlers.get(ch)({sender},arg),
  ini:()=>iniText,menu:()=>menuItems,tick:()=>dragTick,cursorAt:p=>{cursor=p},
  // What a secret decrypts to, so a test can check the stored value without the file ever holding it.
  secret:key=>unseal(parseIni(iniText).Deye?.[key]),vault,
  // Named by its period rather than by elimination: there are three intervals now - the 16 ms drag
  // follower, this 400 ms visibility watchdog and the 1 s tray tooltip clock.
  watchdog:()=>[...timers.values()].find(t=>t.ms===400)?.fn,
  trayTick:()=>[...timers.values()].find(t=>t.ms===1000)?.fn,tray:()=>trayState,
  // The hourly history refresh, by its period: one hour in ms.
  hourly:()=>[...timers.values()].find(t=>t.ms===3600000)?.fn,
  send:a=>ipcMain.emit('action',{sender:window.webContents},a)};
}
// Autostart is the one setting the widget does not own: Windows does. The test pins that it is read
// from the OS rather than from window.json, and that an unpackaged entry names the runtime and the
// project folder - an entry pointing at a bare electron.exe would start a window with nothing in it.
test('autostart: the menu asks Windows and writes an entry that can actually start the widget',async()=>{
 const h=await desktop();const {ipcMain,window}=h;
 const item=()=>{ipcMain.emit('action',{sender:window.webContents},'menu');return h.menu().find(x=>x.label==='Start with Windows')};
 assert.equal(item().checked,false,'nothing is registered until it is asked for');
 item().click({checked:true});
 assert.equal(h.login().openAtLogin,true);
 assert.ok(Array.isArray(h.login().args)&&h.login().args[0].includes('project'),'the entry must name the app folder, not just the runtime');
 assert.equal(item().checked,true,'the menu reflects what the OS now reports');
 item().click({checked:false});
 assert.equal(h.login().openAtLogin,false);
 assert.equal(item().checked,false);
 // It is deliberately not in window.json: a copy there would disagree with the registry as soon as
 // the entry is removed by hand or the folder is moved.
 const state=h.writes.filter(([p])=>p.endsWith('window.json')).at(-1);
 if(state)assert.ok(!/openAtLogin|autostart/i.test(state[1]),'autostart must not be mirrored into the prefs file');
});
// The portable EXE runs from a temp copy of itself, so registering process.execPath would register a
// path that is gone by the next logon - the entry would look correct and start nothing.
test('autostart: the portable build registers the EXE the user clicked, not its temp copy',async()=>{
 const h=await desktop({env:{PORTABLE_EXECUTABLE_FILE:'D:/Deye Glass/Deye-Glass.exe'}});
 h.ipcMain.emit('action',{sender:h.window.webContents},'menu');
 h.menu().find(x=>x.label==='Start with Windows').click({checked:true});
 assert.equal(h.login().path,'D:/Deye Glass/Deye-Glass.exe');
 assert.equal(h.login().args,undefined,'the EXE needs no arguments to find its own files');
});
// The duration is only honest for a stretch the widget actually watched. A gap - the app was closed,
// the machine slept - must restart it rather than report an outage that lasted all night.
test('state clock: counts an unbroken stretch and refuses to count across a gap it did not watch',()=>{
 const a=stateClock(null,{state:'outage',now:1000});
 assert.equal(a.since,1000);
 const b=stateClock(a,{state:'outage',now:61000});
 assert.equal(b.since,1000,'the same state keeps its start');
 const c=stateClock(b,{state:'grid',now:62000});
 assert.equal(c.since,62000,'a change of state restarts the clock');
 const d=stateClock(c,{state:'grid',now:62000+3600000});
 assert.equal(d.since,62000+3600000,'a gap larger than maxGap restarts rather than invents a duration');
 assert.equal(stateClock(d,{state:null,now:1}).since,d.since,'no state is no news');
});
test('inferStateSince: finds the start of a continuous run at the end of history',()=>{
 const pts=[{t:1000,state:'grid'},{t:2000,state:'outage'},{t:3000,state:'outage'},{t:4000,state:'outage'}];
 assert.equal(inferStateSince(pts,'outage'),2000,'returns first point of the trailing run');
});
test('inferStateSince: returns null when the most recent point does not match the requested state',()=>{
 const pts=[{t:1000,state:'outage'},{t:2000,state:'outage'},{t:3000,state:'grid'}];
 assert.equal(inferStateSince(pts,'outage'),null);
});
test('inferStateSince: entire history is one state',()=>{
 const pts=[{t:100,state:'charging'},{t:200,state:'charging'},{t:300,state:'charging'}];
 assert.equal(inferStateSince(pts,'charging'),100);
});
test('inferStateSince: empty array returns null',()=>{
 assert.equal(inferStateSince([],'grid'),null);
});
test('inferStateSince: null state returns null',()=>{
 assert.equal(inferStateSince([{t:1,state:'grid'}],null),null);
});
test('inferStateSince: does not update clock when inferred time is not earlier',()=>{
 const pts=[{t:5000,state:'grid'},{t:6000,state:'outage'}];
 const inferred=inferStateSince(pts,'outage'); // 6000
 const clock={state:'outage',since:5000,seenAt:6000};
 // 6000 is not < 5000, so we should not apply it (caller responsibility — tested here as a contract)
 assert.ok(inferred>=clock.since,'inferred is not earlier — clock should stay unchanged');
});
test('tray icon: an arc in the state colour, a legible number, and a full ring at 100%',()=>{
 const px=trayPixels({soc:50,rgb:[255,93,104]});
 assert.equal(px.length,32*32*4);
 // BGRA, not RGBA: createFromBitmap takes the platform byte order.
 const first=[...Array(32*32).keys()].find(i=>px[i*4+3]===255);
 assert.deepEqual([px[first*4],px[first*4+1],px[first*4+2]],[104,93,255]);
 const lit=b=>[...Array(32*32).keys()].filter(i=>b[i*4+3]===255).length;
 assert.ok(lit(trayPixels({soc:90}))>lit(trayPixels({soc:20})),'a higher SOC lights more pixels');
 // 100 cannot be drawn as digits in an 18px hole, so it is a complete ring and no number.
 const ring=lit(trayPixels({soc:100})),ninety=lit(trayPixels({soc:90}));
 assert.ok(ring<ninety,'at 100% the digits are dropped, so fewer pixels are lit than at 90%');
 // 0% is a reading, so the number is drawn with no arc around it - 48 lit pixels is the glyph "0".
 assert.equal(lit(trayPixels({soc:0})),48,'0% prints as a number with an empty ring');
 assert.ok(lit(trayPixels({soc:null}))>lit(trayPixels({soc:0})),'an unknown SOC is the plain ring, not a printed zero');
});
test('tray: the tooltip carries the reading and the state duration, and the icon is not redrawn for free',async()=>{
 const h=await desktop();
 assert.match(h.tray().tip,/92%/);
 assert.match(h.tray().tip,/CHARGING/);
 assert.match(h.tray().tip,/Load 0\.49 kW/);
 assert.match(h.tray().tip,/for \d+:\d\d/,'the duration of the current state belongs in the tooltip');
 const drawn=h.tray().images;
 h.trayTick()();h.trayTick()();
 assert.equal(h.tray().images,drawn,'an unchanged SOC and state must not redraw the bitmap every second');
 assert.match(h.tray().tip,/for \d+:\d\d/,'but the tooltip clock keeps ticking');
});
test('renderer: the elapsed time of the current state is shown, and only while the state is known',()=>{
 const r=renderer();
 r.receive({data:{soc:50,battery:1.2,grid:false,gridPower:0,load:1.2,state:'outage',flow:'out'},
   error:null,loading:false,mode:'compact',scale:1,lang:'en',stateSince:Date.now()-83000});
 assert.match(r.element('.since').textContent,/^for 1:23$/);
 // Stale or missing data says nothing about how long anything has lasted.
 r.receive({data:null,error:'No connection to Deye Cloud',loading:false,mode:'compact',scale:1,lang:'en',stateSince:Date.now()-83000});
 assert.equal(r.element('.since').textContent,'');
});
// "Pinned" means pinned to the DESKTOP, which no Electron API can express: the window has to become
// a child of the shell's desktop window. These pin the wiring around that native call.
test('desktop controller: startup, IPC snapshot, mode and tray controls (mock Electron)',async()=>{
 const h=await desktop();const {ipcMain,window,writes,trayMenu}=h;
 assert.equal(window.options.webPreferences.nodeIntegration,false);assert.equal(window.options.webPreferences.contextIsolation,true);assert.ok(window.file.endsWith('index.html'));
 const menuItems=()=>h.menu();
 ipcMain.emit('ready',{sender:window.webContents});assert.equal(window.webContents.sent.at(-1)[1].data.soc,92);
 // The chart colours bars by the stored state, so every sample must carry one.
 const historyWrite=writes.find(([p])=>p.endsWith('history.json'));assert.ok(historyWrite,'history must be persisted');
 const sample=JSON.parse(historyWrite[1]).at(-1);assert.equal(sample.v,.49);assert.equal(sample.s,'charging');
 // A grey surface used to stick out around the card: the window must stay fully transparent
 // and must not request the Windows acrylic material, which fills the whole window rect.
 assert.equal(window.options.transparent,true);assert.equal(window.options.backgroundColor,'#00000000');
 assert.equal(window.options.backgroundMaterial,undefined);
 ipcMain.emit('action',{sender:window.webContents},'toggleMode');assert.deepEqual(window.size,[220,110]);
 // 'Show Widget' is a no-op in the menu opened from a visible widget; it belongs only to the tray,
 // where it is the discoverable way back. The tray menu is the one built during startup.
 assert.ok(trayMenu.some(x=>x.label==='Show Widget'),'the tray menu is the way back from a hidden window');
 ipcMain.emit('action',{sender:window.webContents},'menu');
 assert.ok(!menuItems().some(x=>x.label==='Show Widget'),'the widget is already visible, so its own menu must not offer to show it');
 assert.ok(menuItems().some(x=>x.label==='Large'),'everything else stays in both menus');
 // Editing the INI by hand is what the settings window replaces, so the item must be in both menus.
 assert.ok(menuItems().some(x=>x.label==='Settings…'),'the widget menu must offer Settings');
 assert.ok(trayMenu.some(x=>x.label==='Settings…'),'the tray menu must offer Settings too');
 // Dragging follows the cursor in the main process and stops on drag-end.
 const {send}=h;
 h.cursorAt({x:100,y:100});send('drag-start');assert.ok(h.tick(),'drag-start must start following the cursor');
 h.cursorAt({x:140,y:90});h.tick()();assert.deepEqual(window.moved.at(-1),[50,10],'window origin [10,20] plus cursor delta [40,-10]');
 send('drag-end');assert.equal(h.tick(),null,'drag-end must stop the timer');
 send('drag-start');window.emit('blur');assert.equal(h.tick(),null,'losing focus must not leave the window stuck to the cursor');
 send('hide');assert.equal(window.hidden,true);assert.ok(menuItems().some(x=>x.label==='Exit'));
});
// The alert fires on a CHANGE of grid state, not on every poll that finds the grid down - otherwise
// an outage would re-announce itself every five minutes until the power came back.
test('sound: a grid change plays the matching file, the first reading is silent, and Sound mutes it',async()=>{
 let relay='on';
 const h=await desktop({ini:'[Deye]\napp_id = 1\napp_secret = s\nemail = e@x.co\npassword = p\nstation_id = 1\n\n[Sounds]\ngrid_lost = sounds/grid_lost.wav\ngrid_back = sounds/grid_back.wav\n',
  station:async()=>norm({GridFrequency:relay==='on'?50:0,BatteryPower:relay==='on'?-3100:1250})});
 const file=()=>h.spawns.at(-1).opts.env.DEYE_SOUND;
 assert.equal(h.spawns.length,0,'the first poll has nothing to compare against, so it must stay silent');
 relay='off';h.send('refresh');await h.settle();
 assert.equal(h.spawns.length,1,'losing the grid must be announced');
 assert.match(file(),/grid_lost\.wav$/);assert.equal(h.spawns[0].cmd,'powershell.exe');
 relay='off';h.send('refresh');await h.settle();
 assert.equal(h.spawns.length,1,'a continuing outage must not re-announce itself on every poll');
 relay='on';h.send('refresh');await h.settle();
 assert.match(file(),/grid_back\.wav$/,'the grid coming back has its own sound');
 // Flapping must not stack players: the previous one is stopped before the next starts.
 assert.equal(h.spawns[0].child.killed,true,'a new alert must interrupt the one still playing');
 // Muting is a stored preference, and it also stops whatever is playing right now.
 h.menu().find(x=>x.label==='Sound').click({checked:false});
 assert.equal(h.spawns.at(-1).child.killed,true,'muting must silence the alert already in progress');
 relay='off';h.send('refresh');await h.settle();
 assert.equal(h.spawns.length,2,'a muted widget must not start a player at all');
 const saved=JSON.parse(h.writes.filter(([p])=>p.endsWith('window.json')).at(-1)[1]);
 assert.equal(saved.mute,true,'a muted widget stays muted after a restart');
});
// Pinning must hold against every route the widget can be moved or removed by, and the main process
// is the one that decides - the page can be stale or reloaded.
test('pinned: the widget cannot be dragged, hidden or closed, and the lock survives a restart',async()=>{
 const h=await desktop();const {window,send}=h;
 assert.equal(window.options.movable,true,'an unpinned widget is movable');
 send('togglePin');
 assert.equal(window.movable,false,'the OS must not move it either - the hand-rolled drag is not the only way');
 h.cursorAt({x:100,y:100});send('drag-start');assert.equal(h.tick(),null,'a pinned widget must not start following the cursor');
 const moves=(window.moved||[]).length;
 send('hide');assert.ok(!window.hidden,'pinned means it stays on screen');
 // Alt+F4 and the taskbar Close both arrive as 'close'.
 window.emit('close',{preventDefault(){}});assert.ok(!window.hidden,'closing must not remove a pinned widget either');
 assert.equal((window.moved||[]).length,moves,'nothing moved it');
 // Win+D / Win+M minimise every top-level window and bypass close and hide entirely. The event is
 // not cancellable, so the widget has to put itself back.
 assert.equal(window.minimizable,false,'Windows should be asked to skip a pinned widget outright');
 window.restored=false;window.emit('minimize');
 assert.ok(window.restored,'Win+M must not leave a pinned widget minimised');
 // The lock must NOT touch the stacking order: it means "do not move or lose this", not "cover every
 // other window", and a user who never asked for Always on Top must not get it from pinning. The cost
 // is accepted knowingly: Win+D raises the desktop above a pinned widget, and nothing can stop that
 // without taking the stacking order away from the user.
 assert.equal(window.onTop,false,'pinning must not force always-on-top');
 send('menu');
 const topItem=h.menu().find(x=>x.label==='Always on Top');
 assert.equal(topItem.enabled,undefined,'and the menu setting stays usable while pinned');
 assert.equal(topItem.checked,false,'and keeps showing the choice the user made');
 topItem.click({checked:true});assert.equal(window.onTop,true,'which is the only thing that raises it');
 topItem.click({checked:false});
 // The shell can also take a window off the screen without the window hearing any event, so the
 // outcome is watched rather than the cause.
 const watch=h.watchdog();assert.ok(watch,'a pinned widget must be watched');
 window.minimized=true;window.restored=false;watch();
 assert.ok(window.restored,'a pinned widget that ends up minimised by any route must come back');
 window.hidden=true;window.shown=false;watch();
 assert.ok(window.shown,'and so must one that ends up hidden');
 // Without a second way out, a user who pinned it and forgot the button could not undo it.
 send('menu');const item=h.menu().find(x=>x.label==='Pinned');
 assert.ok(item,'the menu must offer the lock too');assert.equal(item.checked,true);
 // The lock is remembered, so a pinned widget comes back pinned.
 const saved=h.writes.filter(([p])=>p.endsWith('window.json')).at(-1);
 assert.equal(JSON.parse(saved[1]).pinned,true);
 item.click({checked:false});
 assert.equal(window.movable,true);assert.equal(window.minimizable,true);
 window.restored=false;window.emit('minimize');
 assert.ok(!window.restored,'an unpinned widget must still obey Show Desktop');
 assert.equal(window.onTop,false,'and unpinning leaves the menu setting exactly as it was');
 assert.equal(h.watchdog(),undefined,'and stops the watchdog, which only exists for the pin');
 send('hide');assert.equal(window.hidden,true,'unpinning gives the controls back');
});
// The whole point of the settings window is that the secrets stay in the main process. If this
// test ever fails, a credential is on a web page.
test('settings: the form is told whether the secrets exist, never what they are',async()=>{
 const h=await desktop({ini:'[Deye]\napp_id = 202610294942036\napp_secret = super-secret\nemail = user@example.com\npassword = account-pass\nstation_id = 61\n\n[Widget]\nmodel = SUN-8K\n'});
 const setup=h.windows[0];h.menu().find(x=>x.label==='Settings…').click();
 const form=h.windows[1];assert.ok(form&&form!==setup,'Settings must open its own window');
 assert.ok(form.file.endsWith('settings.html'));
 assert.equal(form.options.webPreferences.contextIsolation,true);
 assert.equal(form.options.webPreferences.nodeIntegration,false);
 assert.equal(form.options.webPreferences.sandbox,true);
 assert.ok(form.options.webPreferences.preload.endsWith('preload-settings.cjs'),'the widget preload must not be reused');
 assert.equal(form.options.frame,undefined,'the dialog keeps the system frame, unlike the widget');
 // The dialog cannot be resized, so its height must mean the client area. Counting the title bar
 // into it made the form shorter than its content and the window scrolled.
 assert.equal(form.options.useContentSize,true,'the height must exclude the title bar, or the form scrolls');
 const payload=h.invoke('settings:load',form.webContents);
 assert.equal(payload.hasSecret,true);assert.equal(payload.hasPassword,true);
 assert.equal(payload.station_id,'61');assert.equal(payload.model,'SUN-8K');
 // Identifiers may come back - the user typed them and can see them again in the form.
 assert.equal(payload.app_id,'202610294942036');assert.equal(payload.email,'user@example.com');
 const sent=JSON.stringify(payload);
 assert.ok(!sent.includes('super-secret'),'the app secret must not be in the payload');
 assert.ok(!sent.includes('account-pass'),'the account password must not be in the payload');
 // A second request focuses the open window instead of stacking another one.
 h.menu().find(x=>x.label==='Settings…').click();assert.equal(h.windows.length,2);
 // The widget page must not be able to read the settings channels.
 assert.equal(h.invoke('settings:load',h.window.webContents),null);
});
test('settings: saving keeps the stored secrets when their fields were left empty',async()=>{
 const h=await desktop({ini:'[Deye]\n# mine\napp_id = 202610294942036\napp_secret = super-secret\nemail = user@example.com\npassword = account-pass\nstation_id = 61\n\n[Sounds]\ngrid_lost = sounds/a.wav\n'});
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 const base={app_id:'202610294942036',email:'user@example.com',app_secret:'',password:''};
 const r=await h.invoke('settings:save',wc,{...base,station_id:'62',refresh_interval:'180',battery_capacity_kwh:'16',model:'SUN-8K'});
 assert.equal(r.ok,true);
 const after=h.ini();
 assert.equal(h.secret('app_secret'),'super-secret','an empty field means "keep it", not "erase it"');
 assert.equal(h.secret('password'),'account-pass','and that holds for both secrets');
 assert.match(after,/station_id = 62/);assert.match(after,/# mine/);assert.match(after,/grid_lost = sounds\/a\.wav/);
 assert.equal(parseIni(after).Widget.refresh_interval,'180');
 // A typed secret replaces it, and only then.
 await h.invoke('settings:save',wc,{...base,app_secret:'fresh-secret',password:'fresh-pass',station_id:'62'});
 assert.equal(h.secret('app_secret'),'fresh-secret');assert.equal(h.secret('password'),'fresh-pass');
});
// The file is the thing an attacker reads, so this is the assertion that matters: whatever the user
// typed, the plaintext is not in it. The fixture starts with plaintext on purpose - that is what an
// older config.ini, or a hand-edited one, looks like.
test('secrets: nothing a secret field holds is ever written to config.ini in the clear',async()=>{
 const h=await desktop({ini:'[Deye]\napp_id = 202610294942036\napp_secret = super-secret\nemail = user@example.com\npassword = account-pass\nstation_id = 61\n'});
 // Startup alone must have upgraded the plaintext it found, before anything was saved.
 assert.ok(!h.ini().includes('super-secret'),'a plaintext app secret must not survive startup');
 assert.ok(!h.ini().includes('account-pass'),'nor a plaintext password');
 assert.match(h.ini(),/app_secret = enc:/);assert.match(h.ini(),/password = enc:/);
 // Sealing must be reversible, or the widget just locked the user out of their own account.
 assert.equal(h.secret('app_secret'),'super-secret');
 assert.equal(h.secret('password'),'account-pass');
 // And the running widget still has usable credentials: it polled with them.
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 const payload=h.invoke('settings:load',wc);
 assert.equal(payload.hasSecret,true);assert.equal(payload.hasPassword,true);
 // Identifiers are not secrets and stay readable, so the user can see which account is configured.
 assert.match(h.ini(),/email = user@example\.com/);assert.match(h.ini(),/app_id = 202610294942036/);
 // A newly typed secret goes in sealed too, not just a migrated one.
 await h.invoke('settings:save',wc,{app_id:'1',email:'e@x.co',app_secret:'typed-secret',password:'typed-pass',station_id:'61'});
 assert.ok(!h.ini().includes('typed-secret')&&!h.ini().includes('typed-pass'),'a typed secret is sealed before it is written');
 assert.equal(h.secret('password'),'typed-pass');
});
test('secrets: a blob from another machine is treated as absent, not as a broken login',async()=>{
 // DPAPI ciphertext is bound to the user and the machine, so a copied config.ini cannot be opened.
 // The right answer is "there are no credentials here", which opens the form; anything else leaves
 // the user staring at a login failure they cannot act on.
 const h=await desktop({ini:'[Deye]\napp_id = 1\napp_secret = enc:Zm9yZWlnbg==\nemail = e@x.co\npassword = enc:Zm9yZWlnbg==\nstation_id = 61\n',
  station:require('./core.cjs').fetchStation});
 h.vault.foreign=true;
 await h.settle();
 assert.equal(h.windows.length,2,'the settings window must open by itself');
 const payload=h.invoke('settings:load',h.windows[1].webContents);
 assert.equal(payload.hasSecret,false,'an unopenable secret is no secret');
 assert.equal(payload.hasPassword,false);
 assert.equal(payload.email,'e@x.co','but the identifiers are still there to show');
});
test('secrets: a machine that cannot encrypt is told so instead of being written to in the clear',async()=>{
 const h=await desktop();
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 h.vault.available=false;
 const r=await h.invoke('settings:save',wc,{app_id:'1',email:'e@x.co',app_secret:'s',password:'nope',station_id:'1'});
 assert.equal(r.ok,false,'saving must fail rather than fall back to plaintext');
 assert.match(r.error,/cannot encrypt/);
 assert.ok(!h.ini().includes('nope'),'and the password must not be in the file either way');
});
test('settings: values are validated and a failed test reports publicError, not the raw error',async()=>{
 const h=await desktop({station:async()=>{const e=new Error('bearer super-secret leaked');throw e}});
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 const ok={app_id:'1',app_secret:'s',email:'e@x.co',password:'p',station_id:'1'};
 const bad=await h.invoke('settings:test',wc,ok);
 assert.equal(bad.ok,false);assert.equal(bad.error,'No connection to Deye Cloud','the raw message can carry a credential');
 // Empty secret fields with secrets already stored are not an error - they mean "test the stored
 // ones", so the user can check a changed Station ID without retyping a password.
 assert.equal((await h.invoke('settings:test',wc,{...ok,app_secret:'',password:''})).error,'No connection to Deye Cloud');
 assert.equal((await h.invoke('settings:test',wc,{...ok,station_id:''})).error,'Station ID is required');
 assert.equal((await h.invoke('settings:test',wc,{...ok,app_id:''})).error,'App ID is required');
 assert.equal((await h.invoke('settings:test',wc,{...ok,email:''})).error,'Account email is required');
 assert.equal((await h.invoke('settings:test',wc,{...ok,base_url:'http://x.com'})).error,'Server must start with https://');
 assert.equal((await h.invoke('settings:test',wc,{...ok,refresh_interval:'soon'})).error,'Refresh interval must be a number');
 // Polling too often is the user's foot, not theirs to shoot: 15 s is the floor everywhere else.
 await h.invoke('settings:save',wc,{...ok,refresh_interval:'2'});
 assert.equal(parseIni(h.ini()).Widget.refresh_interval,String(MIN_INTERVAL));
});
// Three ways to mute and one owner, so the toolbar button, the menu item and the form cannot drift.
test('mute: the toolbar button, the menu and the form all drive one stored setting',async()=>{
 const h=await desktop();
 assert.equal(h.window.webContents.sent.at(-1)[1].mute,false,'the page needs the state to draw the button');
 h.send('toggleMute');
 assert.equal(h.window.webContents.sent.at(-1)[1].mute,true,'the button must reach the main process');
 assert.equal(h.menu().find(x=>x.label==='Sound').checked,false,'the menu item must follow the button');
 h.menu().find(x=>x.label==='Sound').click({checked:true});
 assert.equal(h.window.webContents.sent.at(-1)[1].mute,false,'and the button must follow the menu');
 // An open form is told as well, instead of being left with a stale checkbox.
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 h.send('toggleMute');
 assert.deepEqual(wc.sent.at(-1),['settings:mute',true],'the open form must be told');
 // Saving carries the checkbox, so the form is a third way in rather than a read-only view.
 await h.invoke('settings:save',wc,{app_id:'1',app_secret:'s',email:'e@x.co',password:'p',station_id:'1',mute:false});
 assert.equal(h.window.webContents.sent.at(-1)[1].mute,false);
 assert.equal(h.invoke('settings:load',wc).mute,false,'and the form is told the current value on load');
});
test('settings: sound paths are offered, checked and playable before they are saved',async()=>{
 const h=await desktop({ini:'[Deye]\napp_id = 1\napp_secret = s\nemail = e@x.co\npassword = p\nstation_id = 1\n\n[Sounds]\ngrid_lost = sounds/a.wav\n'});
 h.menu().find(x=>x.label==='Settings…').click();const wc=h.windows[1].webContents;
 const payload=h.invoke('settings:load',wc);
 assert.equal(payload.grid_lost,'sounds/a.wav','a configured path must be shown, not the default');
 assert.equal(payload.grid_back,'sounds/grid_back.wav','a missing one falls back to the bundled file');
 // The picker returns a path relative to config.ini when the file is inside that folder, so copying
 // the widget to another machine does not break it.
 h.pick({canceled:false,filePaths:[require('node:path').join(__dirname,'sounds','x.wav')]});
 const chosen=await h.invoke('settings:browse',wc);
 assert.equal(chosen.path,'electron/sounds/x.wav','a path under config.ini must come back relative and with / separators');
 assert.equal(chosen.error,undefined);
 h.pick({canceled:true,filePaths:[]});
 assert.equal(await h.invoke('settings:browse',wc),null,'cancelling must not clear the field');
 // Listening is the sound equivalent of 'Test connection': it happens before anything is written.
 assert.equal(h.invoke('settings:play',wc,'sounds/a.wav').ok,true);
 assert.match(h.spawns.at(-1).opts.env.DEYE_SOUND,/sounds[\\/]a\.wav$/);
 assert.equal(h.ini().includes('x.wav'),false,'playing must not write anything');
 // Saving writes both keys and keeps the hand-written one that was not retyped.
 await h.invoke('settings:save',wc,{app_id:'1',app_secret:'s',email:'e@x.co',password:'p',station_id:'1',grid_lost:'',grid_back:'sounds/b.wav'});
 const after=parseIni(h.ini());
 assert.equal(after.Sounds.grid_lost,'sounds/a.wav','an empty field must not erase a configured path');
 assert.equal(after.Sounds.grid_back,'sounds/b.wav');
 // The widget page must not be able to open a file dialog or play arbitrary files.
 assert.equal(await h.invoke('settings:browse',h.window.webContents),null);
 assert.equal((await h.invoke('settings:play',h.window.webContents,'x.wav')).ok,false);
});
test('renderer: today total consumption is shown under the gauge, exact and not estimated',()=>{
 const r=renderer();
 r.receive({data:norm(),mode:'full',lang:'en'});
 // norm() carries no day counters, so there is nothing to claim.
 assert.equal(r.element('#today-kwh').textContent,'—','no counter means a dash, not a zero');
 r.receive({data:{...norm(),dayEnergy:{consumed:10.14,purchased:9.3,charged:2.3,discharged:3.1}},mode:'full',lang:'en'});
 assert.equal(r.element('#today-kwh').textContent,'10.1','one decimal, which is what the meter reports');
 assert.match(r.element('.today-total').title,/today/i,'the tooltip says what the number is');
 // A station that reports no consumption counter at all must not read as a house that used nothing.
 r.receive({data:{...norm(),dayEnergy:{consumed:null}},mode:'full',lang:'en'});
 assert.equal(r.element('#today-kwh').textContent,'—');
 // Zero is a real reading and is shown as one.
 r.receive({data:{...norm(),dayEnergy:{consumed:0}},mode:'full',lang:'en'});
 assert.equal(r.element('#today-kwh').textContent,'0.0');
});
test('renderer: the day row shows the four figures for the calendar day, and dashes without them',()=>{
 const r=renderer();
 const hour=3600000;
 r.receive({data:norm(),mode:'full',lang:'en',
   today:{withGrid:11*hour+36*60000,withoutGrid:2*hour+28*60000,charging:39*60000,onBattery:0,unknown:0,samples:166}});
 assert.equal(r.element('#day-grid').textContent,'11:36');
 assert.equal(r.element('#day-outage').textContent,'2:28');
 assert.equal(r.element('#day-charging').textContent,'0:39');
 assert.equal(r.element('#day-onbattery').textContent,'0:00','zero is a figure, not a missing one');
 // The caveats belong in the tooltip: that the parts are not four slices of the day, and that each
 // number is only good to about five minutes.
 const title=r.element('.day').title;
 assert.match(title,/midnight/i,'the window has to be stated - these are not the last 24 hours');
 assert.match(title,/approximate/i,'and the figures must not look exact when they are not');
 // Before the first backfill answers there is nothing to show, and nothing must be invented.
 r.receive({data:norm(),mode:'full',lang:'en',today:null});
 for(const id of ['#day-grid','#day-outage','#day-charging','#day-onbattery'])
   assert.equal(r.element(id).textContent,'—',`${id} must be a dash, not 0:00, when nothing is known`);
});
test('renderer: a hole in the day is admitted in the tooltip instead of being hidden',()=>{
 const r=renderer(),hour=3600000;
 r.receive({data:norm(),mode:'full',lang:'en',
   today:{withGrid:6*hour,withoutGrid:hour,charging:0,onBattery:0,unknown:4*hour,samples:20}});
 assert.match(r.element('.day').title,/No data for 4:00/,
  'four hours the cloud cannot speak for must be said out loud, or the figures silently fail to add up');
 r.receive({data:norm(),mode:'full',lang:'en',
   today:{withGrid:6*hour,withoutGrid:hour,charging:0,onBattery:0,unknown:0,samples:20}});
 assert.ok(!/No data for/.test(r.element('.day').title),'and not mentioned when there is no hole');
});
test('renderer: hovering a bar tells you when it was, including where there is no data',()=>{
 const r=renderer(),now=Date.now();
 // Two bars' worth of points, 12 hours apart, so they land in different slots.
 r.receive({data:norm(),mode:'full',lang:'en',history:[
   {t:now-12*3600000,v:1.5,s:'outage'},{t:now-3600000,v:.8,s:'grid'}]});
 const bars=r.element('.bars').children;
 assert.equal(bars.length,64);
 assert.ok(bars.every(b=>/\d\d:\d\d/.test(b.title||'')),
  'every bar carries a time, so a glance at the chart can be placed in the day');
 const withData=bars.filter(b=>/kW/.test(b.title||''));
 assert.equal(withData.length,2,'two bars have readings');
 // Just the time, with no word in front of it: a bar is plainly a span, so saying so was noise.
 assert.match(withData[0].title,/^\d\d:\d\d · 1\.50 kW · /,'time first, then the reading');
 assert.ok(!/around|около/i.test(withData[0].title),'and no word dressing the time up');
 // An empty slot is labelled too - knowing WHEN the cloud has nothing is worth as much.
 const empty=bars.find(b=>!/kW/.test(b.title||''));
 assert.ok(empty,'a gap in the chart still says when it is');
 assert.match(empty.title,/^\d\d:\d\d · /);
 // The two bars are 12 hours apart, so their labels must differ - a constant time would pass every
 // other assertion here while telling the user nothing.
 assert.notEqual(withData[0].title.slice(0,14),withData[1].title.slice(0,14));
});
// The window IS the card, so the two sizes have to agree. They live in different files and nothing
// at runtime complains: a mismatch just shows up as dead space around the glass or a clipped edge.
test('the window size matches the card in the stylesheet',async()=>{
 const css=fs.readFileSync(__dirname+'/index.html','utf8');
 const full=css.match(/#widget\{position:relative;width:(\d+)px;height:(\d+)px/);
 assert.ok(full,'#widget must declare its own size');
 const compact=css.match(/#widget\.compact\{width:(\d+)px;height:(\d+)px/);
 assert.ok(compact,'and so must the compact variant');
 // Scale 1, so the comparison is against the card itself rather than against the card times a zoom.
 const h=await desktop({state:{mode:'full',scale:1,lang:'en',pinned:false,mute:false}});
 assert.deepEqual([h.window.options.width,h.window.options.height],[Number(full[1]),Number(full[2])],
  'the full-mode window must be exactly the card');
 h.menu().find(x=>x.label==='Compact').click();
 assert.deepEqual(h.window.size,[Number(compact[1]),Number(compact[2])],
  'and so must the compact one');
});
// The chart used to show only what this machine witnessed, so it was empty on a new machine and
// kept a hole after every restart. These pin the backfill that fixes that.
test('chart: the cloud series fills the chart at startup and carries the day figures',async()=>{
 const now=Date.now(),step=300000;
 // The shape fetchHistory really returns, grid flag and battery included - the figures are measured
 // from those, not from the state name.
 const cloud=[
  {t:now-3*step,load:1.5,state:'outage',grid:false,battery:1.25,soc:70,gridPower:0},
  {t:now-2*step,load:1.6,state:'outage',grid:false,battery:1.3,soc:68,gridPower:0},
  {t:now-step,load:.8,state:'charging',grid:true,battery:-3.1,soc:72,gridPower:4},
 ];
 let asked=null;
 const h=await desktop({history:async(_c,_f,_s,window)=>{asked=window;return cloud}});
 await h.settle();await h.settle();
 const sent=h.window.webContents.sent.filter(m=>m[0]==='snapshot').at(-1)[1];
 // The chart reads `history`, so filling it is the whole fix - no renderer change needed.
 assert.ok(sent.history.length>=3,'the chart must have the cloud points, not just what was polled');
 const bar=sent.history.find(p=>p.t===now-2*step);
 assert.ok(bar,'a cloud point lands in the chart with its own timestamp');
 assert.equal(bar.v,1.6,'height is the load');
 assert.equal(bar.s,'outage','and colour is the state the cloud data derived');
 // A full day is asked for, because that is what the chart spans.
 assert.ok(asked&&asked.to-asked.from>=86400000-1000,'the window has to cover the whole chart');
 // And the day figures ride along on the same series.
 assert.ok(sent.today,'the snapshot carries the day figures');
 assert.equal(sent.today.withoutGrid,2*step,'two intervals of outage');
 // The last sample is credited up to the moment the refresh ran, which is a few ms after the `now`
 // this test captured, so this one is compared with a tolerance rather than exactly.
 assert.ok(Math.abs(sent.today.charging-step)<2000,'and the charging figure rides along, got '+sent.today.charging);
 assert.equal(sent.today.samples,3);
 // Written through, so the next start has them before the first request answers.
 const saved=h.writes.filter(([p])=>p.endsWith('history.json')).at(-1);
 assert.ok(saved,'the backfilled chart is persisted');
 assert.ok(JSON.parse(saved[1]).some(p=>p.t===now-2*step));
});
test('chart: re-running the backfill does not double the bars, and a failure costs nothing',async()=>{
 const now=Date.now(),step=300000;
 const cloud=[{t:now-2*step,load:1,state:'grid'},{t:now-step,load:2,state:'grid'}];
 let fail=false;
 const h=await desktop({history:async()=>{if(fail)throw new Error('cloud down');return cloud}});
 await h.settle();await h.settle();
 const first=h.window.webContents.sent.filter(m=>m[0]==='snapshot').at(-1)[1].history.length;
 // The hourly refresh runs the same code again; identical points must collapse, not accumulate.
 const hourly=h.hourly();assert.ok(hourly,'the hourly refresh is scheduled');
 await hourly();await h.settle();
 const second=h.window.webContents.sent.filter(m=>m[0]==='snapshot').at(-1)[1].history.length;
 assert.equal(second,first,'the same series fetched twice is the same chart');
 // A cloud failure must leave the chart as it was rather than clearing it.
 fail=true;await hourly();await h.settle();
 const after=h.window.webContents.sent.filter(m=>m[0]==='snapshot').at(-1)[1].history;
 assert.equal(after.length,first,'a failed refresh keeps what the chart already had');
});
test('settings: a first run with no credentials opens the form by itself',async()=>{
 // The template the first run writes, verbatim: placeholders must not read as credentials.
 const h=await desktop({ini:'[Deye]\napp_id = YOUR_APP_ID_HERE\napp_secret = YOUR_APP_SECRET_HERE\nemail = YOUR_EMAIL_HERE\npassword = YOUR_PASSWORD_HERE\nstation_id = YOUR_STATION_ID_HERE\n',
  station:require('./core.cjs').fetchStation});
 await h.settle();
 assert.equal(h.windows.length,2,'a new user must not be left with an error and no way forward');
 assert.ok(h.windows[1].file.endsWith('settings.html'));
 const payload=h.invoke('settings:load',h.windows[1].webContents);
 assert.equal(payload.hasSecret,false,'a placeholder is not an app secret');
 assert.equal(payload.hasPassword,false,'nor is one a password');
 assert.equal(payload.app_id,'','nor an app id');
 assert.equal(payload.station_id,'','nor a station id');
 // With nothing stored there is no secret to fall back on, so an empty field is a real error.
 const r=await h.invoke('settings:test',h.windows[1].webContents,{app_id:'1',app_secret:'',email:'e@x.co',password:'',station_id:'1'});
 assert.equal(r.error,'App Secret is required');
 // Quitting must take the dialog with it instead of leaving a window with no app.
 h.app.emit('before-quit');assert.equal(h.windows[1].isDestroyed(),true);
});
