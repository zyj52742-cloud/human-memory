/* 记忆宇宙：本地快照、确定关系、独立的三维网络视图。 */
(function () {
 'use strict';

 // 当前页面拥有的异步任务和监听器，与 WebGL 一起释放。
 let disposed=false,raf=0,lastDraw=0;const stops=[];
 const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);stops.push(()=>target.removeEventListener(type,fn,options));};
 const every=(fn,ms)=>{const id=setInterval(()=>{if(!disposed)fn();},ms);stops.push(()=>clearInterval(id));return id;};
 const later=(fn,ms)=>{const id=setTimeout(()=>{if(!disposed)fn();},ms);stops.push(()=>clearTimeout(id));return id;};
 const safeDPR=()=>Math.min(Math.max(.5,Math.min(devicePixelRatio||1,1.5)),2048/Math.max(1,innerWidth,innerHeight));

 const $ = id => document.getElementById(id);
 const data = window.__MEMORY_NETWORK__;
 if (!window.THREE || !data || !Array.isArray(data.nodes)) {
   const box = document.createElement('div'); box.className = 'fatal';
   box.textContent = '资源未完整加载。请保留页面旁的整个 _lib 文件夹，并双击“02-打开记忆宇宙.cmd”。';
   document.body.appendChild(box); return;
 }
 const T = window.THREE;
 const palette = ['#71d5e8','#b7a0f2','#e3b776','#7bd1b2','#db8dab','#91acf1','#d1cd88','#71bbc2'];
 const names = { conversation:'对话', memory:'记忆', entity:'实体', project:'项目', kind:'记忆类型' };
 const kinds = {preference:'偏好',identity:'身份',relationship:'关系',fact:'事实',goal:'目标',event:'事件',emotion:'情绪',mood:'近期状态',grudge:'心结',state:'状态',knot:'心结',routine:'日常',resolve:'化解'};
 const edgeNames = {content:'内容相关（推测）',project:'项目归属',parent:'父子对话',source:'记忆出处',entity:'提及实体',kind:'记忆分类'};
 const colors = {conversation:'#71d5e8',memory:'#d5ae76',entity:'#b8a2ed',project:'#d8ba7e',kind:'#88caae'};
 const nodes = data.nodes.map((n,i)=>Object.assign({},n,{index:i,visible:true}));
 const map = new Map(nodes.map(n=>[n.id,n]));
 const edges = data.edges.filter(e=>map.has(e.source)&&map.has(e.target));
 const meta = data.metadata || {};
 const now = Date.now();
 function numericDate(v){if(typeof v==='number')return v<1e12?v*1000:v;const n=Date.parse(v);return Number.isFinite(n)?n:now;}
 function fmt(v){return new Date(numericDate(v)).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
 function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
 function rand(s,k){return (hash(s+'|'+k)%1000000)/1000000;}
 const dates = nodes.filter(n=>n.type==='conversation'||n.type==='memory').map(n=>numericDate(n.created));
 const minDate = dates.length?Math.min(...dates):now, maxDate=dates.length?Math.max(...dates):now;
 const state={type:'all',group:null,query:'',cutoff:maxDate,selected:null,spin:nodes.length<80&&!matchMedia('(prefers-reduced-motion: reduce)').matches,labels:false,yaw:0,pitch:.09,distance:1000,target:new T.Vector3(),wantedTarget:new T.Vector3(),wantedDistance:1000};
 const allowedEdges = new Set(Object.keys(edgeNames));
 state.profile='';state.memoryStatus='';
 state.selectedEdge=null;
 const layoutParam=new URLSearchParams(location.search).get('layout');
 const contentMode=layoutParam==='content'||(layoutParam!=='timeline'&&edges.some(e=>e.type==='content'));
 if(contentMode){allowedEdges.delete('project');allowedEdges.delete('parent');}
 const ignoredKey='memory-universe:ignored-content:v1';let ignoredLinks=new Set();
 try{const saved=JSON.parse(localStorage.getItem(ignoredKey)||'[]');if(Array.isArray(saved))ignoredLinks=new Set(saved.filter(x=>typeof x==='string'));}catch{}
 function saveIgnored(){try{localStorage.setItem(ignoredKey,JSON.stringify([...ignoredLinks]));}catch{}if($('restoreLinks'))$('restoreLinks').hidden=!ignoredLinks.size;}
 saveIgnored();
 // Content groups use finished offline analysis; date layout remains available.
 const planner=window.AtlasGroups;
 if(!planner)throw Error('分组规划脚本未加载');
 const plan=planner.plan(nodes,{halfMax:24,weekMax:34,kinds,entityLabel:'实体与人物',content:contentMode});
 const groups=new Map(plan.groups.map(g=>[g.id,g]));
 nodes.forEach(n=>{n.cluster=plan.groupOf.get(n.id)||null;});
 const orderedGroups=plan.groups;
 const layout=planner.layout(orderedGroups);
 layout.positions.forEach((p,id)=>{const n=map.get(id);if(n)n.pos=new T.Vector3(p.x,p.y,p.z);});
 orderedGroups.forEach((g,i)=>{
   g.center=new T.Vector3(g.center.x,g.center.y,g.center.z);
   g.color=palette[i%palette.length];
   g.nodes.forEach(n=>{n.color=g.color;});
   const el=document.createElement('div');el.className='group-label';
   const title=document.createElement('div');title.className='group-name';title.style.color=g.color;title.textContent=g.kind==='conversation'&&!contentMode?planner.formatRange(g.start,g.end,new Date(g.start).getFullYear()!==new Date().getFullYear()).replace(/月/g,'/').replace(/日/g,''):g.label;
   el.title=g.label;
   const sub=document.createElement('small');
   sub.textContent=g.kind==='memory'?g.nodes.length+' 条记忆':g.kind==='entity'?g.nodes.length+' 个实体':contentMode?g.nodes.length+' 段对话':g.project+' · '+g.nodes.length;
   el.append(title,sub);$('labels').appendChild(el);g.el=el;
 });
 // 项目/类型枢纽放在所属分区的重心附近，减少横穿整张图的长连线。
 const hubs=nodes.filter(n=>n.type==='project'||n.type==='kind');
 hubs.forEach(n=>{
   const related=n.type==='project'
     ?orderedGroups.filter(g=>g.kind==='conversation'&&g.nodes.some(c=>c.project===(n.project||n.title||n.label)))
     :orderedGroups.filter(g=>g.kind==='memory'&&g.memoryKind===n.kind);
   if(related.length){
     let x=0,y=0;related.forEach(g=>{x+=g.center.x;y+=g.center.y;});
     n.pos=new T.Vector3(x/related.length,y/related.length,-150);
   } else n.pos=new T.Vector3(0,0,-150);
   n.color=colors[n.type];
 });
 nodes.forEach(n=>{if(!n.pos)n.pos=new T.Vector3();if(!n.color)n.color=colors[n.type]||palette[0];n.size=n.type==='project'?6:n.type==='kind'?4:n.type==='entity'?3.8:n.type==='memory'?2.7+Math.min(1,Number(n.importance)||0)*4:2.0+Math.min(1,Math.log2((Number(n.turns)||1)+1)/9)*3.0;if(n.sub)n.size*=.68;});
 // 子代理只在父节点存在时靠近它；来源关系保持原始方向。
 if(!contentMode)for(let pass=0;pass<3;pass++)nodes.forEach(n=>{if(n.type!=='conversation'||!n.sub)return;const p=map.get('conv:'+n.parent);if(p&&p!==n){const a=rand(n.id,3)*Math.PI*2;n.pos=p.pos.clone().add(new T.Vector3(Math.cos(a)*15,Math.sin(a)*15,(rand(n.id,4)-.5)*18));}});
 const adjacency=new Map(nodes.map(n=>[n.id,[]]));
 edges.forEach(e=>{adjacency.get(e.source).push({edge:e,node:map.get(e.target)});adjacency.get(e.target).push({edge:e,node:map.get(e.source)});});
 // 首屏镜头对准内容重心，而不是固定的原点。
 const homeCenter=new T.Vector3();
 {
   let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
   nodes.forEach(n=>{if(!n.pos)return;minX=Math.min(minX,n.pos.x);maxX=Math.max(maxX,n.pos.x);minY=Math.min(minY,n.pos.y);maxY=Math.max(maxY,n.pos.y);});
   if(Number.isFinite(minX))homeCenter.set((minX+maxX)/2,(minY+maxY)/2,0);
   state.target.copy(homeCenter);state.wantedTarget.copy(homeCenter);
 }
 let renderer,scene,camera,mesh,pointCloud,lineMesh,highlightLine,focusRing;
 const canvas=$('universe');
 try {renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,preserveDrawingBuffer:false,powerPreference:'default'});}
 catch(e){const b=document.createElement('div');b.className='fatal';b.textContent='当前浏览器未能启用三维显示。请用 Edge 或 Chrome 打开此页面。';document.body.appendChild(b);return;}
 renderer.setClearColor('#080e18',1);renderer.setPixelRatio(safeDPR());
 scene=new T.Scene();camera=new T.PerspectiveCamera(44,innerWidth/innerHeight,1,6000);
 scene.add(new T.AmbientLight('#a6c4e8',1.1));const light=new T.DirectionalLight('#ffffff',1.8);light.position.set(-300,500,700);scene.add(light);
 const geometry=new T.SphereGeometry(1,18,12);
 const material=new T.MeshStandardMaterial({color:0xffffff,roughness:.36,metalness:.15,emissive:0x30445b,emissiveIntensity:.3});
 mesh=new T.InstancedMesh(geometry,material,nodes.length);mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);mesh.frustumCulled=false;scene.add(mesh);
 const dummy=new T.Object3D(), cc=new T.Color();
 const pointPositions=new Float32Array(nodes.length*3),pointColors=new Float32Array(nodes.length*3),pointSizes=new Float32Array(nodes.length);
 nodes.forEach((n,i)=>{n.pos.toArray(pointPositions,i*3);new T.Color(n.color).toArray(pointColors,i*3);});
 const pg=new T.BufferGeometry();pg.setAttribute('position',new T.BufferAttribute(pointPositions,3));pg.setAttribute('color',new T.BufferAttribute(pointColors,3));pg.setAttribute('size',new T.BufferAttribute(pointSizes,1));
 const glowMaterial=new T.ShaderMaterial({uniforms:{scale:{value:innerHeight}},vertexShader:'attribute float size; varying vec3 vColor; uniform float scale; void main(){vColor=color; vec4 p=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*p;gl_PointSize=clamp(size*scale/max(1.0,-p.z),0.0,95.0);}',fragmentShader:'varying vec3 vColor;void main(){float r=length(gl_PointCoord-vec2(0.5))*2.0;if(r>1.0)discard;float a=pow(1.0-r,3.0)*0.32;gl_FragColor=vec4(vColor,a);}',transparent:true,vertexColors:true,depthWrite:false,blending:T.AdditiveBlending});
 pointCloud=new T.Points(pg,glowMaterial);pointCloud.frustumCulled=false;scene.add(pointCloud);
 const lineGeometry=new T.BufferGeometry();const linePositions=new Float32Array(edges.length*6),lineColors=new Float32Array(edges.length*6);
 lineGeometry.setAttribute('position',new T.BufferAttribute(linePositions,3));lineGeometry.setAttribute('color',new T.BufferAttribute(lineColors,3));
 lineMesh=new T.LineSegments(lineGeometry,new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.7,depthWrite:false,blending:T.AdditiveBlending}));lineMesh.frustumCulled=false;scene.add(lineMesh);
 highlightLine=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:'#cdb789',transparent:true,opacity:.68,depthWrite:false,blending:T.AdditiveBlending}));scene.add(highlightLine);
 focusRing=new T.Mesh(new T.RingGeometry(8,8.5,64),new T.MeshBasicMaterial({color:'#e6c38d',transparent:true,opacity:.8,side:T.DoubleSide,depthTest:false}));focusRing.visible=false;scene.add(focusRing);
 // 背景恒星与主节点分开，不参与命中，不作为记忆计数。
 const bgPos=new Float32Array(2600*3),bgColor=new Float32Array(2600*3);
 for(let i=0;i<2600;i++){const a=rand('bg'+i,1)*Math.PI*2,z=rand('bg'+i,2)*2-1,r=1400+rand('bg'+i,3)*1200;bgPos[i*3]=Math.sqrt(1-z*z)*Math.cos(a)*r;bgPos[i*3+1]=Math.sqrt(1-z*z)*Math.sin(a)*r;bgPos[i*3+2]=z*r;const f=.12+rand('bg'+i,4)*.22;bgColor.set([f*.8,f*.9,f],i*3);}
 const bg=new T.BufferGeometry();bg.setAttribute('position',new T.BufferAttribute(bgPos,3));bg.setAttribute('color',new T.BufferAttribute(bgColor,3));scene.add(new T.Points(bg,new T.PointsMaterial({size:1.4,vertexColors:true,transparent:true,opacity:.7,sizeAttenuation:true,depthWrite:false})));
 let viewW=innerWidth,viewH=innerHeight;
 function viewArea(){
   const left=document.querySelector('.sidebar').offsetWidth;
   const stage=document.querySelector('#stage');
   const top=stage.offsetTop+100;
   const bottom=document.querySelector('.bottom').offsetHeight+105;
   return {left,top,width:Math.max(180,innerWidth-left-40),height:Math.max(180,innerHeight-top-bottom)};
 }
 function overviewDistance(){
   let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
   nodes.forEach(n=>{if(!n.pos)return;minX=Math.min(minX,n.pos.x);maxX=Math.max(maxX,n.pos.x);minY=Math.min(minY,n.pos.y);maxY=Math.max(maxY,n.pos.y);});
   const halfW=Math.max(160,(maxX-minX)/2+30),halfH=Math.max(160,(maxY-minY)/2+65);
   const area=viewArea();
   const vHalf=22*Math.PI/180;
   const hHalf=Math.atan(Math.tan(vHalf)*innerWidth/Math.max(1,innerHeight));
   const byWidth=halfW/Math.max(.05,Math.tan(hHalf)*area.width/innerWidth);
   const byHeight=halfH/Math.max(.05,Math.tan(vHalf)*area.height/innerHeight);
   return Math.max(720,Math.min(5200,Math.max(byWidth,byHeight)*1.08));
 }
 function resize(){viewW=innerWidth;viewH=innerHeight;renderer.setPixelRatio(safeDPR());renderer.setSize(viewW,viewH,false);const area=viewArea();camera.aspect=viewW/viewH;camera.setViewOffset(viewW,viewH,-area.left/2,viewH/2-(area.top+area.height/2),viewW,viewH);camera.updateProjectionMatrix();glowMaterial.uniforms.scale.value=viewH;state.wantedDistance=state.selected?Math.max(540,overviewDistance()*.55):overviewDistance();}
 function watchDPR(){const q=matchMedia('(resolution: '+(devicePixelRatio||1)+'dppx)');listen(q,'change',()=>{resize();watchDPR();},{once:true});}
 listen(window,'resize',resize);resize();watchDPR();
 every(()=>{if(safeDPR()!==renderer.getPixelRatio())resize();},1000);
 const counts={};nodes.forEach(n=>{counts[n.type]=(counts[n.type]||0)+1;});
 function button(text,handler,cls){const b=document.createElement('button');b.textContent=text;b.className=cls||'';b.onclick=handler;return b;}
 function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=later(()=>$('toast').hidden=true,3500);}
 function buildFilters(){
   const tf=$('typeFilters');tf.replaceChildren();
   [['all','全部记录',nodes.length,'#aebcd1'],['conversation','对话',counts.conversation||0,colors.conversation],['memory','已保存记忆',counts.memory||0,colors.memory],['entity','实体与人物',counts.entity||0,colors.entity]].forEach(([id,label,count,color])=>{
     const b=button('',()=>{state.type=id;state.group=null;clearSelection();applyFilters();},'type-row'+(state.type===id?' active':''));b.dataset.type=id;const dot=document.createElement('i');dot.className='dot';dot.style.color=color;dot.style.background=color;const t=document.createElement('span');t.textContent=label;const c=document.createElement('b');c.textContent=count;b.append(dot,t,c);tf.appendChild(b);
   });
   const gs=$('groups');gs.replaceChildren();
   orderedGroups.forEach(g=>{const b=button('',()=>{state.group=state.group===g.id?null:g.id;state.type='all';clearSelection();if(state.group){state.wantedTarget.copy(g.center);state.wantedDistance=650;}else home(false);applyFilters();},'group-btn'+(state.group===g.id?' active':''));const dot=document.createElement('i');dot.className='dot';dot.style.background=g.color;dot.style.color=g.color;const label=document.createElement('span');label.textContent=g.label;const c=document.createElement('span');c.className='num';c.textContent=g.nodes.length;if(g.rangeText)b.title=g.rangeText;b.append(dot,label,c);gs.appendChild(b);});
   $('groupCount').textContent=orderedGroups.length+' 个';
   const ef=$('edgeFilters');ef.replaceChildren();Object.entries(edgeNames).forEach(([type,name])=>{if(!edges.some(e=>e.type===type))return;const b=button(name,()=>{allowedEdges.has(type)?allowedEdges.delete(type):allowedEdges.add(type);applyFilters();},'edge-pill'+(allowedEdges.has(type)?' active':''));b.dataset.edge=type;ef.appendChild(b);});
 }
 function visibleByFilter(n){
   if(n.type!=='conversation'&&n.type!=='project'&&state.profile&&n.profile!==state.profile)return false;
   if(n.type==='memory'&&state.memoryStatus&&n.status!==state.memoryStatus)return false;
   if(state.group&&n.cluster!==state.group)return false;
   if(state.type!=='all'&&n.type!==state.type)return false;
   if((n.type==='conversation'||n.type==='memory')&&numericDate(n.created)>state.cutoff)return false;
   if(state.query&&!String([n.label,n.title,n.content,n.entity,n.excerpt,n.project,n.sessionId,...(n.contentAssociation?.terms||[])].filter(Boolean).join(' ')).toLowerCase().includes(state.query))return false;
   return true;
 }
 let visibleEdges=[];
 function applyFilters(){
   nodes.forEach(n=>n.visible=visibleByFilter(n));
   // 分类节点只在总览或通过关系可见时出现。
   if(state.type!=='all'||state.group||state.query||state.profile||state.memoryStatus){nodes.filter(n=>n.type==='project'||n.type==='kind').forEach(n=>{n.visible=(!state.profile||n.type==='project'||n.profile===state.profile)&&adjacency.get(n.id).some(a=>a.node.visible&&allowedEdges.has(a.edge.type));});}
   visibleEdges=edges.filter(e=>allowedEdges.has(e.type)&&!ignoredLinks.has(e.id)&&map.get(e.source).visible&&map.get(e.target).visible);
   if(state.selected&&!map.get(state.selected)?.visible)clearSelection();
   if(state.selectedEdge&&!visibleEdges.some(e=>e.id===state.selectedEdge))clearSelection();
   updateGeometry();buildFilters();
   $('conversationCount').textContent=nodes.filter(n=>n.visible&&n.type==='conversation').length;
   $('memoryCount').textContent=nodes.filter(n=>n.visible&&n.type==='memory').length;
   $('edgeCount').textContent=visibleEdges.length;
   const contentVisible=nodes.filter(n=>n.visible&&!['project','kind'].includes(n.type));
   $('empty').hidden=contentVisible.length>0;
   $('emptyText').textContent=state.type==='memory'&&!counts.memory?'还没有保存的记忆。点左侧“＋ 保存记忆”写下要点，也可以点一段对话，再选“保存为记忆”。':state.type==='entity'&&!counts.entity?'当前还没有来自记忆库的实体记录。已有对话仍可完整浏览。':'试试其他关键词、分区或时间范围。';
   $('viewTitle').textContent=state.type==='memory'?'记忆的联系':state.query?'搜索到的记录':state.group?groups.get(state.group).label:'对话的群落';
   $('viewSubtitle').textContent=state.query?'匹配 '+contentVisible.length+' 条记录 · 点击节点查看出处':contentMode?'按共同话题分区 · 点击内容连线核对两段原文':'按项目与记录日期分区；密集时段自动按周或按日展开。';
   updateLabels();
 }
 function updateGeometry(){
   const selected=state.selected?map.get(state.selected):null;
   const selectedEdge=state.selectedEdge?edges.find(e=>e.id===state.selectedEdge):null;
   const near=new Set(selectedEdge?[selectedEdge.source,selectedEdge.target]:selected?[selected.id,...adjacency.get(selected.id).filter(a=>allowedEdges.has(a.edge.type)&&!ignoredLinks.has(a.edge.id)).map(a=>a.node.id)]:[]);
   nodes.forEach((n,i)=>{dummy.position.copy(n.pos);let sz=n.visible?n.size:0.00001;if(selected&&n.id===selected.id)sz*=1.4;dummy.scale.setScalar(sz);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);cc.set(n.color);if(selected&&!near.has(n.id))cc.multiplyScalar(.17);if(n.status==='dormant')cc.multiplyScalar(.32);mesh.setColorAt(i,cc);pointColors.set([cc.r,cc.g,cc.b],i*3);pointSizes[i]=n.visible?sz*11:0;});
   mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;pg.attributes.color.needsUpdate=true;pg.attributes.size.needsUpdate=true;
   linePositions.fill(0);lineColors.fill(0);
   visibleEdges.forEach((e,i)=>{const a=map.get(e.source),b=map.get(e.target);a.pos.toArray(linePositions,i*6);b.pos.toArray(linePositions,i*6+3);const col=new T.Color(e.type==='content'?'#77d8c8':e.type==='parent'?'#a49bdd':e.type==='source'?'#d1b779':a.color);col.multiplyScalar(selected?.005:e.type==='content'?.48:e.type==='parent'?.24:e.type==='project'?(nodes.length>=80?.0015:.04):.14);col.toArray(lineColors,i*6);col.toArray(lineColors,i*6+3);});
   lineGeometry.attributes.position.needsUpdate=true;lineGeometry.attributes.color.needsUpdate=true;lineGeometry.setDrawRange(0,visibleEdges.length*2);
   const hp=[];if(selected)visibleEdges.filter(e=>selectedEdge?e.id===selectedEdge.id:e.source===selected.id||e.target===selected.id).forEach(e=>{hp.push(...map.get(e.source).pos.toArray(),...map.get(e.target).pos.toArray());});
   highlightLine.geometry.dispose();highlightLine.geometry=new T.BufferGeometry();highlightLine.geometry.setAttribute('position',new T.Float32BufferAttribute(hp,3));
   focusRing.visible=!!selected;if(selected)focusRing.position.copy(selected.pos);
 }
 function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
 function row(dl,key,value){dl.append(el('dt',key),el('dd',String(value??'未记录')));}
 function selectNode(id,focus=true){
   const n=map.get(id);if(!n||!n.visible)return false;state.selected=id;state.selectedEdge=null;$('tooltip').hidden=true;
   $('detail').hidden=false;document.body.classList.add('has-detail');const box=$('detailContent');box.replaceChildren();
   box.append(el('span',(names[n.type]||n.type).toUpperCase()+' / LOCAL RECORD','eyebrow'),el('h3',n.type==='memory'?'已保存的记忆':n.title||n.label));
   const tag=el('span',n.type==='memory'?(kinds[n.kind]||n.kind):n.type==='conversation'?(n.sub?'子代理对话':'主对话'):names[n.type],'tag');box.append(tag);
   if(!window.__MEMORY_DEMO__&&(n.type==='conversation'||n.type==='memory')){
     const manage=el('div',undefined,'detail-actions memory-primary-actions');
     const b=button(n.type==='memory'?'取消保存':'保存为记忆',()=>n.type==='memory'?window.__MEMORY_MANAGER__?.cancel(n):window.__MEMORY_MANAGER__?.save(n));
     b.dataset.memoryAction=n.type==='memory'?'cancel':'remember';manage.append(b);box.append(manage);
   }
   if(n.type==='memory')box.append(el('p',n.content||n.title||n.label,'body-text memory-content'));
   if(n.type==='memory')box.append(el('span',({dormant:'休眠',active:'活跃',superseded:'已被更新'})[n.status]||n.status,'tag'));
   if(n.excerpt)box.append(el('p',n.excerpt,'body-text'));
   const dl=el('dl');
   if(n.type==='memory')row(dl,'聊天对象',n.profile||'default');
   if(n.type==='conversation'){row(dl,'创建时间',fmt(n.created));row(dl,'最近活动',fmt(n.last||n.created));row(dl,'对话轮次',n.turns||0);row(dl,'项目',n.project||'未记录');row(dl,'会话 ID',n.sessionId);}
   if(n.type==='memory'){row(dl,'重要度 / 保存权重',(Number(n.importance)||0).toFixed(2)+' / '+(Number(n.weight)||0).toFixed(2));row(dl,'来源会话',n.sourceSession||(n.missingSource?'来源缺失':'未记录'));row(dl,'累计召回',n.recallCount||0);row(dl,'更新时间',n.updated?fmt(n.updated):'未记录');row(dl,'实体',n.entity||'未记录');}
   row(dl,'数据来源',Array.isArray(n.source)?n.source.join('\n'):n.source||'本地快照');box.append(dl);
   if(n.contentAssociation?.terms?.length)box.append(el('p','识别到的话题：'+n.contentAssociation.terms.join('、')+'。内容关系是自动推测，可逐条核对原文。','body-text'));
   const related=adjacency.get(id).filter(a=>allowedEdges.has(a.edge.type)&&!ignoredLinks.has(a.edge.id)).sort((a,b)=>Number(b.edge.type==='content')-Number(a.edge.type==='content'));box.append(el('h4','联系与依据 · '+related.length));
   related.slice(0,20).forEach(a=>{const b=button('',()=>{if(a.edge.type==='content'){selectEdge(a.edge.id);return;}if(!a.node.visible)reset();selectNode(a.node.id);},'neighbor');b.dataset.relationship=a.edge.type;const dot=el('i',undefined,'dot');dot.style.background=a.node.color;dot.style.color=a.node.color;const text=el('span',a.node.title||a.node.label);text.append(el('small',(edgeNames[a.edge.type]||a.edge.type)+' · '+(a.edge.basis||'原始字段')));b.append(dot,text);box.append(b);});
   if(related.length>20)box.append(el('p','其余 '+(related.length-20)+' 条关系已在网络中高亮。','body-text'));
   if(!related.length)box.append(el('p','在当前筛选下没有可显示的确定关系。','body-text'));
   const actions=el('div',undefined,'detail-actions');
   actions.append(button('复制'+(n.type==='conversation'?'会话 ID':'节点 ID'),()=>copy(n.sessionId||n.id)));
   if(n.type==='conversation'){const link=el('a','在行星星图中定位 ↗');link.href='02-记忆星图.html?star='+encodeURIComponent(n.sessionId);actions.append(link);}
   if(n.type==='conversation'&&window.__MEMORY_DSH__)actions.append(button('打开 DSH 原会话',()=>parent.postMessage({type:'memory-universe:open-session',sessionId:n.sessionId},location.origin)));
   box.append(actions);updateGeometry();updateLabels();
   if(focus){state.wantedTarget.copy(n.pos);state.wantedDistance=Math.max(540,overviewDistance()*.55);}return true;
 }
 function selectEdge(id){
   const edge=edges.find(e=>e.id===id&&e.type==='content');if(!edge||ignoredLinks.has(id)||!allowedEdges.has('content'))return false;
   if(!map.get(edge.source).visible||!map.get(edge.target).visible)resetAll();
   selectNode(edge.source,false);state.selectedEdge=id;
   const box=$('detailContent');box.replaceChildren();box.append(el('span','内容相关 / 自动推测','eyebrow'),el('h3',edge.terms.join(' · ')),el('p','两段对话出现了共同话题。请核对下面的原文；这条联系没有被写成个人记忆。','body-text'));
   for(const evidence of edge.evidence||[]){const n=map.get(evidence.nodeId);if(!n)continue;const card=el('article',undefined,'evidence-card');card.append(el('h4',n.title||n.label),el('small',fmt(n.created)+' · '+(evidence.kind==='title'?'对话标题':'用户消息第 '+evidence.turn+' 条')),el('blockquote',evidence.text));card.append(button('定位这段对话',()=>selectNode(n.id)));if(window.__MEMORY_DSH__)card.append(button('打开 DSH 原会话',()=>parent.postMessage({type:'memory-universe:open-session',sessionId:n.sessionId},location.origin)));box.append(card);}
   const actions=el('div',undefined,'detail-actions');actions.append(button('这条关联不合适',()=>{ignoredLinks.add(id);saveIgnored();clearSelection();applyFilters();toast('已忽略这条内容关联，可在左栏恢复。');}));box.append(actions);
   state.wantedTarget.copy(map.get(edge.source).pos).add(map.get(edge.target).pos).multiplyScalar(.5);state.wantedDistance=Math.max(650,map.get(edge.source).pos.distanceTo(map.get(edge.target).pos)*2);updateGeometry();updateLabels();return true;
 }
 async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch(e){const ta=document.createElement('textarea');ta.value=text;document.body.append(ta);ta.select();const ok=document.execCommand('copy');ta.remove();toast(ok?'已复制':'复制未获浏览器授权，请在详情中选择文字复制。');}}
 function clearSelection(){state.selected=null;state.selectedEdge=null;$('detail').hidden=true;document.body.classList.remove('has-detail');if(mesh)updateGeometry();}
 function home(clear=true){if(clear)clearSelection();state.wantedTarget.copy(homeCenter);state.wantedDistance=overviewDistance();state.yaw=0;state.pitch=.09;}
 function reset(){state.type='all';state.group=null;state.query='';state.cutoff=maxDate;$('search').value='';$('timeRange').value='1000';$('dateEnd').textContent='全部记录';home();applyFilters();}
 $('clearFilters').onclick=reset;$('emptyReset').onclick=reset;$('home').onclick=()=>home();$('closeDetail').onclick=()=>{clearSelection();home(false);};
 const resetBase=reset;
 $('profileFilter').onchange=()=>{state.profile=$('profileFilter').value;clearSelection();applyFilters();renderEvents();};
 $('memoryStatus').onchange=()=>{state.memoryStatus=$('memoryStatus').value;clearSelection();applyFilters();};
 const resetAll=()=>{state.profile='';state.memoryStatus='';$('profileFilter').value='';$('memoryStatus').value='';resetBase();renderEvents();};
 $('clearFilters').onclick=resetAll;$('emptyReset').onclick=resetAll;
 if($('restoreLinks'))$('restoreLinks').onclick=()=>{ignoredLinks.clear();saveIgnored();clearSelection();applyFilters();toast('已恢复自动内容关联。');};
 if($('layoutMode')){$('layoutMode').value=contentMode?'content':'timeline';$('layoutMode').onchange=()=>{const url=new URL(location.href);url.searchParams.set('layout',$('layoutMode').value);if(state.selected)url.searchParams.set('select',state.selected);window.__MEMORY_FRAME__?.dispose();dispose();location.replace(url.href);};}
 for(const p of [...new Set(nodes.filter(n=>n.type==='memory').map(n=>n.profile||'default'))]){const o=el('option',p);o.value=p;$('profileFilter').append(o);}
 const eventNames={created:'记住',strengthened:'印象加深',recalled:'召回',woke:'唤醒',slept:'休眠',superseded:'被新记忆取代',resolve_signal:'化解线索',deleted:'取消保存'};
 function renderEvents(){
   const events=(data.events||[]).filter(e=>!state.profile||e.profile===state.profile);
   $('eventCount').textContent=events.length;$('eventList').replaceChildren();
   if(!events.length){$('eventList').append(el('p','还没有可显示的真实记忆事件。','event-help'));return;}
   events.slice(-30).reverse().forEach(e=>{const n=map.get(e.memoryNodeId);const b=button('',()=>{if(!n)return;if(!n.visible)resetAll();selectNode(n.id);},'memory-event');b.append(el('strong',eventNames[e.action]||e.action),el('small',new Date(e.created_at).toLocaleString('zh-CN')),el('span',n?.content||e.detail||'无对应记忆'));if(!n)b.disabled=true;$('eventList').append(b);});
 }
 function syncMotion(){$('motion').replaceChildren(document.createTextNode(state.spin?'Ⅱ ':'▷ '),el('span',state.spin?'暂停旋转':'继续旋转'));}syncMotion();
 $('motion').onclick=()=>{state.spin=!state.spin;syncMotion();};
 $('labelsToggle').onclick=()=>{state.labels=!state.labels;$('labelsToggle').replaceChildren(document.createTextNode('Aa '),el('span',state.labels?'隐藏标题':'显示标题'));updateLabels();};
 $('search').oninput=()=>{state.query=$('search').value.trim().toLowerCase();clearSelection();applyFilters();};
 $('searchForm').onsubmit=e=>{e.preventDefault();const n=nodes.find(n=>n.visible&&!['project','kind'].includes(n.type));if(n)selectNode(n.id);};
 $('timeRange').oninput=()=>{state.cutoff=minDate+(maxDate-minDate)*Number($('timeRange').value)/1000;$('dateEnd').textContent=Number($('timeRange').value)===1000?'全部记录':fmt(state.cutoff)+' 之前';applyFilters();};
 $('capture').onclick=()=>{renderer.render(scene,camera);const a=document.createElement('a');a.href=canvas.toDataURL('image/png');a.download='记忆宇宙_'+new Date().toISOString().slice(0,10)+'.png';a.click();toast('已保存三维画面（不包含控制栏）');};
 listen(window,'keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();$('search').focus();}if(e.key==='Escape'){clearSelection();home(false);}});
 const raycaster=new T.Raycaster(),mouse=new T.Vector2(),panRight=new T.Vector3(),panUp=new T.Vector3();let dragging=false,dragPan=false,dragMoved=0,lastX=0,lastY=0;
 function panView(dx,dy){
   const scale=2*state.distance*Math.tan(camera.fov*Math.PI/360)/Math.max(1,viewH);
   panRight.setFromMatrixColumn(camera.matrixWorld,0).multiplyScalar(-dx*scale);
   panUp.setFromMatrixColumn(camera.matrixWorld,1).multiplyScalar(dy*scale);
   panRight.add(panUp);state.target.add(panRight);state.wantedTarget.add(panRight);
 }
 function hit(x,y){mouse.set(x/viewW*2-1,-y/viewH*2+1);raycaster.setFromCamera(mouse,camera);const hits=raycaster.intersectObject(mesh);for(const h of hits){const n=nodes[h.instanceId];if(n&&n.visible)return n;}return null;}
 function hitEdge(x,y){let best=null,bestDistance=7;for(const edge of visibleEdges){if(edge.type!=='content')continue;const a=screen(map.get(edge.source).pos),b=screen(map.get(edge.target).pos);if(a.z>1||b.z>1)continue;const dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;if(len<100)continue;const t=((x-a.x)*dx+(y-a.y)*dy)/len;if(t<.08||t>.92)continue;const distance=Math.hypot(x-a.x-t*dx,y-a.y-t*dy);if(distance<bestDistance){best=edge;bestDistance=distance;}}return best;}
 listen(canvas,'pointerdown',e=>{if(e.button!==0)return;dragging=true;dragPan=!!e.shiftKey;dragMoved=0;lastX=e.clientX;lastY=e.clientY;canvas.style.cursor=dragPan?'move':'grabbing';canvas.setPointerCapture(e.pointerId);});
 listen(canvas,'pointermove',e=>{if(dragging){const dx=e.clientX-lastX,dy=e.clientY-lastY;dragMoved+=Math.abs(dx)+Math.abs(dy);dragPan=dragPan||e.shiftKey;if(dragPan){panView(dx,dy);canvas.style.cursor='move';}else{state.yaw-=dx*.003;state.pitch=Math.max(-1.1,Math.min(1.1,state.pitch+dy*.003));}lastX=e.clientX;lastY=e.clientY;$('tooltip').hidden=true;return;}const n=hit(e.clientX,e.clientY),edge=n?null:hitEdge(e.clientX,e.clientY);canvas.style.cursor=n||edge?'pointer':e.shiftKey?'move':'grab';const tt=$('tooltip');tt.hidden=!n&&!edge;if(n||edge){tt.replaceChildren(document.createTextNode(n?(n.title||n.label):edge.basis),el('small',n?(names[n.type]||n.type)+' · 点击查看出处':'内容相关（推测） · 点击核对两段原文'));tt.style.left=Math.min(viewW-305,e.clientX+15)+'px';tt.style.top=Math.min(viewH-170,e.clientY+16)+'px';}});
 listen(canvas,'pointerup',e=>{if(!dragging)return;dragging=false;canvas.style.cursor='grab';if(dragMoved<6&&!dragPan){const n=hit(e.clientX,e.clientY),edge=n?null:hitEdge(e.clientX,e.clientY);if(n)selectNode(n.id);else if(edge)selectEdge(edge.id);else if(state.selected){clearSelection();home(false);}}dragPan=false;});
 const stopDrag=()=>{dragging=false;dragPan=false;canvas.style.cursor='grab';};
 listen(canvas,'pointercancel',stopDrag);listen(window,'blur',stopDrag);listen(canvas,'pointerleave',()=>$('tooltip').hidden=true);
 listen(canvas,'wheel',e=>{e.preventDefault();state.wantedDistance=Math.max(260,Math.min(6200,state.wantedDistance*Math.exp(e.deltaY*.001)));},{passive:false});listen(canvas,'dblclick',()=>home());
 const nodeLabels=[];
 function updateLabels(){nodeLabels.forEach(x=>x.el.remove());nodeLabels.length=0;const selected=map.get(state.selected);let list=state.labels?nodes.filter(n=>n.visible&&n.type==='conversation').sort((a,b)=>(b.turns||0)-(a.turns||0)).slice(0,12):[];if(selected){list=[selected,...list];}const used=new Set();list.forEach(n=>{if(used.has(n.id))return;used.add(n.id);const d=el('div',n.title||n.label,'node-label');$('labels').appendChild(d);nodeLabels.push({node:n,el:d});});}
 const temp=new T.Vector3();
 function screen(pos){temp.copy(pos).project(camera);return{x:(temp.x+1)*viewW/2,y:(1-temp.y)*viewH/2,z:temp.z};}
 let fps=0,frames=0,lastFps=performance.now(),prev=performance.now();
 function frame(t){if(disposed)return;raf=requestAnimationFrame(frame);if(t-lastDraw<1000/45)return;lastDraw=t;if(document.hidden){prev=t;return;}const dt=Math.min(.06,(t-prev)/1000);prev=t;if(state.spin&&!dragging&&!state.selected)state.yaw+=dt*.025;state.target.lerp(state.wantedTarget,1-Math.exp(-dt*6));state.distance+=(state.wantedDistance-state.distance)*(1-Math.exp(-dt*6));camera.position.set(state.target.x+Math.sin(state.yaw)*Math.cos(state.pitch)*state.distance,state.target.y+Math.sin(state.pitch)*state.distance,state.target.z+Math.cos(state.yaw)*Math.cos(state.pitch)*state.distance);camera.lookAt(state.target);camera.updateMatrixWorld();focusRing.quaternion.copy(camera.quaternion);renderer.render(scene,camera);
   const groupPoints=orderedGroups.map(g=>screen(g.center.clone().add(new T.Vector3(0,g.radius+24,0))));
   orderedGroups.forEach((g,i)=>{const visible=g.nodes.some(n=>n.visible);const p=groupPoints[i];let width=contentMode?148:110;groupPoints.forEach((q,j)=>{if(i!==j&&Math.abs(p.y-q.y)<38)width=Math.min(width,Math.abs(p.x-q.x)-10);});g.el.style.maxWidth=Math.max(contentMode?70:36,width)+'px';g.el.style.left=p.x+'px';g.el.style.top=p.y+'px';g.el.style.opacity=visible&&p.z<1&&!state.selected?'0.9':'0';});
   nodeLabels.forEach(x=>{const p=screen(x.node.pos);x.el.style.left=p.x+'px';x.el.style.top=(p.y+12)+'px';x.el.style.opacity=x.node.visible&&p.z<1?'1':'0';});frames++;if(t-lastFps>1000){fps=frames*1000/(t-lastFps);frames=0;lastFps=t;}
 }
 // 记忆库三态：未接入 / 已接入但零记忆 / 已保存记忆。措辞只讲用户要点，不暴露实现细节。
 const memoryState=counts.memory>0?'ready':(meta.memoryAvailable||meta.memorySources?.some(s=>s.status==='ok')?'empty':'none');
 function renderMemoryNotice(){
   const note=$('notice');note.replaceChildren();
   let title,text;
   if(memoryState==='ready'){title='已保存 '+counts.memory+' 条记忆';text=' · 保存的是你明确提供的个人要点；对话记录不会自动变成记忆。';}
   else if(memoryState==='empty'){title='记忆库已接入';text=' · 还没有保存的记忆。点左侧“＋ 保存记忆”，或从对话详情中摘录要点。';}
   else {title='尚未接入记忆库';text=' · 现在看到的是真实对话网络。在 DSH 内点“＋ 保存记忆”即可保存第一条要点。';}
   note.append(el('strong',title),document.createTextNode(text));
   if(meta.contentAssociations)note.append(el('span',' 内容相关 '+edges.filter(e=>e.type==='content').length+' 条，来自用户对话原文；自动推测可核对、可忽略。'));
   if(window.__MEMORY_DSH__){const b=button('对照虚构示例',()=>parent.postMessage({type:'memory-universe:demo'},location.origin),'notice-link');note.append(b);}
 }
 renderMemoryNotice();
 $('dateStart').textContent=fmt(minDate);$('updated').textContent='快照 '+new Date(data.generatedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
 applyFilters();renderEvents();raf=requestAnimationFrame(frame);

 function dispose(){
   if(disposed)return;disposed=true;cancelAnimationFrame(raf);for(const stop of stops.splice(0)){try{stop();}catch{}}
   renderer.setAnimationLoop(null);
   const geometries=new Set(),materials=new Set(),textures=new Set();
   scene.traverse(obj=>{if(obj.geometry)geometries.add(obj.geometry);for(const mat of (Array.isArray(obj.material)?obj.material:[obj.material])){if(!mat)continue;materials.add(mat);for(const value of Object.values(mat)){if(value?.isTexture)textures.add(value);}for(const uniform of Object.values(mat.uniforms||{})){if(uniform?.value?.isTexture)textures.add(uniform.value);}}});
   for(const item of [...textures,...geometries,...materials])item.dispose();
   scene.clear();renderer.renderLists?.dispose();renderer.dispose();renderer.forceContextLoss();canvas.remove();
 }
 listen(window,'pagehide',dispose,{once:true});
 window.__ATLAS__={data,nodes,edges,map,groups,selectNode,selectEdge,reset:resetAll,applyFilters,home,state,renderer,camera,screen,dispose,get disposed(){return disposed;},getInfo:()=>({visibleNodes:nodes.filter(n=>n.visible).length,visibleEdges:visibleEdges.length,contentEdges:visibleEdges.filter(e=>e.type==='content').length,layout:contentMode?'content':'timeline',counts,selected:state.selected,fps,canvas:{width:canvas.width,height:canvas.height,clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight},drawCalls:renderer.info.render.calls})};
 const wanted=new URLSearchParams(location.search).get('select');if(wanted){const id=map.has(wanted)?wanted:'conv:'+wanted;if(map.has(id))later(()=>selectNode(id),700);}
})();
