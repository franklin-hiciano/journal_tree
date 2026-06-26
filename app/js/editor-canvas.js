// ── Parser, linter, canvas (run=vertical, edit=horizontal), editor ───────────────
const NS='http://www.w3.org/2000/svg';
const LH=21,PAD=14;
const NW=200,NH=66,CGAP=250,RGAP=120;
let layout={};      // run / vertical
let layoutE={};     // edit / horizontal
let eTx=0,eTy=0,eScale=1;
let _treeSig='';    // structural signature — guards canvas re-render while typing

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Grammar: Title · "option >> dest" · bare "option" (multi) · ">> dest" (continue)
//          "@[Node Title] [3,7d]" recall.  Leaf (no opts) = text node by default.
function parse(src){
  const nodes={},nl={};
  let cur=null,opts=[],def=null,refs=[],bad=[];
  const flush=()=>{
    if(cur===null)return;
    // Two node types only: 'text' (free response, with an optional single >> continue)
    // and 'single' (multiple choice — 2+ routed options). Structural validity is
    // checked in lint(); here we just classify by whether the node has options.
    const t=opts.length?'single':'text';
    nodes[cur]={title:cur,type:t,opts,def,refs,bad};
  };
  (src||'').split('\n').forEach((raw,i)=>{
    let tr=raw.trim();
    if(!tr||tr.startsWith('#'))return;
    // strip a trailing "  # comment" — lets people paste examples that annotate a line
    // inline instead of only on its own line, without the comment text corrupting a
    // destination/title (e.g. ">> done   # explanation" used to make "done" not exist).
    const cm=tr.search(/\s+#/);
    if(cm>-1)tr=tr.slice(0,cm).trim();
    if(!tr)return;
    const ind=/^\s/.test(raw);
    if(!ind){flush();cur=tr;opts=[];def=null;refs=[];bad=[];nl[cur]={s:i,e:i};}
    else{
      if(cur===null)return;
      nl[cur].e=i;
      if(tr.startsWith('@[')){
        const m=tr.match(/^@\[([^\]]+)\]\s*\[\s*(\d+)\s*,\s*(\d+)\s*d\s*\]/);
        if(m)refs.push({nodeId:m[1].trim(),a:+m[2],b:+m[3],line:i});else bad.push({line:i,msg:'malformed recall — use @[Node Title] [3,7d]'});
      }else if(tr.startsWith('@')){bad.push({line:i,msg:'unknown directive — @ is reserved for @[Node Title] [a,bd] recall'});}
      else if(tr.startsWith('>>')){let d=tr.slice(2).trim();if(d==='commit')d='done';def=d;}
      else if(tr.includes('>>')){const idx=tr.indexOf('>>');let n=tr.slice(idx+2).trim();if(n==='commit')n='done';opts.push({l:tr.slice(0,idx).trim(),n});}
      else{opts.push({l:tr,n:null});}
    }
  });
  flush();
  return{nodes,nl};
}
function lint(src,nodes,nl){
  const errors=[];const ids=new Set(Object.keys(nodes));ids.add('done');  // 'done' = built-in commitment terminal
  Object.entries(nodes).forEach(([id,node])=>{
    const ln=nl[id]?.s;
    if(id==='done')return; // reserved
    // ── structural: only two valid node types ──
    if(node.type==='single'){
      // multiple-choice node: needs 2+ options, each routed, and no bare >> continue
      if(node.def)errors.push({sev:'err',msg:`"${id}": a multiple-choice node can't also have a "»" continue — give every option its own destination`,line:ln});
      const unrouted=node.opts.filter(o=>!o.n);
      unrouted.forEach(o=>errors.push({sev:'err',msg:`"${id}": option "${o.l}" has no destination — write it as "${o.l} >> dest"`,line:ln}));
      if(node.opts.length<2)errors.push({sev:'err',msg:`"${id}": a multiple-choice node needs at least two options (a single option isn't a choice)`,line:ln});
    }
    // ── destinations must exist (or be the commitment terminal) ──
    node.opts.forEach(o=>{if(o.n&&!ids.has(o.n))errors.push({sev:'err',msg:`"${id}": destination "${o.n}" doesn't exist`,line:ln});});
    if(node.def&&!ids.has(node.def))errors.push({sev:'err',msg:`"${id}": continue → "${node.def}" doesn't exist`,line:ln});
    node.refs.forEach(r=>{if(!ids.has(r.nodeId))errors.push({sev:'warn',msg:`"${id}": recall references unknown node "${r.nodeId}"`,line:r.line});});
    (node.bad||[]).forEach(b=>errors.push({sev:'err',msg:`"${id}": ${b.msg}`,line:b.line}));
  });
  // ── every path must lead to the commitment node (>> done) ──
  const keys=Object.keys(nodes).filter(k=>k!=='done');
  if(keys.length){
    const succ={};keys.forEach(id=>{const n=nodes[id];const d=[];n.opts.forEach(o=>{if(o.n)d.push(o.n);});if(n.def)d.push(n.def);succ[id]=d;});
    const reaches=new Set(['done']);let changed=true;
    while(changed){changed=false;for(const id of keys){if(reaches.has(id))continue;if((succ[id]||[]).some(d=>reaches.has(d))){reaches.add(id);changed=true;}}}
    keys.forEach(id=>{if(!reaches.has(id))errors.push({sev:'err',msg:`"${id}": no path from here reaches the commitment — end a path with ">> commit"`,line:nl[id]?.s});});
  }
  return errors;
}
// ── canvas zoom (editor) ──
function editZoom(f){
  const svg=document.getElementById('editCanvas');if(!svg)return;
  const r=svg.getBoundingClientRect();const cx=r.width/2,cy=r.height/2;
  const ns=Math.max(0.2,Math.min(2.6,eScale*f));
  eTx=cx-(cx-eTx)*(ns/eScale);eTy=cy-(cy-eTy)*(ns/eScale);
  eScale=ns;_editPanned=true;applyEditTransform();
}
function renderLinter(errors){
  const panel=document.getElementById('linterPanel');if(!panel)return;
  if(!errors.length){panel.style.display='none';panel.innerHTML='';return;}
  panel.style.display='block';
  panel.innerHTML=errors.map(e=>`<div class="linter-row"><div class="linter-sev ${e.sev}">${e.sev}</div><div class="linter-msg">${esc(e.msg)}</div>${e.line!=null?`<div class="linter-line">L${e.line+1}</div>`:''}</div>`).join('');
}
function hilite(src){
  return (src||'').split('\n').map(line=>{
    const tr=line.trim();if(!tr)return'';
    if(tr.startsWith('#'))return'<span class="h-cmt">'+esc(line)+'</span>';
    if(!/^\s/.test(line))return'<span class="h-title">'+esc(line)+'</span>';
    const ws=(line.match(/^(\s+)/)||[''])[0];
    if(tr.startsWith('@['))return esc(ws)+'<span class="h-ref">'+esc(tr)+'</span>';
    if(tr.startsWith('@'))return esc(ws)+'<span class="h-bad">'+esc(tr)+'</span>';
    if(tr.startsWith('>>')){const d=tr.slice(2).trim();return esc(ws)+'<span class="h-arrow">&gt;&gt;</span> <span class="h-dest">'+(d==='done'||d==='commit'?'commit':esc(d))+'</span>';}
    if(tr.includes('>>')){const i=tr.indexOf('>>');const d=tr.slice(i+2).trim();return esc(ws)+'<span class="h-opt">'+esc(tr.slice(0,i).trimEnd())+'</span> <span class="h-arrow">&gt;&gt;</span> <span class="h-dest">'+(d==='done'||d==='commit'?'commit':esc(d))+'</span>';}
    return esc(ws)+'<span class="h-opt">'+esc(tr)+'</span>';
  }).join('\n');
}

