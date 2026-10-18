const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: '.env.local', override: true });
const { PrismaClient } = require('@prisma/client');
const { inferJlptQuestionMeta } = require('../dist/lib/jlptQuestionType');
const { explanationSourceText, questionTeachingRules, EXPLANATION_FORMAT_RULES } = require('../dist/lib/examExplanationStandards');
const { buildPrompt, buildPassagePrompt } = require('../dist/lib/examExplanation');
const db = new PrismaClient();
const out = path.resolve(process.argv[2] || 'backups/ai-detailed-production-2026-10-13');
const stringify = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 2);
const hash = v => crypto.createHash('sha256').update(stringify(v)).digest('hex');
const write = (name, value) => { const file = path.join(out, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : stringify(value), 'utf8'); };
const text = explanationSourceText;
async function main() {
  if (fs.existsSync(out)) throw new Error('Output already exists');
  const rows = await db.jlptExam.findMany({ orderBy: [{level:'asc'}, {exam_id:'asc'}, {part:'asc'}] });
  const units = [];
  const rules = {};
  for (const row of rows) {
    const data = row.json_data;
    for (const [si, section] of (data.sections || []).entries()) {
      const groups = new Map();
      for (const [qi, q] of (section.questions || []).entries()) {
        const rawIds = q.passage_id ?? q.pid;
        const ids = (Array.isArray(rawIds) ? rawIds : rawIds == null ? [] : [rawIds]).map(String);
        const passages = (data.passages || []).filter(p => ids.includes(String(p.passage_id ?? p.pid)));
        const passageText = passages.map(p => text(p.passage_html ?? p.passage)).join('\n');
        const options = Object.fromEntries(Object.entries(q.options || {}).map(([k,v]) => [k,text(v)]));
        const questionText = text(q.ques ?? q.question_html ?? '');
        const meta = inferJlptQuestionMeta({level:row.level,part:row.part,sectionTitle:text(section.sec),questionLabel:String(q.qid ?? qi+1),questionText,optionTexts:Object.values(options),hasPassage:!!passageText,isClozeQuestion:!!passageText && /^\s*[（(]?\s*\d+\s*[）)]?\s*$/.test(questionText)});
        rules[meta.questionType] = questionTeachingRules(meta.questionType);
        const grouped = ['reading_cloze','reading_content'].includes(meta.questionType) && ids.length;
        const key = grouped ? `${meta.questionType}:${ids.slice().sort().join(',')}` : `q:${qi}`;
        if (!groups.has(key)) groups.set(key, {kind:grouped?'passage':'question',question_type:meta.questionType,strategy:meta.strategyVi,teaching_rules:rules[meta.questionType],location:{level:row.level,exam_id:row.exam_id,part:row.part,section_index:si},section_html:section.sec,passages,passage_text:passageText,questions:[]});
        groups.get(key).questions.push({question_index:qi,question_label:String(q.qid ?? qi+1),question_text:questionText,options,correct_answer:String(q.answer ?? ''),original_question:q,transcript_candidate:row.part===3?text(q.expl ?? q.explanation ?? q.exp ?? ''):null});
      }
      for (const unit of groups.values()) {
        unit.id = `${row.level}:${row.exam_id}:${row.part}:${si}:${unit.questions.map(q=>q.question_index).join('-')}`;
        unit.source_sha256 = hash(unit);
        units.push(unit);
      }
    }
  }
  const base = {level:'N2',examId:'EXAMPLE',part:1,sectionTitle:'',questionLabel:'1',mondaiLabel:'',questionType:'grammar_choice',questionTypeLabelVi:'',typeStrategyVi:'',questionText:'',questionWithBlank:'',questionWithAnswer:'',blankLabels:[],isClozeQuestion:false,options:{},correctAnswer:'',passageText:'',questions:[]};
  write('REFERENCE/QUESTION_PROMPT.txt',buildPrompt(base,{questionReadingHira:'',optionReadings:{}}));
  write('REFERENCE/PASSAGE_PROMPT.txt',buildPassagePrompt({...base,questionType:'reading_content'},{sentenceReadings:[],questionOptionReadings:{},questionBlankReadings:{},questionAnswerReadings:{},passageReadingHira:''}));
  write('REFERENCE/TYPE_RULES.json',rules);
  write('REFERENCE/COMMON_RULES.txt',EXPLANATION_FORMAT_RULES);
  for (const file of ['examExplanation.ts','examExplanationStandards.ts','jlptQuestionType.ts']) write(`REFERENCE/source/${file}`,fs.readFileSync(`src/lib/${file}`,'utf8'));
  const manifest = [];
  let pending=[];
  function flush(){if(!pending.length)return; const id=`batch-${String(manifest.length+1).padStart(4,'0')}`; const input={format_version:2,batch_id:id,units:pending};write(`INPUT/${id}.json`,input);write(`TEMPLATES/${id}.json`,{format_version:2,batch_id:id,items:pending.map(u=>({id:u.id,source_sha256:u.source_sha256,status:'pending',review_note_vi:'',explanation:null}))});manifest.push({batch_id:id,units:pending.length,questions:pending.reduce((s,u)=>s+u.questions.length,0),types:[...new Set(pending.map(u=>u.question_type))],status:'pending'});pending=[];}
  for(const unit of units){if(unit.kind==='passage'){flush();pending=[unit];flush();}else{pending.push(unit);if(pending.length===3)flush();}}flush();
  write('MANIFEST.json',{exported_at:new Date().toISOString(),source:'Local restored from production on 2026-10-13; content-only export',exam_parts:rows.length,question_count:units.reduce((s,u)=>s+u.questions.length,0),unit_count:units.length,batches:manifest});
  write('RESULTS/.gitkeep','');
  write('START_HERE.md',fs.readFileSync('docs/ai-detailed-handoff.md','utf8'));
  console.log(stringify({folder:out,questions:units.reduce((s,u)=>s+u.questions.length,0),units:units.length,batches:manifest.length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
