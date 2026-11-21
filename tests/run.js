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
    buildGymSession('Push');
    // Race kit: the plan's splits finish on its target, and race mode renders
    const rp=racePacePlan(state.race);out.race=!!rp&&rp.splits[rp.splits.length-1].t===Math.round(rp.target);
    _rmOpen=true;renderRaceMode();out.rm=/Your race plan/.test(document.getElementById('race-mode').innerText);
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
  check(r.fin.n===1&&r.fin.effort==='Solid'&&r.fin.nig==='Shoulder'&&!r.fin.live,`finish didn't save in one tap: ${JSON.stringify(r.fin)}`);
  if(!r.prog.ctx)check(r.prog.up>60&&r.prog.hold===60,`progression from sets wrong: held -> ${r.prog.up}, fell -> ${r.prog.hold}`);
  check(r.rm,'race mode has no race plan');
  check(errors.length===0,`agreements: page errors: ${errors.join(' | ')}`);
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
    await nextYear(browser);
  }finally{await browser.close();}
  console.log(`${checks-failures.length}/${checks} checks passed`);
  if(failures.length){console.log('\nFAILURES:\n- '+failures.join('\n- '));process.exit(1);}
})();