// ── Layout ──
function computeLayout(nodes,h){
  const keys=Object.keys(nodes);if(!keys.length)return{};
  const depth={[keys[0]]:0};const q=[keys[0]],vis=new Set();
  while(q.length){const id=q.shift();if(vis.has(id))continue;vis.add(id);const n=nodes[id];if(!n)continue;
    const push=x=>{if(x&&nodes[x]&&!(x in depth)){depth[x]=depth[id]+1;q.push(x);}};
    n.opts.forEach(o=>{if(o.n)push(o.n);});if(n.def)push(n.def);}
  let mx=Math.max(0,...Object.values(depth));keys.forEach(k=>{if(!(k in depth))depth[k]=++mx;});
  const rows={};keys.forEach(k=>{(rows[depth[k]]=rows[depth[k]]||[]).push(k);});
  const L={};
  Object.entries(rows).forEach(([d,ns])=>{
    const tot=ns.length-1;
    ns.forEach((id,i)=>{
      if(h)L[id]={x:+d*CGAP,y:(-tot/2+i)*RGAP,w:NW,h:NH};
      else L[id]={x:(-tot/2+i)*CGAP,y:+d*RGAP,w:NW,h:NH};
    });
  });
  return L;
}
function nodeCenter(id){const p=layout[id];return p?{x:p.x+NW/2,y:p.y+NH/2}:{x:0,y:0};}

