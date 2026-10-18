const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve('backups/ai-detailed-production-2026-10-13');
const results=path.resolve(process.argv[2] || 'backups/ai-detailed-results-20261014-1030/RESULTS');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const script=new vm.Script(fs.readFileSync('scripts/check-detailed-ai-result.cjs','utf8'));
const report={batches:0,statuses:{},types:{},errors:[],samples:{},notes:{}};
for(const file of fs.readdirSync(results).filter(n=>/^batch-.*\.json$/.test(n)).sort()){
 const r=read(path.join(results,file)),input=read(path.join(root,'INPUT',file));report.batches++;
 const logs=[];script.runInNewContext({require,process:{argv:['node','check',root,path.join(results,file)],exitCode:0},console:{log:()=>{},error:m=>logs.push(m)}});
 if(logs.length)report.errors.push({file,errors:logs});
 for(const item of r.items){const u=input.units.find(u=>u.id===item.id);report.statuses[item.status]=(report.statuses[item.status]||0)+1;
 const t=u?.question_type||'unknown';report.types[t]??={};report.types[t][item.status]=(report.types[t][item.status]||0)+1;
 if(item.status==='completed'){report.samples[t]??=[];if(report.samples[t].length<2)report.samples[t].push({file,source:u,result:item});}
 else{const note=item.review_note_vi;report.notes[note]=(report.notes[note]||0)+1;}
 }
}
const dest=path.dirname(results);fs.writeFileSync(path.join(dest,'audit-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,samples:Object.fromEntries(Object.entries(report.samples).map(([k,v])=>[k,v.map(s=>s.file)])),errors:report.errors.slice(0,15),error_batches:report.errors.length,notes:Object.entries(report.notes).sort((a,b)=>b[1]-a[1]).slice(0,15)},null,2));
