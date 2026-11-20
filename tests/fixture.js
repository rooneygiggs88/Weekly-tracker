// Synthetic training data for the tests: four months of a runner who lifts, relative to
// today so the plan, races and readiness always have something current to work with.
// No real personal data lives in the repo.
function dk(d){return d.toISOString().slice(0,10);}
function addDays(d,n){const x=new Date(d);x.setUTCDate(x.getUTCDate()+n);return x;}
function mondayOf(d){const x=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const w=(x.getUTCDay()+6)%7;return addDays(x,-w);}
function hms(secs){const h=Math.floor(secs/3600),m=Math.floor(secs%3600/60),s=Math.round(secs%60);return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;}

module.exports=function makeFixture(now=new Date()){
  const today=new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()));
  const thisMon=mondayOf(today);
  const run=[],gym=[],health=[],vaping=[],morning={};
  let t=Date.now()-200*864e5;
  for(let w=16;w>=0;w--){
    const mon=addDays(thisMon,-w*7);
    const long=14+((16-w)%5)*3;
    [[1,8,'Tempo',300],[2,10,'Easy',355],[3,10,'Easy',352],[5,8,'Easy',350],[6,long,'Long Run',365]].forEach(([d,km,effort,pace])=>{
      const day=addDays(mon,d);if(day>=today)return;
      run.push({date:dk(day),km,time:hms(km*pace),effort,hr:effort==='Tempo'?168:145,startTime:'07:30',loggedAt:(t+=3600e3)});
    });
    [[0,'Push'],[3,'Pull']].forEach(([d,type])=>{
      const day=addDays(mon,d);if(day>=today)return;
      const ex=type==='Push'?[['Bench press',60+(16-w)],['Overhead Press',35]]:[['Barbell Row',55+(16-w)*0.5],['Lat pulldown',50]];
      gym.push({date:dk(day),type,exercises:ex.map(([name,wt])=>({name,sets:[{weight:String(wt*0.5),reps:'10',warmup:true},{weight:String(wt),reps:'8'},{weight:String(wt),reps:'8'},{weight:String(wt),reps:'7'}]})),ts:Date.parse(dk(day))+3600e3,endTs:Date.parse(dk(day))+7200e3});
    });
    for(let d=0;d<7;d++){
      const day=addDays(mon,d);if(day>today)continue;const ds=dk(day);
      morning[ds]={hrv:55+((d*7+w)%12),rhr:50+((d+w)%4),sleep:65+((d*3+w)%20),feel:3+((d+w)%2),wake:'07:45'};
      vaping.push({date:ds,puffs:300-w*5+(d%3)*10,mg:6,ts:Date.parse(ds)});
      if(d%3===0)health.push({date:ds,weight:74-(16-w)*0.12,bodyFat:19-(16-w)*0.05});
    }
  }
  const yr=today.getUTCFullYear();
  const race1=addDays(today,9),race2=addDays(today,16);
  const state={
    userName:'Tester',planMode:'coach',wdV2:true,slotIdsV2:true,
    yearRunGoal:{year:yr,targetKm:2400,startRemaining:700,startedAt:Date.parse(dk(addDays(today,-60))),runsPerWeek:5,capMode:'safe'},
    race:{name:'Test 10K',date:dk(race1),km:10,goalTime:'44:45',priority:'A'},
    extraRaces:[{name:'Test Half',date:dk(race2),km:21.1,goalTime:'1:40:00',priority:'B'}],
    bodyCompGoal:{weight:70,bodyFat:15},
    customGoals:[{id:'g1',name:'Floss',type:'daily'}],
  };
  return{state,gym,run,health,prog:{},vaping,morning};
};