// ── Canvas render (shared) ──
function renderCanvasEl(svg,vp,selId,opts){
  opts=opts||{};const L=opts.L||layout;
  if(!svg||!vp)return;
  vp.innerHTML='';
  if(!Object.keys(parsedTree).length)return;
  for(const[id,node]of Object.entries(parsedTree)){
    const s=L[id];if(!s)continue;
    const dests=[];
    if(node.type==='single')node.opts.forEach(o=>{if(o.n)dests.push(o.n);});else if(node.def)dests.push(node.def);
    dests.forEach(d=>{const t=L[d];if(!t)return;
      const x1=s.x+NW/2,y1=s.y+NH/2,x2=t.x+NW/2,y2=t.y+NH/2;
      const p=document.createElementNS(NS,'path');
      p.setAttribute('d','M'+x1+','+y1+' C'+((x1+x2)/2)+','+y1+' '+((x1+x2)/2)+','+y2+' '+x2+','+y2);
      p.setAttribute('fill','none');p.setAttribute('stroke',selId===id?'#3a3a1a':'#262626');p.setAttribute('stroke-width','1.5');
      vp.appendChild(p);
    });
  }
  for(const[id,pos]of Object.entries(L)){
    if(!parsedTree[id])continue;
    const node=parsedTree[id];const sel=id===selId;
    const g=document.createElementNS(NS,'g');g.setAttribute('transform','translate('+pos.x+','+pos.y+')');g.dataset.id=id;
    if(opts.clickable){g.style.cursor='pointer';g.addEventListener('click',ev=>{ev.stopPropagation();onCanvasNode(id);});}
    const r=document.createElementNS(NS,'rect');
    r.setAttribute('width',NW);r.setAttribute('height',NH);r.setAttribute('rx','11');
    r.setAttribute('fill',sel?'#15170a':'#131313');r.setAttribute('stroke',sel?'#ebff00':'#2e2e2e');r.setAttribute('stroke-width',sel?'2':'1');
    g.appendChild(r);
    const t=document.createElementNS(NS,'text');
    t.setAttribute('x',13);t.setAttribute('y',27);t.setAttribute('fill',sel?'#ebff00':'#e2e0d9');
    t.setAttribute('font-size','12');t.setAttribute('font-family','Syne,sans-serif');t.setAttribute('font-weight','700');
    t.textContent=id.length>26?id.slice(0,25)+'…':id;
    g.appendChild(t);
    const sub=document.createElementNS(NS,'text');
    sub.setAttribute('x',13);sub.setAttribute('y',47);sub.setAttribute('fill','#5a5a5a');
    sub.setAttribute('font-size','10');sub.setAttribute('font-family','DM Mono,monospace');
    sub.textContent=node.type==='single'?node.opts.length+' choices':node.type==='multi'?'multi-select':'free response';
    g.appendChild(sub);
    if(opts.plus){
      const ph=document.createElementNS(NS,'g');ph.setAttribute('class','plus-handle');ph.dataset.src=id;ph.style.cursor='pointer';
      const pc=document.createElementNS(NS,'circle');pc.setAttribute('cx',NW);pc.setAttribute('cy',NH/2);pc.setAttribute('r','11');pc.setAttribute('fill','#15170a');pc.setAttribute('stroke','#9aa800');
      const pp=document.createElementNS(NS,'text');pp.setAttribute('x',NW);pp.setAttribute('y',NH/2+4);pp.setAttribute('text-anchor','middle');pp.setAttribute('fill','#ebff00');pp.setAttribute('font-size','14');pp.setAttribute('font-family','DM Mono,monospace');pp.textContent='+';
      ph.appendChild(pc);ph.appendChild(pp);
      // click the + to add a child node — no dragging onto the canvas
      ph.addEventListener('pointerdown',ev=>{ev.preventDefault();ev.stopPropagation();});
      ph.addEventListener('click',ev=>{ev.stopPropagation();createChild(id);});
      g.appendChild(ph);
    }
    vp.appendChild(g);
  }
}
function boundsOf(L){const xs=Object.values(L).map(p=>p.x),ys=Object.values(L).map(p=>p.y);if(!xs.length)return null;return{minX:Math.min(...xs),maxX:Math.max(...xs)+NW,minY:Math.min(...ys),maxY:Math.max(...ys)+NH};}
function fitView(svg,vp){
  const L=layout;const b=boundsOf(L);if(!b||!svg||!vp)return;
  const r=svg.getBoundingClientRect();const W=r.width||360,H=r.height||400;
  const sw=b.maxX-b.minX||1,sh=b.maxY-b.minY||1;const s=Math.min(W/(sw+80),H/(sh+80),1.1);
  vp.style.transformOrigin='0 0';
  vp.style.transform='translate('+(W/2-(b.minX+sw/2)*s)+'px,'+(H/2-(b.minY+sh/2)*s)+'px) scale('+s+')';
}

