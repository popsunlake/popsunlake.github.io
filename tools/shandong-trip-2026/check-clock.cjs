const assert=require('node:assert/strict');
const {chinaClock,scheduleState}=require('../../source/shandong-trip-2026/assets/trip.js');
const data=require('./content.json');
assert.equal(chinaClock(new Date('2026-09-08T16:01:00Z')).date,'2026-09-09');
const d=data.days.find(x=>x.id==='0909');
const sample=(time)=>scheduleState(d.date,d.timeline,new Date('2026-09-09T'+time+':00+08:00'));
assert.equal(sample('09:30').index,3);assert.equal(sample('09:30').kind,'current');
assert.equal(sample('11:20').kind,'next');assert.equal(sample('11:20').index,4);
assert.equal(sample('06:30').kind,'next');assert.equal(sample('20:00').kind,'finished');
assert.equal(scheduleState(d.date,d.timeline,new Date('2026-09-08T12:00:00+08:00')).kind,'before-day');
assert.equal(scheduleState(d.date,d.timeline,new Date('2026-09-10T12:00:00+08:00')).kind,'after-day');
for(const day of data.days)for(let i=0;i<day.timeline.length;i++){
 const t=day.timeline[i],date=new Date(day.date+'T'+t.start+':00+08:00');
 const state=scheduleState(day.date,day.timeline,date);assert.equal(state.kind,'current');assert.equal(state.index,i);
}
console.log('Passed: China timezone, all 71 start boundaries, gaps, pre-trip and post-trip states.');
