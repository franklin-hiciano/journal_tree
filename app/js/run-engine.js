// ── Reflection engine: black screen, one card at a time, blink between cards ───────
let currentRun=null;     // { runId, steps:[{nodeId,answer,next}], complete }
let tnode=null;
let _runSaveTimer=null;
let _commitSourceNode=null;   // node the user credits for this commitment (turns it gold)

function currentRunId(){return currentRun?currentRun.runId:null;}
function firstNode(){return Object.keys(parsedTree)[0]||null;}

// ── reflect entry — just check that the tree has at least one node ──
function attemptReflect(){
  if(!Object.keys(parsedTree).length)return;
  if(window._parseErrors&&window._parseErrors.length){flashReflectError();return;}
  startReflection();
}
function flashReflectError(){
  const btn=document.querySelector('.reflect-btn');
  if(!btn)return;
  btn.classList.remove('shake');
  void btn.offsetWidth; // restart the animation if it's already mid-shake
  btn.classList.add('shake');
  setTimeout(()=>btn.classList.remove('shake'),400);
}

// ── start / exit ──
function startReflection(){
  currentRun={runId:'run_'+Date.now(),steps:[],complete:false};
  tnode=firstNode();
  const sc=document.getElementById('reflectScreen');if(sc)sc.classList.add('on');
  renderCard();
}
function exitReflection(){
  const sc=document.getElementById('reflectScreen');if(sc)sc.classList.remove('on');
  currentRun=null;tnode=null;
}

