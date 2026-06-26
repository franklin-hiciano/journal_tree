// ── App core: framework binding, commitment check-in, notes ───────────────────────
let _activeTreeId=null;
let _activeSrc='';
let parsedTree={};
let nlines={};
let selNode=null;
let _activeCmtId=null;
let _commitDateVal='';

function isMobile(){return window.innerWidth<=680;}
function getUserTrees(){return window._userTrees||[];}
function getTreeRuns(treeId){return(window._treeRuns&&window._treeRuns[treeId])||[];}
function activeTree(){return getUserTrees().find(t=>t.id===_activeTreeId)||null;}

// ── single framework binding ──
window._onTreesUpdated=function(){
  const trees=getUserTrees();
  if(!trees.length){_activeTreeId=null;parsedTree={};return;}
  if(!_activeTreeId||!trees.find(t=>t.id===_activeTreeId))_activeTreeId=trees[0].id;
  setActiveTree(_activeTreeId);
};
function setActiveTree(id){
  if(!id)return;
  _activeTreeId=id;window._activeTreeId=id;
  window._subscribeTree&&window._subscribeTree(id);
}
window._onRunsUpdated=function(){};

// ── commitments: write-only (added at end of a reflection), surfaced only by the
//    day-after check-in. There is no browsing UI by design. ──
function activeCommitments(){return(window._commitments||[]).filter(c=>c.status==='active');}
window._onCommitmentsUpdated=function(){maybeCheckIn();};

function onDatePicked(){
  const v=document.getElementById('commitDate').value;_commitDateVal=v;
  const lbl=document.getElementById('commitDateLabel');
  if(lbl)lbl.textContent=v?('check in: '+new Date(v+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})):'add a date';
  if(typeof refreshEndCommit==='function')refreshEndCommit();
}
function autoGrowEl(el){if(!el)return;el.style.height='auto';el.style.height=Math.min(el.scrollHeight,260)+'px';}

// ── day-after check-in (the only thing that resurfaces a commitment) ──
function maybeCheckIn(){
  const ov=document.getElementById('checkinOv');if(!ov||ov.classList.contains('on'))return;
  const today=new Date().toISOString().slice(0,10);
  const due=(window._commitments||[]).find(c=>c.status==='active'&&c.date&&today>c.date&&!c.checkedIn);
  if(!due)return;
  _activeCmtId=due.id;
  document.getElementById('checkinText').textContent='did you '+due.text+'?';
  ov.classList.add('on');
}
function shatter(el){if(!el)return;el.classList.add('breaking');setTimeout(()=>{el.classList.remove('on','breaking');},900);}

// ── notes (reachable only from the commitment screen) ──
window._onNotesUpdated=function(){const n=document.getElementById('endNotesText');if(n&&document.activeElement!==n)n.value=window._notes||'';};

// ── hold-to-confirm (5s) — used by the check-in yes/no ──
function bindHolds(){
  document.querySelectorAll('.hold-btn').forEach(btn=>{
    if(btn._bound)return;btn._bound=true;
    let timer=null;
    const start=e=>{e.preventDefault();btn.classList.add('holding');timer=setTimeout(()=>{btn.classList.remove('holding');onHoldComplete(btn.dataset.action);},5000);};
    const cancel=()=>{btn.classList.remove('holding');clearTimeout(timer);};
    btn.addEventListener('pointerdown',start);
    btn.addEventListener('pointerup',cancel);
    btn.addEventListener('pointerleave',cancel);
    btn.addEventListener('pointercancel',cancel);
  });
}
function onHoldComplete(action){
  if(action==='yes'){
    const cmt=(window._commitments||[]).find(c=>c.id===_activeCmtId);
    window._resolveCommitment(_activeCmtId,'done');
    shatter(document.getElementById('checkinOv'));
    playMinted(cmt?cmt.text:'');
    _activeCmtId=null;
    // after minted fades, show completed commitments
    setTimeout(()=>openMilestones(), 1650);
  }
  else if(action==='no'){window._resolveCommitment(_activeCmtId,'missed');shatter(document.getElementById('checkinOv'));_activeCmtId=null;}
}

// ── minted animation ──
function playMinted(text){
  const ov=document.getElementById('mintedOv');
  const txt=document.getElementById('mintedText');
  if(!ov)return;
  if(txt)txt.textContent=text||'done.';
  ov.classList.add('on');
  setTimeout(()=>ov.classList.remove('on'),1500);
}

// ── milestones screen ──
function openMilestones() {
  renderMilestones();
  const ov = document.getElementById('milestonesOv');
  if (ov) ov.classList.add('on');
}
function closeMilestones() {
  const ov = document.getElementById('milestonesOv');
  if (ov) ov.classList.remove('on');
}

function renderMilestones(){
  const body=document.getElementById('milestonesBody');
  if(!body)return;
  const all=window._commitments||[];
  // sort by date descending (future dates first, then recent past, then no-date last)
  const sorted=[...all].sort((a,b)=>{
    const da=a.date||'';const db2=b.date||'';
    if(!da&&!db2)return 0;if(!da)return 1;if(!db2)return -1;
    return da<db2?1:-1;
  });
  const completed=sorted.filter(c=>c.status==='done');
  const active=sorted.filter(c=>c.status==='active');
  let html='';
  if(!completed.length&&!active.length){
    html='<div class="ms-empty">no commitments yet — finish a reflection and commit to one move.</div>';
  }else{
    if(active.length){
      html+='<div class="ms-section-label">current</div>';
      active.forEach(c=>{
        const dateStr=c.date?new Date(c.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'no date';
        html+=`<div class="ms-item active"><div class="ms-item-text">${esc(c.text)}</div><div class="ms-item-date">${dateStr}</div></div>`;
      });
    }
    if(completed.length){
      if(active.length)html+='<div class="ms-section-label" style="margin-top:8px">completed</div>';
      else html+='<div class="ms-section-label">completed</div>';
      completed.forEach(c=>{
        const dateStr=c.date?new Date(c.date+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
        html+=`<div class="ms-item"><div class="ms-item-text">${esc(c.text)}</div>${dateStr?'<div class="ms-item-date">'+dateStr+'</div>':''}`;
        html+='</div>';
      });
    }
  }
  body.innerHTML=html;
  // size each card to its text width
  body.querySelectorAll('.ms-item').forEach(el=>{
    el.style.width='fit-content';
  });
}

