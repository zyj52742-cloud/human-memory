/* DSH iframe 生命周期：卸载前停止调度、释放场景并丢弃 GPU 上下文。 */
(function(){
 'use strict';
 if(window.__MEMORY_FRAME__)return;
 let disposed=false,visible=true,lastRender=0;
 const rafs=new Map(),nativeRAF=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
 const api=window.__ATLAS__||window.__STARMAP__,wrapper=api?.renderer,renderer=wrapper?.renderer||wrapper;
 const cap=()=>Math.min(Math.max(.5,Math.min(devicePixelRatio||1,1.5)),2048/Math.max(1,innerWidth,innerHeight));
 // 页面主体已排队的首帧随后会进入此调度器；卸载后不再续订。
 window.requestAnimationFrame=callback=>{
   if(disposed)return 0;
   const entry={callback,id:0};
   entry.id=nativeRAF(t=>{rafs.delete(entry.id);if(disposed)return;if(!visible){rafs.set(entry.id,entry);return;}callback(t);});
   rafs.set(entry.id,entry);return entry.id;
 };
 window.cancelAnimationFrame=id=>{rafs.delete(id);nativeCancel(id);};
 if(renderer){
   const setRatio=renderer.setPixelRatio.bind(renderer),render=renderer.render.bind(renderer);
   renderer.setPixelRatio=value=>setRatio(Math.min(Number(value)||1,cap()));
   renderer.setPixelRatio(cap());
   // 不降低几何或材质质量；内嵌页限制帧率，截图仍同步渲染。
   renderer.render=(scene,camera)=>{if(disposed||!visible)return;const now=performance.now();if(now-lastRender<1000/45&&!window.__MEMORY_CAPTURING__)return;lastRender=now;return render(scene,camera);};
   if(api===window.__ATLAS__)renderer.render=render; // 网络视图自身限制帧率，截图可同步重绘。
 }
 function select(sessionId){
   if(disposed||!sessionId||window.__MEMORY_DEMO__)return false;
   if(window.__ATLAS__)return window.__ATLAS__.selectNode('conv:'+sessionId);
   const star=window.__STARMAP__?.nodes?.find(n=>n.id===sessionId||n.id==='session-'+sessionId);
   if(star){window.__STARMAP__.openStar(star);return true;}return false;
 }
 function setVisible(value){
   if(disposed)return;const was=visible;visible=!!value;
   if(visible&&!was){const pending=[...rafs.values()];rafs.clear();for(const entry of pending){nativeCancel(entry.id);window.requestAnimationFrame(entry.callback);}}
 }
 function dispose(){
   if(disposed)return;disposed=true;
   for(const id of rafs.keys())nativeCancel(id);rafs.clear();
   window.__MEMORY_LIVE__?.dispose();
   removeEventListener('pagehide',dispose);removeEventListener('visibilitychange',onVisibility);
   try{
     renderer?.setAnimationLoop?.(null);
     if(api?.dispose)api.dispose();else wrapper?.dispose?.();
     renderer?.renderLists?.dispose?.();renderer?.dispose?.();renderer?.forceContextLoss?.();
   }catch(e){console.warn('记忆宇宙资源释放',e?.message);}
   for(const canvas of document.querySelectorAll('canvas'))canvas.remove();
 }
 function onVisibility(){setVisible(!document.hidden);}
 window.__MEMORY_FRAME__={version:2,dispose,select,setVisible,get disposed(){return disposed;},getInfo:()=>({disposed,visible,pendingFrames:rafs.size,pixelRatio:renderer?.getPixelRatio?.(),buffer:renderer?{width:renderer.domElement.width,height:renderer.domElement.height}:null,contextLost:renderer?.getContext?.().isContextLost()})};
 addEventListener('pagehide',dispose,{once:true});addEventListener('visibilitychange',onVisibility);
})();