// ── Edit canvas (horizontal, pannable, drag-create) ──
function renderEditCanvas(){
  const svg=document.getElementById('editCanvas'),vp=document.getElementById('editVp');
  const cem=document.getElementById('cem');const has=Object.keys(parsedTree).length>0;
  if(cem)cem.style.display=has?'none':'flex';
  layoutE=computeLayout(parsedTree,true);
  renderCanvasEl(svg,vp,selNode,{L:layoutE,clickable:true,plus:true});
  if(!_editPanned)fitEditView();else applyEditTransform();
}
let _editPanned=false;
function applyEditTransform(){const vp=document.getElementById('editVp');if(vp){vp.style.transformOrigin='0 0';vp.style.transform='translate('+eTx+'px,'+eTy+'px) scale('+eScale+')';}}
function fitEditView(){
  const svg=document.getElementById('editCanvas');const b=boundsOf(layoutE);if(!b||!svg)return;
  const r=svg.getBoundingClientRect();const W=r.width||360,H=r.height||400;
  const sw=b.maxX-b.minX||1,sh=b.maxY-b.minY||1;eScale=Math.min(W/(sw+80),H/(sh+80),1.1);
  eTx=W/2-(b.minX+sw/2)*eScale;eTy=H/2-(b.minY+sh/2)*eScale;applyEditTransform();
}
(function initEditPan(){
  const wrap=document.getElementById('editCanvasWrap');if(!wrap)return;
  let panning=false,px=0,py=0;
  wrap.addEventListener('pointerdown',e=>{
    if(_dragFrom)return;
    // never start a canvas pan from inside the empty-state card — that's where the
    // copyable example tree lives, and capturing the pointer here was silently
    // breaking native text selection (drag-to-select looked like drag-to-pan).
    if(e.target.closest('[data-id]')||e.target.closest('.plus-handle')||e.target.closest('#cem'))return;
    panning=true;px=e.clientX-eTx;py=e.clientY-eTy;_editPanned=true;wrap.setPointerCapture?.(e.pointerId);
  });
  wrap.addEventListener('pointermove',e=>{if(!panning)return;eTx=e.clientX-px;eTy=e.clientY-py;applyEditTransform();});
  const end=()=>{panning=false;};
  wrap.addEventListener('pointerup',end);wrap.addEventListener('pointerleave',end);wrap.addEventListener('pointercancel',end);
})();

