const fs=require('node:fs'),path=require('node:path');
const base='backups/ai-detailed-chuan-20261014',old='backups/ai-detailed-results-20261014-1030/RESULTS',input='backups/ai-detailed-production-2026-10-13/INPUT';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const maps=read(base+'/INPUT_KEY_REMAP-20261014.json');
const stats={changed_files:[],completed_questions:0,review_questions:0,question_with_passage_schema:0,evidence:{exact:0,punctuation_only:0,unresolved:0},verdict_mismatches:[],labels:{exact:0,display_number:0,other:0},star_missing_fields:0,unresolved_quotes:[],map_checks:[]};
const compact=s=>String(s||'').replace(/\s+/g,'');
const relaxed=s=>String(s||'').normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
for(const name of fs.readdirSync(base+'/RESULTS').filter(n=>/^batch-\d+\.json$/.test(n)).sort()){
 const file=base+'/RESULTS/'+name;
 if(!fs.readFileSync(file).equals(fs.readFileSync(path.join(old,name))))stats.changed_files.push(name);
 const r=read(file),src=read(path.join(input,name));
 for(const item of r.items){const u=src.units.find(u=>u.id===item.id);if(item.status!=='completed'){stats.review_questions+=u.questions.length;continue;}stats.completed_questions+=u.questions.length;const e=item.explanation;
 if(u.kind==='question'&&e.questions)stats.question_with_passage_schema++;
 if(u.question_type==='sentence_order'&&(!e.sentence_order_solution?.ordered_sentence_ja||!e.sentence_order_solution?.reason_vi))stats.star_missing_fields++;
 const qs=Array.isArray(e.questions)?e.questions:[e];
 const source=[u.passage_text,...u.questions.map(q=>q.transcript_candidate||'')].join('\n');
 qs.forEach((q,i)=>{const orig=u.questions[i];if(!orig)return;
 if(q.question_label!==undefined){const display=orig.question_text.match(/^\s*(\d+)/)?.[1];stats.labels[q.question_label===orig.question_label?'exact':q.question_label===display?'display_number':'other']++;}
 const mapping=maps[item.id]?.['q'+i];
 if(mapping)for(const [k,v] of Object.entries(mapping)){const prefix=orig.options[k]?.match(/^\s*(\d+)/)?.[1];if(prefix!==v)stats.map_checks.push({id:item.id,question:i,key:k,mapped:v,prefix});}
 const correct=(q.option_analysis||[]).filter(o=>o.verdict==='correct').map(o=>o.option);const expected=mapping?.[orig.correct_answer]??orig.correct_answer;
 if(correct.length!==1||correct[0]!==expected)stats.verdict_mismatches.push({file:name,id:item.id,question:i,expected,actual:correct});
 for(const v of q.evidence||[]){if(compact(v.quote_ja)&&compact(source).includes(compact(v.quote_ja)))stats.evidence.exact++;else if(relaxed(v.quote_ja)&&relaxed(source).includes(relaxed(v.quote_ja)))stats.evidence.punctuation_only++;else{stats.evidence.unresolved++;if(stats.unresolved_quotes.length<12)stats.unresolved_quotes.push({file:name,id:item.id,quote:v.quote_ja,source});}}
 });
 }
}
fs.writeFileSync(base+'/revision-comparison.json',JSON.stringify(stats,null,2));
console.log(JSON.stringify({...stats,verdict_mismatches:stats.verdict_mismatches.slice(0,8),verdict_mismatch_count:stats.verdict_mismatches.length,unresolved_quotes:stats.unresolved_quotes.slice(0,2)},null,2));
