// Offline descriptive audit. Frequencies do not establish bias or change decisions.
const fs=require('node:fs'),path=require('node:path')
const {ACTIONS}=require('../src/enterprise-action-contract')
function audit(runs){
 const frequency=()=>Object.fromEntries(ACTIONS.map(a=>[a.id,0])),initial=frequency(),final=frequency(),selected=frequency();let seats=0
 const cases=runs.map(run=>{const s=run.stages?.condition;if(!s)return null;const before=s.initial_candidates||[],after=s.candidates||[];seats+=before.length
  for(const c of before)for(const id of c.recommendations||[])initial[id]++
  for(const c of after)for(const id of c.recommendations||[])final[id]++
  for(const id of s.code||[])selected[id]++
  return {run_id:run.run_id,action_options_version:run.action_options_version || 'legacy-10-options',selected_seat:s.selected_seat_id,codes:s.code,initial:before.map(c=>({seat_id:c.seat_id,codes:c.recommendations})),changes:after.map(c=>{const old=before.find(a=>a.seat_id===c.seat_id)?.recommendations||[];return {seat_id:c.seat_id,added:(c.recommendations||[]).filter(x=>!old.includes(x)),removed:old.filter(x=>!(c.recommendations||[]).includes(x))}})}
 }).filter(Boolean)
 const versionCounts=Object.fromEntries([...new Set(cases.map(c=>c.action_options_version))].map(v=>[v,cases.filter(c=>c.action_options_version===v).length]))
 return {action_options_version_counts:versionCounts,mixed_option_versions:Object.keys(versionCounts).length>1,notice:'描述性频率不能证明偏置，也不触发改选或额外讨论。需同一证据、多次及不同模型受控验证。旧2/4与新2/4含义不同，跨选项版本频率不得用于效果结论。',case_count:cases.length,initial_seat_count:seats,initial_frequency:initial,final_frequency:final,selected_frequency:selected,exact_2_4:cases.filter(c=>c.codes?.length===2&&c.codes.includes(2)&&c.codes.includes(4)).length,contains_2_4:cases.filter(c=>c.codes?.includes(2)&&c.codes.includes(4)).length,cases,option_order_controls:{original:ACTIONS,reverse:[...ACTIONS].reverse(),rotated:[...ACTIONS.slice(5),...ACTIONS.slice(0,5)]}}
}
if(require.main===module){if(process.argv.length<3)throw new Error('Usage: node scripts/audit-action-selection.js run.json ...');console.log(JSON.stringify(audit(process.argv.slice(2).map(file=>JSON.parse(fs.readFileSync(path.resolve(file),'utf8')))),null,2))}
module.exports={audit}