// drag from + to create / link
let _dragFrom=null,_ghost=null;
function startDragCreate(srcId,e){
  e.preventDefault();e.stopPropagation();
  _dragFrom=srcId;
  const vp=document.getElementById('editVp');
  _ghost=document.createElementNS(NS,'path');_ghost.setAttribute('stroke','#ebff00');_ghost.setAttribute('stroke-width','2');_ghost.setAttribute('fill','none');_ghost.setAttribute('stroke-dasharray','4 4');
  vp.appendChild(_ghost);
  document.getElementById('dragHint').classList.add('on');
  document.addEventListener('pointermove',dragMove);
  document.addEventListener('pointerup',dragUp,{once:true});
}
function svgLocal(clientX,clientY){
  const svg=document.getElementById('editCanvas');const r=svg.getBoundingClientRect();
  return{x:(clientX-r.left-eTx)/eScale,y:(clientY-r.top-eTy)/eScale};
}
function dragMove(e){
  if(!_dragFrom||!_ghost)return;
  const s=layoutE[_dragFrom];if(!s)return;
  const p=svgLocal(e.clientX,e.clientY);
  const x1=s.x+NW,y1=s.y+NH/2;
  _ghost.setAttribute('d','M'+x1+','+y1+' L'+p.x+','+p.y);
}
function nodeAt(local){
  for(const[id,p]of Object.entries(layoutE)){if(local.x>=p.x&&local.x<=p.x+NW&&local.y>=p.y&&local.y<=p.y+NH)return id;}
  return null;
}
function dragUp(e){
  document.removeEventListener('pointermove',dragMove);
  document.getElementById('dragHint').classList.remove('on');
  const src=_dragFrom;_dragFrom=null;
  if(_ghost){_ghost.remove();_ghost=null;}
  if(!src)return;
  const local=svgLocal(e.clientX,e.clientY);
  const hit=nodeAt(local);
  if(hit&&hit!==src)linkNodes(src,hit);
  else if(!hit)createChild(src);
}
function addLineToNode(srcId,line){
  const lines=(ta()?ta().value:_activeSrc).split('\n');
  const e=nlines[srcId]?nlines[srcId].e:lines.length-1;
  lines.splice(e+1,0,line);
  return lines.join('\n');
}
function hasDef(srcId){return !!(parsedTree[srcId]&&parsedTree[srcId].def);}
function linkNodes(src,dest){
  const line=hasDef(src)?('  option >> '+dest):('  >> '+dest);
  const t=ta();if(t){t.value=addLineToNode(src,line);window._onSrcChange(true);}
}
function createChild(src){
  const t=ta();if(!t)return;
  let name='new prompt',n=1;while(parsedTree[name]||name==='done'){name='new prompt '+(++n);}
  const node=parsedTree[src];
  let lines=t.value.split('\n');
  if(node&&node.opts.length){
    // choice node: add another option that routes to the new node (which ends at done)
    const e=nlines[src]?nlines[src].e:lines.length-1;
    lines.splice(e+1,0,'  option >> '+name);
    lines.push('',name,'  >> done');
  }else{
    // text node: insert the new node *before* wherever this one currently continues,
    // keeping the path to the commitment intact (src → new → old-target)
    const oldNext=(node&&node.def)?node.def:'done';
    const r=nlines[src];let replaced=false;
    if(node&&node.def&&r){for(let i=r.s;i<=r.e;i++){if(/^\s*>>/.test(lines[i])){lines[i]=lines[i].replace(/>>.*/,'>> '+name);replaced=true;break;}}}
    if(!replaced){const e=r?r.e:lines.length-1;lines.splice(e+1,0,'  >> '+name);}
    lines.push('',name,'  >> '+oldNext);
  }
  t.value=lines.join('\n');selNode=name;window._onSrcChange(true);scrollToNode(name);
}
function addFirstNode(){
  const t=ta();if(!t)return;
  if(Object.keys(parsedTree).length)return;
  t.value='new prompt';selNode='new prompt';window._onSrcChange(true);scrollToNode('new prompt');
}
function onCanvasNode(id){selNode=id;scrollToNode(id);updateEditor();renderEditCanvas();const t=ta();if(t&&!isMobile())t.focus();}

// ── Text editor ──
function ta(){return document.getElementById('src-ta');}
function hll(){return document.getElementById('hll');}
function lnumsEl(){return document.getElementById('lnums');}
function lhl(){return document.getElementById('lhl');}
function updateEditor(){
  const t=ta();if(!t)return;const src=t.value;
  const h=hll();if(h)h.innerHTML=hilite(src)+'\n';
  const ln=lnumsEl();
  if(ln){
    const n=src.split('\n').length;const errLines=window._errLines||new Set();const show=!!window._lintShown;
    let out='';for(let i=0;i<n;i++){out+=(show&&errLines.has(i)?('<span class="lnum-err">'+(i+1)+'</span>'):String(i+1))+(i<n-1?'\n':'');}
    ln.innerHTML=out;
  }
  syncScroll();
}
function syncScroll(){const t=ta(),h=hll(),ln=lnumsEl();if(!t)return;if(h){h.scrollTop=t.scrollTop;h.scrollLeft=t.scrollLeft;}if(ln)ln.scrollTop=t.scrollTop;if(selNode&&nlines[selNode])showLHL(nlines[selNode]);}
function bindEditorEvents(){
  const t=ta();if(!t||t._bound)return;t._bound=true;
  t.addEventListener('scroll',syncScroll);
  t.addEventListener('input',()=>window._onSrcChange(true));
  t.addEventListener('click',onCursor);t.addEventListener('keyup',onCursor);
  t.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const s=t.selectionStart,en=t.selectionEnd;t.value=t.value.slice(0,s)+'  '+t.value.slice(en);t.selectionStart=t.selectionEnd=s+2;window._onSrcChange(true);}});
}
function onCursor(){const t=ta();if(!t)return;const li=t.value.slice(0,t.selectionStart).split('\n').length-1;for(const[id,r]of Object.entries(nlines)){if(li>=r.s&&li<=r.e){if(id!==selNode){selNode=id;showLHL(r);renderEditCanvas();}return;}}}
function showLHL(r){const l=lhl();if(!l)return;if(!r){l.style.display='none';return;}const t=ta();if(!t)return;l.style.display='block';l.style.top=(PAD+r.s*LH-t.scrollTop)+'px';l.style.height=((r.e-r.s+1)*LH)+'px';}
function scrollToNode(id){const r=nlines[id];const t=ta();if(!r||!t)return;t.scrollTop=Math.max(0,PAD+r.s*LH-80);showLHL(r);}

