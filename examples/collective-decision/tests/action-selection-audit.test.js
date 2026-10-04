const test=require('node:test'),assert=require('node:assert/strict'),{audit}=require('../scripts/audit-action-selection')
test('offline audit separates initial, broadcast and selection frequencies without forcing alternatives',()=>{
 const run={run_id:'r',stages:{condition:{initial_candidates:[{seat_id:'a',recommendations:[2,4,6]},{seat_id:'b',recommendations:[3]}],candidates:[{seat_id:'a',recommendations:[2,4]},{seat_id:'b',recommendations:[3,8]}],selected_seat_id:'a',code:[2,4]}}};const original=JSON.stringify(run),r=audit([run]);assert.equal(r.initial_frequency[6],1);assert.equal(r.final_frequency[6],0);assert.equal(r.final_frequency[8],1);assert.equal(r.selected_frequency[8],0);assert.equal(r.exact_2_4,1);assert.equal(r.contains_2_4,1);assert.equal(JSON.stringify(run),original)
 for(const options of Object.values(r.option_order_controls))assert.deepEqual(options.map(x=>x.id).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10,11,12,13])
});
