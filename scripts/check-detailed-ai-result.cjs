const fs=require('node:fs');
const path=require('node:path');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
function main(){
 const [folder,file]=process.argv.slice(2);if(!folder||!file)throw Error('Usage: node scripts/check-detailed-ai-result.cjs <package> <result.json>');
 const r=read(file);if(!/^batch-\d{4,}$/.test(r.batch_id))throw Error('Invalid batch_id');
 const input=read(path.join(folder,'INPUT',r.batch_id+'.json'));const errors=[];const seen=new Set();
 const check=(ok,msg)=>{if(!ok)errors.push(msg);};const nonempty=x=>typeof x==='string'&&!!x.trim();
 check(r.format_version===2,'format_version must be 2');check(Array.isArray(r.items),'items must be array');
 for(const item of r.items||[]){
  const u=input.units.find(u=>u.id===item.id);check(!!u,'Unknown ID '+item.id);if(!u)continue;
  check(!seen.has(item.id),'Duplicate '+item.id);seen.add(item.id);check(u.source_sha256===item.source_sha256,'Hash mismatch '+item.id);
  if(item.status==='needs_human_review'){check(item.explanation===null&&nonempty(item.review_note_vi),'Review requires null explanation and note: '+item.id);continue;}
  check(item.status==='completed','Invalid status '+item.id);const e=item.explanation;check(e&&typeof e==='object'&&!Array.isArray(e),'Missing explanation '+item.id);if(!e)continue;
  function options(a,q){check(Array.isArray(a)&&a.length===Object.keys(q.options).length,'Option count '+item.id);const keys=new Set();for(const o of a||[]){check(Object.hasOwn(q.options,o.option)&&!keys.has(o.option),'Option ID '+item.id);keys.add(o.option);check(nonempty(o.reason_vi)&&nonempty(o.meaning_vi),'Option text '+item.id);check(o.verdict===(o.option===q.correct_answer?'correct':'wrong'),'Verdict '+item.id);}}
  function evidence(a){check(Array.isArray(a)&&a.length>0,'Missing evidence '+item.id);const source=[u.passage_text,...u.questions.map(q=>q.transcript_candidate||'')].join('\n').replace(/\s+/g,'');for(const v of a||[])check(nonempty(v.quote_ja)&&nonempty(v.explanation_vi)&&source.includes(v.quote_ja.replace(/\s+/g,'')),'Ungrounded evidence '+item.id);}
  if(u.kind==='question'){
   options(e.option_analysis,u.questions[0]);for(const k of ['question_ja','question_reading_hira','question_translation_vi','key_point_vi'])check(nonempty(e[k]),'Missing '+k+' '+item.id);
   for(const k of ['reasoning_steps_vi','options_with_reading','key_vocab','grammar_points','trap_patterns_vi'])check(Array.isArray(e[k]),'Missing array '+k+' '+item.id);
   if(['grammar_choice','vocab_context','vocab_word_formation'].includes(u.question_type))check(nonempty(e.completed_sentence_ja)&&nonempty(e.completed_sentence_translation_vi),'Missing completed sentence '+item.id);
   if(['reading_content','reading_cloze','listening'].includes(u.question_type))evidence(e.evidence);
   if(u.question_type==='sentence_order'){const s=e.sentence_order_solution;check(s&&Array.isArray(s.ordered_options)&&s.ordered_options.length===4&&new Set(s.ordered_options).size===4&&s.ordered_options.every(k=>Object.hasOwn(u.questions[0].options,k))&&s.star_option===u.questions[0].correct_answer&&nonempty(s.reason_vi),'Invalid star solution '+item.id);}
  }else{
   check(Array.isArray(e.sentence_readings)&&e.sentence_readings.length>0,'Missing sentence translations '+item.id);
   for(const [i,s] of (e.sentence_readings||[]).entries())check(s.index===i+1&&nonempty(s.sentence_ja)&&nonempty(s.translation_vi)&&Array.isArray(s.vocab),'Invalid sentence '+item.id);
   check(Array.isArray(e.questions)&&e.questions.length===u.questions.length,'Question count '+item.id);
   for(const [i,q] of (e.questions||[]).entries()){const orig=u.questions[i];if(!orig)continue;check(q.question_label===orig.question_label&&q.correct_option===orig.correct_answer&&nonempty(q.reasoning_vi),'Question identity/reason '+item.id);options(q.option_analysis,orig);evidence(q.evidence);}
  }
 }
 check(seen.size===input.units.length,'Missing items');if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({batch:r.batch_id,items:seen.size,completed:r.items.filter(i=>i.status==='completed').length,needs_human_review:r.items.filter(i=>i.status==='needs_human_review').length,structural_check:'passed',database_writes:0},null,2));
}
try{main();}catch(e){console.error(e.message);process.exitCode=1;}