// ── Version history panel ──
function openHistory(){
  const panel=document.getElementById('historyPanel');if(!panel)return;
  renderHistory();panel.style.display='';
}
function closeHistory(){
  const panel=document.getElementById('historyPanel');if(panel)panel.style.display='none';
}
function renderHistory(){
  const list=document.getElementById('historyList');if(!list)return;
  const hist=(window._getHistory&&_activeTreeId)?window._getHistory(_activeTreeId):[];
  if(!hist.length){list.innerHTML='<div class="hist-empty">no history yet — edits auto-save here.</div>';return;}
  list.innerHTML=hist.map((h,i)=>{
    const d=new Date(h.ts);
    const lbl=d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
    const preview=h.src.split('\n').find(l=>l.trim())||'(empty)';
    return `<div class="hist-item" onclick="restoreHistory(${i})"><div class="hist-ts">${lbl}</div><div class="hist-prev">${esc(preview.slice(0,50))}</div></div>`;
  }).join('');
}
function restoreHistory(idx){
  const hist=(window._getHistory&&_activeTreeId)?window._getHistory(_activeTreeId):[];
  if(!hist[idx])return;
  const t=ta();if(!t)return;
  if(!confirm('Restore this version? Your current text will be replaced.'))return;
  t.value=hist[idx].src;window._onSrcChange&&window._onSrcChange(true);
  closeHistory();
}

window._onSrcChange=function(write=true){
  const t=ta();const src=t?t.value:'';
  _activeSrc=src;window._currentSrc=src;
  if(write&&window._writeSrc&&_activeTreeId)window._writeSrc(_activeTreeId,src);
  if(t&&t._bound)updateEditor();
  const{nodes,nl}=parse(src);nlines=nl;
  const errs=lint(src,nodes,nl);const keys=Object.keys(nodes);
  const pst=document.getElementById('pst');
  if(pst){const ec=errs.filter(e=>e.sev==='err').length;
    if(!keys.length){pst.textContent='—';pst.className='pstatus';}
    else if(ec){pst.textContent=ec+' error'+(ec>1?'s':'');pst.className='pstatus err';}
    else{pst.textContent=keys.length+' nodes ✓';pst.className='pstatus ok';}}
  parsedTree=nodes;
  layout=computeLayout(nodes,false);
  // The linter stays hidden while you design — it only appears once you press reflect
  // (window._lintShown). After that it updates live until the errors are cleared.
  if(window._lintShown){
    window._errLines=new Set(errs.filter(e=>e.line!=null&&e.sev==='err').map(e=>e.line));
    renderLinter(errs);
    if(!errs.some(e=>e.sev==='err')){window._lintShown=false;window._errLines=new Set();renderLinter([]);}
  }else{
    window._errLines=new Set();
    renderLinter([]);
  }
  // Only redraw the canvases when the tree's *structure* changes (nodes, types, edges,
  // option counts) — not on every keystroke. Re-rendering the SVG each character is what
  // made the selected node's outline blink while typing. Editing label/title text within
  // an existing structure leaves the canvas untouched.
  const sig=Object.keys(nodes).map(id=>{const n=nodes[id];return id+'|'+n.type+'|'+(n.def||'')+'|'+n.opts.map(o=>o.n||'·').join(',');}).join(';');
  if(sig!==_treeSig){
    _treeSig=sig;
    renderEditCanvas();
    if(typeof refreshRunCanvas==='function')refreshRunCanvas();
  }
  if(typeof onTreeParsed==='function')onTreeParsed();
};
