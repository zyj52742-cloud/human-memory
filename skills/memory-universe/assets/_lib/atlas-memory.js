/* 用户主动保存/取消；示例只读，独立快照不伪装成可写页面。 */
(function(){
 'use strict';
 const a=window.__ATLAS__,entry=document.getElementById('saveMemory');
 if(!a||!entry)return;
 if(window.__MEMORY_DEMO__){entry.hidden=true;return;}
 const key='memory-universe:after-management:v1';
 let dialog=null,busy=false,disposed=false;
 const controller=new AbortController();
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const btn=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=fn;return b;};
 function close(){if(busy)return;dialog?.close();dialog?.remove();dialog=null;window.__MEMORY_EDITING__=false;}
 function shell(title){
   close();window.__MEMORY_EDITING__=true;dialog=el('dialog',undefined,'memory-dialog');
   dialog.setAttribute('aria-label',title);dialog.append(el('h2',title));
   dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
   document.body.append(dialog);dialog.showModal();return dialog;
 }
 function writable(){
   if(window.__MEMORY_DSH__)return true;
   const d=shell('请在 DSH 内保存记忆');
   d.append(el('p','当前是独立快照。请打开 DSH 左侧的“记忆宇宙”，选择“你的记录 → 关联网络”，再点“＋ 保存记忆”。','memory-help'),btn('知道了',close));return false;
 }
 function reload(result,message){
   const s=a.state;
   const saved={type:'memory',profile:result.nodeId&&result.action!=='cancelled'?'':s.profile,memoryStatus:'',query:'',group:null,
     camera:{yaw:s.yaw,pitch:s.pitch,distance:s.distance,target:s.target.toArray()},message};
   try{sessionStorage.setItem(key,JSON.stringify(saved));}catch{}
   const url=new URL(location.href);url.searchParams.delete('select');if(result.nodeId&&result.action!=='cancelled')url.searchParams.set('select',result.nodeId);
   window.__MEMORY_FRAME__?.dispose();a.dispose();location.replace(url.href);
 }
 async function submit(payload,form,status,success){
   if(busy||disposed)return;busy=true;form.setAttribute('aria-busy','true');
   const controls=[...form.querySelectorAll('button,input,textarea,select')];controls.forEach(e=>e.disabled=true);
   status.textContent='正在'+(payload.action==='cancel'?'取消保存…':'保存…');status.classList.remove('memory-error');
   try{
     const response=await fetch('/dsh-memory/memory/manage',{method:'POST',headers:{'Content-Type':'application/json','X-Memory-Universe':'1'},body:JSON.stringify(payload),signal:controller.signal});
     const result=await response.json();if(disposed)return;
     if(!response.ok||!result.ok)throw Error(result.reason||result.error||'操作失败，请稍后重试');
     const message=result.action==='strengthened'?'这条记忆已存在，已加深印象，未重复新增。':result.action==='resolve_signal'?'已记录化解线索，未新增记忆。':success;
     status.textContent=message;reload(result,message);
   }catch(e){if(!disposed){status.textContent=e.name==='TypeError'?'连接中断，请先刷新并检查记忆是否已保存，再决定是否重试。':e.message;status.classList.add('memory-error');}}
   finally{busy=false;if(!disposed){form.removeAttribute('aria-busy');controls.forEach(e=>e.disabled=false);}}
 }
 function field(form,title,input){const label=el('label',undefined,'memory-field');label.append(el('span',title),input);form.append(label);}
 function save(node){
   if(busy||!writable())return;
   const d=shell('保存记忆'),form=el('form');d.append(form);
   form.append(el('p','写下你希望以后还能被记起的事实、偏好或要点。保存前可以编辑。','memory-help'));
   const text=el('textarea');text.name='text';text.required=true;text.maxLength=4000;text.rows=6;text.placeholder='例如：我喜欢简洁的中文回答，说明操作时先给具体步骤。';text.value=node?.excerpt||'';field(form,'记忆内容',text);
   const profile=el('input');profile.name='profile';profile.required=true;profile.maxLength=120;profile.value=a.state.profile||'default';field(form,'聊天对象（本人使用 default）',profile);
   const sessions=el('select');sessions.name='sessionId';const none=el('option','手动记录（不关联对话）');none.value='';sessions.append(none);
   a.nodes.filter(n=>n.type==='conversation').forEach(n=>{const o=el('option',n.title||n.label);o.value=n.sessionId;sessions.append(o);});sessions.value=node?.sessionId||'';field(form,'来源对话',sessions);
   const sources=a.data.metadata?.memorySources||[];
   const databases=el('select');databases.name='databaseId';
   if(!sources.length){const o=el('option','默认记忆库（首次保存时创建）');o.value='';databases.append(o);}
   else sources.forEach((s,i)=>{const o=el('option',(sources.length>1?'记忆库 '+(i+1)+' · ':'')+s.path+(s.status!=='ok'?'（不可用）':''));o.value=s.databaseId||'';o.disabled=s.status!=='ok';databases.append(o);});
   if(sources.length>1||sources.some(s=>s.status!=='ok'))field(form,'保存到',databases);
   const status=el('p','保存后可在“已保存记忆”中查看，也可以随时取消保存。','memory-result');status.setAttribute('role','status');form.append(status);
   const actions=el('div',undefined,'memory-dialog-actions'),submitButton=el('button','保存记忆');submitButton.type='submit';submitButton.className='memory-confirm';actions.append(btn('返回',close),submitButton);form.append(actions);
   form.onsubmit=e=>{e.preventDefault();if(!form.reportValidity())return;submit({action:'remember',text:text.value,profile:profile.value,sessionId:sessions.value,databaseId:databases.value},form,status,'已保存记忆。');};text.focus();
 }
 function cancel(node){
   if(busy||!writable())return;
   const d=shell('取消保存这条记忆？'),form=el('form');d.append(form);
   form.append(el('blockquote',node.content||node.title||node.label),el('p','取消后，这条要点会从已保存记忆中移除，停止后续召回。原始聊天保留。','memory-help'));
   const status=el('p','','memory-result');status.setAttribute('role','status');form.append(status);
   const actions=el('div',undefined,'memory-dialog-actions'),submitButton=el('button','确认取消保存');submitButton.type='submit';submitButton.className='memory-confirm';actions.append(btn('保留记忆',close),submitButton);form.append(actions);
   form.onsubmit=e=>{e.preventDefault();submit({action:'cancel',nodeId:node.id},form,status,'已取消保存，原始聊天保留。');};
 }
 entry.onclick=()=>save();window.__MEMORY_MANAGER__={save,cancel};
 if(!window.__MEMORY_DSH__)entry.title='请在 DSH 的记忆宇宙内使用';
 try{
   const saved=JSON.parse(sessionStorage.getItem(key)||'null');sessionStorage.removeItem(key);
   if(saved){Object.assign(a.state,{type:saved.type,profile:saved.profile,memoryStatus:saved.memoryStatus,query:'',group:null});
     document.getElementById('profileFilter').value=saved.profile;document.getElementById('memoryStatus').value='';
     a.applyFilters();
     if(saved.camera){a.state.yaw=saved.camera.yaw;a.state.pitch=saved.camera.pitch;a.state.distance=saved.camera.distance;a.state.wantedDistance=saved.camera.distance;a.state.target.fromArray(saved.camera.target);a.state.wantedTarget.copy(a.state.target);}
     const toast=document.getElementById('toast');toast.textContent=saved.message;toast.hidden=false;
     const timer=setTimeout(()=>{if(toast.textContent===saved.message)toast.hidden=true;},6500);addEventListener('pagehide',()=>clearTimeout(timer),{once:true});
   }
 }catch{}
 function dispose(){if(disposed)return;disposed=true;controller.abort();dialog?.remove();window.__MEMORY_EDITING__=false;removeEventListener('pagehide',dispose);}
 addEventListener('pagehide',dispose,{once:true});
})();
