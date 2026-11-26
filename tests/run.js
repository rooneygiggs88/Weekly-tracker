// The app's test suite: loads index.html in a phone-sized browser with synthetic data
// and checks (1) every page, tab and main modal renders without errors or broken text,
// (2) the coach's weekly plan obeys its own rules for the coming weeks, in both modes,
// and (3) a few cross-feature agreements that have broken before.
// Run: node tests/run.js   (needs Playwright with Chromium)
const path=require('path');
const {chromium,devices}=require('playwright');
const makeFixture=require('./fixture');

const FILE='file://'+path.resolve(__dirname,'..','index.html');
const failures=[];let checks=0;
const check=(ok,msg)=>{checks++;if(!ok)failures.push(msg);};

async function boot(browser,mutate){
  const ctx=await browser.newContext({...devices['iPhone 13'],colorScheme:'dark'});
  const d=makeFixture();if(mutate)mutate(d);
  await ctx.addInitScript(d=>{if(sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','1');localStorage.clear();
    localStorage.setItem('wt_v3',JSON.stringify(d.state));localStorage.setItem('gym_data_v1',JSON.stringify(d.gym));localStorage.setItem('run_data_v2',JSON.stringify(d.run));
    localStorage.setItem('health_data_v1',JSON.stringify(d.health));localStorage.setItem('gym_prog_v1',JSON.stringify(d.prog));localStorage.setItem('vaping_data_v1',JSON.stringify(d.vaping));localStorage.setItem('morning_data_v1',JSON.stringify(d.morning));},d);
  const page=await ctx.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(FILE);await page.waitForTimeout(700);
  return{ctx,page,errors};
}

async function sweep(browser){
  const {ctx,page,errors}=await boot(browser);
  const views=[["today","showPage('today')"],["log-run","showPage('train');switchTrainTab('run')"],["log-gym","showPage('train');switchTrainTab('gym')"],
    ["log-history","showPage('train');switchTrainTab('history')"],["log-monthly","showPage('train');switchTrainTab('monthly')"],["log-prs","showPage('train');switchTrainTab('prs')"],
    ["log-volume","showPage('train');switchTrainTab('volume')"],["trends-overview","showPage('trends');switchTrendsTab('overview')"],["trends-running","showPage('trends');switchTrendsTab('running')"],
    ["trends-gym","showPage('trends');switchTrendsTab('gym')"],["trends-wellness","showPage('trends');switchTrendsTab('wellness')"],["me-overview","showPage('me');meSetTab('overview')"],["me-body","showPage('me');meSetTab('body')"]];
  for(const [name,js] of views){
    try{await page.evaluate(js);}catch(e){errors.push(`${name}: ${e.message}`);}
    await page.waitForTimeout(250);
    const txt=await page.evaluate(()=>(document.querySelector('.page.active')||document.body).innerText);
    const bad=txt.match(/[^\n]*(undefined|NaN|Invalid Date|\[object|Infinity)[^\n]*/);
    check(!bad,`${name}: broken text "${bad&&bad[0].slice(0,120)}"`);
    check(txt.length>200,`${name}: page looks empty`);
  }
  for(const m of ["openSettings()","openYearGoalModal()","openRaceModal()","openYearReview()"]){
    try{await page.evaluate(m);await page.waitForTimeout(200);}catch(e){errors.push(`${m}: ${e.message}`);}
    const txt=await page.evaluate(()=>{const o=[...document.querySelectorAll('.modal-overlay.open')].pop();return o?o.innerText:'';});
    check(txt.length>30,`${m}: modal didn't open`);
    check(!/undefined|NaN|Invalid Date/.test(txt),`${m}: broken text in modal`);
    await page.evaluate(()=>document.querySelectorAll('.modal-overlay.open').forEach(o=>closeModal(o.id)));
  }
  check(errors.length===0,`page errors: ${errors.join(' | ')}`);
  // Settings shows the real version
  const ver=await page.evaluate(()=>{openSettings();return document.getElementById('app-build').textContent;});
  const meta=await page.evaluate(()=>document.querySelector('meta[name="app-version"]').content);
  check(ver===meta,`settings version "${ver}" isn't the app version "${meta}"`);
  await ctx.close();
}

// The coach's rules, checked on the weeks it plans.
async function planRules(browser,label,mutate){
  const {ctx,page,errors}=await boot(browser,mutate);
  const res=await page.evaluate(()=>{
    const out=[];
    for(let o=0;o<6;o++){
      const w=getCalendarWeek(o);if(!w||!w.coach)continue;
      const S=w.coach.sessions.filter(s=>!s.done&&!s.past);
      const days=S.map(s=>s.day);
      const plannedKm=w.days.flatMap(d=>d.planned.filter(p=>p.type!=='Race').map(p=>({day:d.i,km:p.km,sub:p.sub})));
      const caps=Object.fromEntries(S.map(s=>[s.day,s.hard||s.cap||99]));
      out.push({o,kind:w.kind,mode:w.coach.mode,days,subs:S.map(s=>s.day+':'+s.sub),raceDay:(S.find(s=>s.sub==='Race')||{}).day,
        plannedKm,caps,rest:w.coach.rest||[],gym:(w.coach.gym||[]).map(g=>g.day),summary:w.coach.summary,
        restFull:w.days.filter(d=>!d.past&&!d.planned.length&&!d.gym&&!d.done.length).length,anyPastEmpty:w.days.some(d=>d.past&&!d.done.length)});
    }
    return out;
  });
  for(const w of res){
    const tag=`${label} week+${w.o} (${w.kind})`;
    check(new Set(w.days).size===w.days.length,`${tag}: two sessions on one day ${w.subs}`);
    check(w.subs.filter(s=>s.endsWith('Shakeout')).length<=1,`${tag}: more than one shakeout ${w.subs}`);
    const q=w.subs.filter(s=>/Tempo|Intervals|Sharpener/.test(s)).map(s=>+s.split(':')[0]);
    const L=w.subs.filter(s=>/:(Long|B2B)$/.test(s)).map(s=>+s.split(':')[0]);
    q.forEach(d=>{check(!L.some(l=>Math.abs(l-d)<2),`${tag}: quality next to the long run ${w.subs}`);
      if(w.raceDay!=null)check(w.raceDay-d>=3||d>w.raceDay,`${tag}: quality within 2 days of the race ${w.subs}`);});
    w.plannedKm.forEach(p=>check(p.km<=(w.caps[p.day]||99)+1,`${tag}: ${p.km} km on day ${p.day} is over its ceiling ${w.caps[p.day]}`));
    check(!!w.summary,`${tag}: no summary`);
    if(w.mode==='coach'&&!w.anyPastEmpty&&w.o>0)check(w.restFull>=1,`${tag}: no full rest day ${w.subs} gym ${w.gym}`);
  }
  check(errors.length===0,`${label}: page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// Agreements between features that have drifted apart before.
// Next year: the New Year card, phases from an A race, and weeks past 31 Dec get runs.
async function nextYear(browser){
  const {ctx,page,errors}=await boot(browser,d=>{d.state.yearRunGoal.year-=1;d.state.race.priority='B';d.state.extraRaces.push({name:'Far Ultra',date:new Date(Date.now()+150*864e5).toISOString().slice(0,10),km:50,priority:'A'});});
  const r=await page.evaluate(()=>{
    renderYearGoalCard();const card=document.getElementById('year-goal-wrap').innerText;
    const ph=weekPhase(dk(getMonday(today())));
    startYearGoal(2000);const after=(getYearGoalWeek()||{}).plan;
    const ext=after&&after.after||[];
    let planned=null;if(ext.length){const i=after.weeks.length+1;const w=getCalendarWeek(i);planned=w?w.days.reduce((a,d)=>a+d.planned.length,0):0;}
    return{card,phase:ph&&ph.phase,goal:state.yearRunGoal.year===today().getFullYear(),ext:ext.length,planned};
  });
  check(/in the books/i.test(r.card),'New Year card missing when last year\'s goal is over');
  check(r.phase==='base',`A race 21 weeks out should be base phase, got ${r.phase}`);
  check(r.goal,'one-tap goal didn\'t set this year\'s goal');
  if(r.ext)check(r.planned>0,'weeks past 31 Dec have no runs planned');
  check(errors.length===0,`next year: page errors: ${errors.join(' | ')}`);
  await ctx.close();
}
async function agreements(browser){
  const {ctx,page,errors}=await boot(browser);
  const r=await page.evaluate(()=>{
    const out={};
    // The plan lookups match the coach's week
    const cw=getCalendarWeek(0);
    out.lookup=cw.days.filter(d=>!d.past).every(d=>{const runP=d.planned.some(p=>p.type!=='Race')||d.planned.some(p=>p.type==='Race');return(planTypeThisWeek(d.i)==='Run')===runP||d.done.length>0;});
    // The goal card says each thing once
    renderYearGoalCard();const wk=(document.querySelector('.yg-week')||{}).innerText||'';
    const lines=wk.split('\n').map(s=>s.trim()).filter(s=>s.length>20);out.dupLines=lines.filter((s,i)=>lines.indexOf(s)!==i);
    // Auto-tag
    out.long=(guessEffort(24,24*365,dk(today()))||{}).e;
    out.easy=(guessEffort(9,9*360,dk(today()))||{}).e;
    // Fitness & Form "now" is consistent with its chart
    const h=getFffHistory();out.fff=!!(h&&h.now);
    // Coached gym session: belongs to the type, fits the time, starts in the logger
    const gp=planGymSession('Pull');out.gym=!!gp&&gp.rows.length>=2&&gp.mins<=45&&gp.rows.every(r=>{const m=getExerciseMuscles(r.name)||[];return!m.length||m.some(x=>['Back','Biceps'].includes(x));});
    buildGymSession('Push');out.draft=!!(gymDraft&&gymDraft.exercises.length);
    // Live session: slim bar, warm-ups on the first heavy lift, one coach voice
    out.bar=!!document.querySelector('.gl-bar');out.live=document.body.classList.contains('gym-live');
    out.noFill=!/Same as last time/.test(document.getElementById('gym-content').innerText);
    out.wu=!!(gymDraft.exercises[0]._warmups&&gymDraft.exercises[0]._warmups.length);
    gymLogWarmups(0);out.wuLogged=gymDraft.exercises[0].sets.filter(x=>x.warmup).length>=2;
    gymDraft.startedAt=Date.now()-45*60000;renderGymLogger();out.nudge=!!document.querySelector('.gl-nudge');
    // Progression read from the sets: held -> up, fell away -> hold
    const up=getLiftTarget({weight:'60',reps:'8'},true,0,[{weight:'60',reps:'8'},{weight:'60',reps:'8'},{weight:'60',reps:'8'}]);
    const hold=getLiftTarget({weight:'60',reps:'8'},true,0,[{weight:'60',reps:'8'},{weight:'60',reps:'7'},{weight:'60',reps:'6'}]);
    out.prog={up:up&&up.weight,hold:hold&&hold.weight,ctx:getGymContext().comeback||!!getGymContext().race};
    // Finishing: one sheet; tapping how it felt saves it, with any niggle
    gymDraft.exercises[0].sets=gymDraft.exercises[0].sets.filter(x=>!x.warmup);gymKpResetTarget();renderGymLogger();gymKpLogSet();restStop();
    const before=loadGymData().length;openGymFinish();
    out.finSheet=!!document.querySelector('#gym-finish-content .gf-eff');
    gymFinishNiggle('Shoulder');
    document.querySelector('#gym-finish-content .gf-eff button:nth-child(2)').click();
    const saved=loadGymData();out.fin={n:saved.length-before,effort:saved[saved.length-1].effort,nig:(saved[saved.length-1].niggles||[]).join(),live:document.body.classList.contains('gym-live')};
    buildGymSession('Push');showPage('today');out.resume=!!document.querySelector('#gym-resume .gr-bar');showPage('train');switchTrainTab('gym');
    // Race kit: the plan's splits finish on its target, and race mode renders
    const rp=racePacePlan(state.race);out.race=!!rp&&rp.splits[rp.splits.length-1].t===Math.round(rp.target);
    _rmOpen=true;renderRaceMode();out.rm=!!document.querySelector('#race-mode .rm-plan')&&(openRacePlan(),document.querySelectorAll('#session-detail-content .rm-split').length>0);closeModal('session-detail-modal');
    return out;
  });
  check(r.lookup,'planTypeThisWeek disagrees with the coach\'s week');
  check(!r.dupLines.length,`goal card repeats itself: ${r.dupLines.join(' | ')}`);
  check(r.long==='Long Run',`auto-tag: 24 km at easy pace guessed ${r.long}`);
  check(r.easy==='Easy',`auto-tag: 9 km at easy pace guessed ${r.easy}`);
  check(r.fff,'fitness & form has no "now" value');
  check(r.race,'race plan splits don\'t finish on the target');
  check(r.gym,'coach\'s Pull session is empty, too long, or has non-Pull lifts');
  check(r.draft,'starting the coach\'s session didn\'t load the logger');
  check(r.bar&&r.live,'live session has no slim bar / live mode');
  check(r.noFill,'"Same as last time" still competes with the coach\'s targets');
  check(r.wu&&r.wuLogged,'no warm-ups prescribed or logged for the first heavy lift');
  check(r.nudge,'no time nudge when the session runs long');
  check(r.finSheet,'no finish sheet');
  check(r.resume,'no resume bar on Today for a session in progress');
  check(r.fin.n===1&&r.fin.effort==='Solid'&&r.fin.nig==='Shoulder'&&!r.fin.live,`finish didn't save in one tap: ${JSON.stringify(r.fin)}`);
  if(!r.prog.ctx)check(r.prog.up>60&&r.prog.hold===60,`progression from sets wrong: held -> ${r.prog.up}, fell -> ${r.prog.hold}`);
  check(r.rm,'race card has no plan line, or the full plan has no splits');
  check(errors.length===0,`agreements: page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// The live gym session and the day around it: warm-ups, rest, supersets, PR attempts,
// easy weeks, trimming, swaps, coach's picks, run-and-lift, skipping, the done card,
// run times typed with dots, and the nicotine plan in puffs.
async function gymLive(browser){
  const {ctx,page,errors}=await boot(browser);
  const r=await page.evaluate(()=>{const o={};
    try{
    // Time typed on the iPhone number pad
    o.time=[parseTimeToSecs('31.39'),parseTimeToSecs('1.05.20'),parseTimeToSecs('43:10'),normTime('31,39')];
    showPage('train');switchTrainTab('gym');
    const type=['Push','Pull','Legs'].find(t=>planGymSession(t))||'Push';
    buildGymSession(type);restStop();
    const ex0=gymDraft.exercises[0];
    // Warm-ups: the pad offers them first, and a light set before work counts as one
    const wl=_wuLeft(ex0);o.wuPlan=_wuPlan(ex0).length;
    if(wl.length){o.padFirst=+_gymKpDraft.weight===wl[0][0]&&!!_gymKpDraft.wu;gymKpLogSet();restStop();o.wuLogged=!!ex0.sets[0].warmup;o.noWorkYet=_gcWorking(ex0).length===0;}
    // Rest depends on the set
    const ex=gymDraft.exercises.find(e=>/press|bench|row|squat|pulldown/i.test(e.name))||ex0;
    const heavy=getSmartRest({name:ex.name,_planSets:9,sets:[]},{weight:'200',reps:'3',_tgtR:6}).secs;
    const light=getSmartRest({name:ex.name,_planSets:9,sets:[]},{weight:'10',reps:'15',_tgtR:10}).secs;
    o.rest=[heavy,light];
    // Length choice changes the session; Long isn't offered in race/taper weeks
    _gymLen='short';const S=planGymSession(type);_gymLen='long';const L=planGymSession(type);_gymLen='coach';const C=planGymSession(type);
    o.len={s:S.mins,c:C.mins,l:L.mins,longOk:C.longOk,pairs:S.rows.some(x=>x.pairWith)||S.rows.length<2};
    // Coach's picks add exercises and time
    const n0=gymDraft.exercises.length,m0=gymDraft.planMins,picks=_coachExtraPicks();
    if(picks.length){gymAddCoachPicks(1);o.picks=gymDraft.exercises.length===n0+1&&gymDraft.planMins>m0;}else o.picks=true;
    // Swap offers lifts for the same muscles
    gymSwapEx(gymDraft.exercises.length-1);o.swap=document.querySelectorAll('#session-detail-content .ga-opts button').length;closeModal('session-detail-modal');
    // Trim to fit keeps at least two lifts
    gymDraft.startedAt=Date.now()-120*60000;gymTrimToFit();o.trim=gymDraft.exercises.length>=Math.min(2,n0);
    // Fatigue: reps falling away on two lifts
    const f=(e,rs)=>{e.sets=rs.map(x=>({weight:'40',reps:String(x),warmup:false}));};
    if(gymDraft.exercises.length>=2){f(gymDraft.exercises[0],[8,6,4]);f(gymDraft.exercises[1],[10,7,5]);o.fatigue=!!_gymFatigue();}else o.fatigue=true;
    // Keypad pinned and the current set in view
    gymDraft.startedAt=Date.now();gymDraft.exercises.forEach(e=>{e.sets=[{weight:'',reps:'',warmup:false}];e._completed=false;});_gymFocusIdx=0;gymKpResetTarget();renderGymLogger();
    o.kp=getComputedStyle(document.querySelector('.gx .kp')).position==='sticky';
    o.more=document.querySelectorAll('.gx-more button').length===4;
    gymDiscardSession();
    }catch(e){o.err=e.message;}
    return o;});
  check(!r.err,`gym live threw: ${r.err}`);
  check(r.time&&r.time[0]===1899&&r.time[1]===3920&&r.time[2]===2590&&r.time[3]==='31:39',`run times with dots: ${JSON.stringify(r.time)}`);
  if(r.wuPlan){check(r.padFirst,'keypad doesn\'t offer the warm-up first');check(r.wuLogged&&r.noWorkYet,'a warm-up on the keypad counted as a working set');}
  check(r.rest&&r.rest[0]>r.rest[1],`rest doesn't follow the set: heavy ${r.rest&&r.rest[0]}s vs light ${r.rest&&r.rest[1]}s`);
  check(r.len&&r.len.s<=r.len.c&&(!r.len.longOk||r.len.l>=r.len.c),`Short/Coach's/Long out of order: ${JSON.stringify(r.len)}`);
  check(r.len&&r.len.pairs,'Short doesn\'t pair lifts as supersets');
  check(r.picks,'coach\'s picks didn\'t add an exercise and time');
  check(r.swap>0,'swap offered nothing');
  check(r.trim,'trim to fit dropped below two lifts');
  check(r.fatigue,'falling reps on two lifts weren\'t flagged');
  check(r.kp,'keypad isn\'t pinned in live mode');
  check(r.more,'quick actions row missing under the sets');
  // Run and lift, skip, done card, nicotine in puffs
  const r2=await page.evaluate(()=>{const o={};try{
    const cw=getCalendarWeek(0),d=cw.days.find(x=>x.isToday);
    showPage('today');
    o.addGymBtn=!d.gym&&d.planned.some(x=>x.km&&x.type!=='Race')?[...document.querySelectorAll('.tp-acts button')].some(b=>b.textContent==='Add gym'):true;
    // Skip today's gym (if any) moves it or drops it, and undo restores
    if(d.gym){const before=JSON.stringify(getCalendarWeek(0).days.map(x=>x.gym));skipTodayGym();const after=getCalendarWeek(0).days.find(x=>x.isToday).gym;o.skip=!after;undoSkipGym();o.undo=JSON.stringify(getCalendarWeek(0).days.map(x=>x.gym))===before;}else{o.skip=o.undo=true;}
    // Log a run today and a gym session: the done card lists both
    const runs=loadRunData();runs.push({date:dk(today()),km:6,time:'30.00',effort:'Easy',loggedAt:Date.now()});saveRunData(runs);
    const g=loadGymData();g.push({date:dk(today()),type:'Push',ts:Date.now()-3600e3,endTs:Date.now()-1800e3,effort:'Solid',exercises:[{name:'Bench press',sets:[{weight:'60',reps:'8'}]}]});saveGymData(g);
    _cwMemo={};showPage('today');
    const txt=(document.querySelector('.td-list')||{}).innerText||'';o.done=/6 km/i.test(txt)&&/push/i.test(txt);
    o.planGym=[...document.querySelectorAll('.pc-day.today .pc-item')].some(x=>/push/i.test(x.innerText));
    // Nicotine plan reads in puffs when a strength is logged
    if(typeof getNicPlan==='function'&&state.nicPlan){showPage('trends');switchTrendsTab('wellness');o.puffs=/puffs a day/.test((document.querySelector('.np-card')||{}).innerText||'');}else o.puffs=true;
  }catch(e){o.err=e.message;}return o;});
  check(!r2.err,`day flow threw: ${r2.err}`);
  check(r2.addGymBtn,'no Add gym on a run-only day');
  check(r2.skip&&r2.undo,'skip today\'s gym / undo didn\'t work');
  check(r2.done,'done card doesn\'t list both the run and the gym session');
  check(r2.planGym,'plan doesn\'t show the gym session done today');
  check(r2.puffs,'nicotine plan not in puffs');
  check(errors.length===0,`gym live: page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// The two-session programme: templates, double progression, fractional volume, legs held
// near races, swaps remembered, Strength and Size alternating.
async function programme(browser){
  const {ctx,page,errors}=await boot(browser);
  const r=await page.evaluate(()=>{const o={};
    const keep={gc:getGymContext,rk:_gcReadyKey,ph:getGymRacePhase,pd:_gcPlanDay};
    try{
      o.target=state.builtinTargets.gym===2&&state.gymProg1===1;
      o.plans=['Strength','Size','Pump'].map(t=>{const P=planGymSession(t);return P?P.rows.length:0;});
      o.weights=getExMuscleWeights('Plate bench press');
      // Double progression, with a normal day stubbed in
      getGymContext=()=>({layoff:3,comeback:false,race:null,dRace:null});_gcReadyKey=()=>'ready';
      const S=(w,rs)=>rs.map(x=>({weight:String(w),reps:String(x)}));
      const sl={lo:8,hi:12};
      o.up=_progTarget('Seated row',sl,S(50,[12,12,12]));
      o.rep=_progTarget('Seated row',sl,S(50,[10,9,9]));
      o.under=_progTarget('Lat pulldown',sl,S(59,[5,5]),true);
      o.bw=_progTarget('Chin up',sl,S(0,[12,12]));
      o.fresh=_progTarget('Romanian deadlift',sl,[]);
      // Every upper-body muscle gets a direct lift in every Strength and Size session, short or standard
      {const UP=['Chest','Back','Shoulders','Biceps','Triceps'],keepCW=getCalendarWeek,keepLen=_gymLen;o.cover=[];
       for(const day of [[],[{type:'Tempo',sub:'Tempo',km:8}]]){getCalendarWeek=()=>({days:[{isToday:true,planned:day}]});
         for(const len of ['short','coach'])for(const t of ['Strength','Size']){_gymLen=len;const P=planGymSession(t);
           const miss=UP.filter(m=>!P.rows.some(r=>(exCat(r.name)||{m:[]}).m.includes(m)));if(miss.length)o.cover.push(`${t} ${len}: ${miss}`);if(len==='short'&&P.mins>30)o.cover.push(`${t} short is ${P.mins} min`);}}
       // Supersets only ever pair lifts at the same spot
       const shot=[];for(const t of ['Strength','Size','Pump']){_gymLen='coach';const P=planGymSession(t);P.rows.forEach(r=>{if(r.pairWith&&exStation(r.name)!==exStation(r.pairWith))shot.push(`${r.name}+${r.pairWith}`);});}
       if(shot.length)o.cover.push(`two-station supersets: ${shot}`);
       getCalendarWeek=keepCW;_gymLen=keepLen;}
      // Legs: held with a race in five days, in (and eased) when the calendar is clear
      getGymContext=()=>({layoff:3,comeback:false,race:null,dRace:5});
      o.held=planGymSession('Strength').rows.some(x=>x.legs);
      getGymContext=()=>({layoff:3,comeback:false,race:null,dRace:null});getGymRacePhase=()=>null;_gcPlanDay=()=>({type:'Rest',runType:'Easy',gym:null,day:'Monday'});
      const leg=planGymSession('Strength').rows.find(x=>x.legs);o.legIn=!!leg;o.legEased=leg&&leg.sets<=2;
      // Swaps are remembered for the slot
      buildGymSession('Strength');restStop();
      const i=gymDraft.exercises.findIndex(e=>e._slot==='Strength.0');
      gymDoSwap(i,'Bench press');o.pref=state.gymSlotPref&&state.gymSlotPref['Strength.0']==='Bench press'&&_progPick('Strength',0)==='Bench press'&&!!gymDraft.exercises[i]._tgtOverride;
      delete state.gymSlotPref['Strength.0'];saveState();
      // Logging the warm-ups starts a gap timer before the first working set, sized to it
      {buildGymSession('Strength');restStop();const j=gymDraft.exercises.findIndex(e=>_wuPlan(e).length);
       if(j>=0){gymLogWarmups(j);o.wuGap=restEndsAt>0&&restTotal>=45&&restTotal<=150&&/Warm-ups done/.test(document.getElementById('rest-overlay-label').textContent);restStop();}else o.wuGap=true;
       gymDiscardSession();buildGymSession('Strength');restStop();}
      // Finish screen says what each lift does next time
      gymDraft.exercises[1].sets=S(40,[10,10,10]);openGymFinish();o.nextTime=document.querySelectorAll('#gym-finish-content .gf-nx').length;closeModal('gym-save-modal');
      gymDiscardSession();
      // Rest starts at 2 min for compounds and 75 s for isolation; auto-saved library rests
      // don't count, one you set yourself does
      o.restBase=[_restBase('Plate bench press'),_restBase('Lateral Raises')];
      {const pr=loadGymProg();pr['Lateral Raises']=pr['Lateral Raises']||{history:[]};const keepR={...pr['Lateral Raises']};pr['Lateral Raises'].restSeconds=90;pr['Lateral Raises'].restUser=true;saveGymProg(pr);
       o.restUser=_restBase('Lateral Raises');const pr2=loadGymProg();pr2['Lateral Raises']=keepR;saveGymProg(pr2);}
      // The session clock follows the pace: slow sets push the finish out, quick ones pull it in
      const pace=gap=>{buildGymSession('Strength');restStop();const ex=gymDraft.exercises[0],t0=Date.now()-4*gap*1000;
        ex.sets=[0,1,2].map(j=>({weight:'60',reps:'8',warmup:false,_at:t0+j*gap*1000,_rest:120}));
        const P=_gymProj(),r={f:P.pace.f,end:P.end,plan:gymDraft.planMins};gymDiscardSession();return r;};
      o.slow=pace(330);o.quick=pace(95);
      // The programme card: this week, 9 weeks of consistency, balance bars
      showPage('train');switchTrainTab('gym');o.card=!!document.querySelector('.gpc h3')&&document.querySelectorAll('.gpc-con > div').length===9&&document.querySelectorAll('.gpc-b').length===5;
      // The picker shows the programme first
      showPage('train');switchTrainTab('gym');gymBackToPlan();gymShowOtherTypes();o.tiles=document.querySelectorAll('.gp-types button').length;
      // Strength done today, Size is next
      const g=loadGymData();g.push({date:dk(today()),type:'Strength',ts:Date.now(),exercises:[{name:'Plate bench press',sets:S(60,[8,8,8])}]});saveGymData(g);
      _gymAutoCache={t:0,v:null};o.next=_coachGymType();
    }catch(e){o.err=e.message+' '+(e.stack||'').split('\n')[1];}
    getGymContext=keep.gc;_gcReadyKey=keep.rk;getGymRacePhase=keep.ph;_gcPlanDay=keep.pd;
    return o;});
  check(!r.err,`programme threw: ${r.err}`);
  check(r.target,'gym target not moved to 2 for the programme');
  check(r.plans&&r.plans.every(n=>n>=3),`programme sessions too thin: ${JSON.stringify(r.plans)}`);
  check(r.weights&&r.weights.Chest===1&&r.weights.Triceps===0.5,`bench isn't 1 chest + 0.5 triceps: ${JSON.stringify(r.weights)}`);
  check(r.up&&r.up.weight===52.5&&r.up.reps===8,`top of the range didn't add weight: ${JSON.stringify(r.up)}`);
  check(r.rep&&r.rep.weight===50&&r.rep.reps===10,`inside the range didn't add a rep: ${JSON.stringify(r.rep)}`);
  check(r.under&&r.under.weight<59&&r.under.reps===8&&r.under.tag==='New range',`under the range didn't lighten: ${JSON.stringify(r.under)}`);
  check(r.bw&&r.bw.tag==='Add load',`bodyweight at the top didn't say add load: ${JSON.stringify(r.bw)}`);
  check(r.fresh&&r.fresh.tag==='New'&&r.fresh.weight==null,'a new lift got a made-up weight');
  check(r.cover&&!r.cover.length,`a muscle loses its direct lift: ${JSON.stringify(r.cover)}`);
  check(r.held===false,'legs programmed five days before a race');
  check(r.legIn&&r.legEased,'legs missing (or not eased in) on a clear day');
  check(r.pref,'swap in a programme slot not remembered');
  check(r.restBase&&r.restBase[0]===120&&r.restBase[1]===75,`rest doesn't start at 2 min / 75 s: ${JSON.stringify(r.restBase)}`);
  check(r.restUser===90,`your own rest isn't the starting point: ${r.restUser}`);
  check(r.slow&&r.slow.f>1.05&&r.quick&&r.quick.f<0.95&&r.slow.end>r.quick.end,`session clock ignores the pace: ${JSON.stringify([r.slow,r.quick])}`);
  check(r.wuGap,'no timer between the last warm-up and the first working set');
  check(r.nextTime>=1,'finish screen has no next-time targets');
  check(r.card,'programme card missing or incomplete');
  check(r.tiles===3,`programme tiles: ${r.tiles}`);
  check(r.next==='Size',`after Strength the coach picked ${r.next}`);
  check(errors.length===0,`programme: page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

(async()=>{
  const browser=await chromium.launch();
  try{
    await sweep(browser);
    await planRules(browser,'coach');
    await planRules(browser,'coach+busy',d=>{d.state.availCustom=true;d.state.avail=[0,1,2,3,4,5,6].map(i=>({run:i!==4,long:i>=5,gym:i===0||i===3}));});
    await planRules(browser,'manual',d=>{d.state.planMode='manual';d.state.weekPlan=['Rest','Run','Run','Run','Rest','Run','Run'];d.state.weekPlanRunType=[null,'Tempo','Easy','Auto','Easy','Easy','Long'];d.state.weekPlanGym=['Push',null,null,'Pull',null,null,null];});
    await agreements(browser);
    await gymLive(browser);
    await programme(browser);
    await nextYear(browser);
  }finally{await browser.close();}
  console.log(`${checks-failures.length}/${checks} checks passed`);
  if(failures.length){console.log('\nFAILURES:\n- '+failures.join('\n- '));process.exit(1);}
})();