// ── card render ──
function renderCard(){
  const node=parsedTree[tnode];
  document.getElementById('rcardEnd').style.display='none';
  document.getElementById('rcardMain').style.display='';
  const prompt=document.getElementById('rcardPrompt');if(prompt)prompt.textContent=node?node.title:'';
  const rc=document.getElementById('rcardRecall');if(rc)rc.innerHTML=buildRecall(node);
  const input=document.getElementById('rcardInput'),choices=document.getElementById('rcardChoices'),next=document.getElementById('rNext');
  if(node&&node.type==='text'){
    input.style.display='';choices.style.display='none';choices.innerHTML='';next.style.display='';
    const ip=document.getElementById('rInput');if(ip){ip.value='';setTimeout(()=>ip.focus(),60);}
  }else if(node){
    input.style.display='none';choices.style.display='';next.style.display='none';
    choices.innerHTML=node.opts.map((o,i)=>'<button class="ropt" onclick="chooseSingle('+i+')">'+esc(o.l)+'</button>').join('');
  }
  const back=document.getElementById('rBack');if(back)back.style.display=(currentRun&&currentRun.steps.length>0)?'':'none';
}
function buildRecall(node){
  if(!node||!node.title)return'';
  const map=window._recallMap||{};
  const sources=map[node.title];
  if(!sources||!sources.length)return'';
  let html='';
  sources.forEach(sourceId=>{
    const past=getPastAnswers(sourceId,1,7);
    html+='<div class="recall"><div class="recall-hd">↩ you, 1–7d ago · '+esc(sourceId)+'</div>';
    if(!past.length)html+='<div class="recall-empty">nothing in this window</div>';
    else past.forEach(p=>{const dd=p.date?new Date(p.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';html+='<div class="recall-row"><span class="recall-date">'+esc(dd)+'</span><span class="recall-txt">'+esc(p.text.slice(0,160))+'</span></div>';});
    html+='</div>';
  });
  return html;
}

// ── answers / recall ──
function answerText(a){if(!a)return'';if(a.type==='text')return a.text||'';if(a.type==='single')return a.label||'';if(a.type==='multi')return(a.selected||[]).join(', ');return'';}
function getPastAnswers(nodeId,a,b){
  const lo=Math.min(a,b),hi=Math.max(a,b),now=Date.now(),newC=now-lo*86400000,oldC=now-hi*86400000,out=[];
  getTreeRuns(_activeTreeId).forEach(r=>{
    if(currentRun&&r.id===currentRun.runId)return;
    const ts=r.savedAt?new Date(r.savedAt).getTime():0;if(ts>newC||ts<oldC)return;
    (r.steps||[]).forEach(s=>{if(s.nodeId===nodeId&&s.answer){const txt=answerText(s.answer);if(txt)out.push({text:txt,date:r.savedAt});}});
  });
  return out.slice(0,12);
}

// ── autosave (silent — reflections save but aren't browsable) ──
function saveRunNow(){if(currentRun&&_activeTreeId&&window._saveRun)window._saveRun(_activeTreeId,currentRun);}
function saveRunSoon(){clearTimeout(_runSaveTimer);_runSaveTimer=setTimeout(saveRunNow,700);}

// ── advance (blink, no camera) ──
function advance(answer,next){
  currentRun.steps.push({nodeId:tnode,answer,next:next||'done'});
  const done=(!next||next==='done'||!parsedTree[next]);
  if(done){
    currentRun.complete=true;saveRunNow();
    blinkTo(()=>{tnode=null;showEndScreen();});
    return;
  }
  saveRunSoon();
  blinkTo(()=>{tnode=next;renderCard();});
}
function blinkTo(midFn){
  const card=document.getElementById('rcard');
  if(!card){midFn();return;}
  card.classList.add('blinking');
  setTimeout(midFn,220);
  setTimeout(()=>card.classList.remove('blinking'),460);
}
function chooseSingle(i){const node=parsedTree[tnode];if(!node)return;const o=node.opts[i];if(!o)return;advance({type:'single',label:o.l},o.n);}
function submitCard(){
  const node=parsedTree[tnode];if(!node||node.type!=='text')return;
  const ip=document.getElementById('rInput');const text=(ip?ip.value:'').trim();
  if(ip){ip.value='';ip.blur();}
  advance({type:'text',text},node.def);
}
function onCardKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitCard();}}
function runBack(){
  if(!currentRun||!currentRun.steps.length)return;
  const s=currentRun.steps.pop();currentRun.complete=false;saveRunSoon();
  blinkTo(()=>{tnode=s.nodeId;renderCard();});
}
// textbox grows to a sensible number of lines per screen size, then scrolls
function autoGrowInput(el){
  if(!el)return;el.style.height='auto';
  const lines=(window.innerWidth<=680?8:15);
  el.style.height=Math.min(el.scrollHeight,lines*26)+'px';
}

// ── commitment node (end of every path) ──
function showEndScreen(){
  document.getElementById('rcardMain').style.display='none';
  const end=document.getElementById('rcardEnd');end.style.display='';
  _commitDateVal='';
  const ct=document.getElementById('commitText');if(ct)ct.value='';
  const dl=document.getElementById('commitDateLabel');if(dl)dl.textContent='add a date';
  const cd=document.getElementById('commitDate');if(cd)cd.value='';
  const en=document.getElementById('endNotes');if(en)en.style.display='none';
  const nt=document.getElementById('endNotesText');if(nt)nt.value=window._notes||'';
  _commitSourceNode=null;
  const pop=document.getElementById('commitNodePop');if(pop)pop.style.display='none';
  const nb=document.getElementById('commitNodeBtn');if(nb)nb.classList.remove('on');
  refreshEndCommit();
  setTimeout(()=>{const c=document.getElementById('commitText');if(c)c.focus();},80);
}

// ── "which question led you here?" — credit a node, which turns its response gold ──
function commitRunNodes(){
  if(!currentRun)return[];
  const seen=new Set(),out=[];
  currentRun.steps.forEach(s=>{if(s.nodeId&&!seen.has(s.nodeId)){seen.add(s.nodeId);out.push(s.nodeId);}});
  return out;
}
function branchCountOf(id){
  const n=parsedTree[id];if(!n)return 0;
  if(n.type==='single')return n.opts.length;
  return(n.def&&n.def!=='done')?1:0;
}
function commitCountOf(id){return(window._commitments||[]).filter(c=>c.sourceNode===id).length;}
function toggleCommitNodePop(){
  const pop=document.getElementById('commitNodePop');if(!pop)return;
  if(pop.style.display!=='none'){pop.style.display='none';return;}
  renderCommitNodePop();pop.style.display='';
}
function renderCommitNodePop(){
  const pop=document.getElementById('commitNodePop');if(!pop)return;
  const ids=commitRunNodes();
  if(!ids.length){pop.innerHTML='<div class="cnp-empty">no path to credit yet</div>';return;}
  let html='<div class="cnp-h">which question led you here?</div>';
  ids.forEach((id,i)=>{
    const rc=branchCountOf(id),cc=commitCountOf(id),meta=[];
    if(rc)meta.push(rc+(rc===1?' reply':' replies'));            // hide when no replies
    if(cc)meta.push(cc+(cc===1?' commitment':' commitments'));   // hide when no commitments
    const sel=(_commitSourceNode===id)?' sel':'';
    html+='<button class="cnp-item'+sel+'" onclick="pickCommitNode('+i+')">'
        +'<span class="cnp-txt">'+esc(id)+'</span>'
        +(meta.length?'<span class="cnp-meta">'+esc(meta.join('  ·  '))+'</span>':'')
        +'</button>';
  });
  pop.innerHTML=html;
}
function pickCommitNode(i){
  const ids=commitRunNodes();const id=ids[i];if(id==null)return;
  _commitSourceNode=(_commitSourceNode===id)?null:id;
  renderCommitNodePop();
  const btn=document.getElementById('commitNodeBtn');if(btn)btn.classList.toggle('on',!!_commitSourceNode);
}
function refreshEndCommit(){
  const ct=document.getElementById('commitText');const b=document.getElementById('endCommitGo');
  if(b)b.disabled=!(ct&&ct.value.trim()&&_commitDateVal);
}
function endCommit(){
  const text=document.getElementById('commitText').value.trim();
  if(!text||!_commitDateVal)return;
  if(window._addCommitment)window._addCommitment(text,_commitDateVal,_commitSourceNode);
  exitReflection();
  // teach "reflections compound" right after someone lands their first real commitment —
  // not before they've used the app at all. _maybeShowCompoundCard no-ops after night one.
  // it chains into the "make it a habit" install popup on dismiss so the two never stack;
  // if it's already been seen, show the habit popup straight away.
  let compoundWillShow=false;
  try{compoundWillShow=localStorage.getItem('rc_compound_seen')!=='1';}catch(e){}
  if(window._maybeShowCompoundCard)window._maybeShowCompoundCard();
  if(!compoundWillShow&&window._maybeShowHabitPopup)window._maybeShowHabitPopup();
}
function endToggleNotes(){
  const en=document.getElementById('endNotes');if(!en)return;
  const showing=en.style.display!=='none';
  en.style.display=showing?'none':'';
  if(!showing){const nt=document.getElementById('endNotesText');if(nt){nt.value=window._notes||'';setTimeout(()=>nt.focus(),50);}}
}
function endNotesInput(){if(window._saveNotes)window._saveNotes(document.getElementById('endNotesText').value);}
function finishReflection(){
  // "finish without committing" and "return" don't trigger the habit popup — it's
  // reserved for after a real commitment (endCommit) or the manual FAB button.
  exitReflection();
}
