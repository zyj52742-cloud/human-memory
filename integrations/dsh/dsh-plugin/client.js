window.__ModuleLoader__.load({id:'local-memory-universe',factory:require=>{
  const React=require('react');
  const h=React.createElement;
  const ID='local-memory-universe';
  const BASE='/dsh-memory/products/';
  const DEMO_BASE='/dsh-memory/demo/products/';
  const RECORDS='records',DEMO='demo';
  function icon(props={}){return h('span',{style:{fontSize:props.size||20,lineHeight:1},'aria-hidden':true},'✺');}
  function apply(ctx){
    // 默认永远是“你的记录”；mode 只跟随明确的页面切换或工具打开。
    let wanted={mode:RECORDS,view:'network',sessionId:null},seq=0;
    let inventory=()=>Promise.resolve({error:'remote unavailable'}),manager;
    ctx.inject(['remote','remote.pluginInventory','remote.pluginManager'],c=>{
      inventory=()=>c.remote.pluginInventory.list();manager=c.remote.pluginManager;
      return()=>{manager=undefined;};
    });
    const subscribers=new Set(),frames=new Set();
    const releaseFrame=node=>{if(!node)return;frames.delete(node);try{node.contentWindow?.__MEMORY_FRAME__?.dispose();}catch{}};
    const setWanted=value=>{value={mode:value.mode===DEMO?DEMO:RECORDS,view:value.view==='planets'?'planets':'network',sessionId:value.sessionId||null};if(Object.keys(value).every(k=>value[k]===wanted[k]))return;wanted=value;for(const f of subscribers)f();};
    const tabStyle=(active,disabled)=>({display:'flex',flexDirection:'column',alignItems:'flex-start',gap:2,border:'1px solid '+(active?'#789bad':'#2c3a4c'),background:active?'#172b37':'transparent',color:active?'#eaf3fb':'#a9bccd',borderRadius:8,padding:'6px 12px',cursor:disabled?'default':'pointer',opacity:disabled?.55:1,textAlign:'left',minWidth:0});
    const viewStyle=active=>({border:'1px solid '+(active?'#789bad':'#3a4658'),background:active?'#263c49':'transparent',color:'#e3edf6',borderRadius:8,padding:'7px 12px',cursor:'pointer'});
    function Page(props){
      const [selection,setSelection]=React.useState(wanted);
      const [refreshKey,setRefreshKey]=React.useState(0);
      const [status,setStatus]=React.useState('正在读取你的本地记录…');
      const [live,setLive]=React.useState(null); // 最近一次成功读取的真实状态
      const [demo,setDemo]=React.useState(null); // 只读演示摘要，不含个人数据
      const [busy,setBusy]=React.useState(false);
      const frameRef=React.useRef(null);
      const bindFrame=React.useCallback(node=>{
        const previous=frameRef.current;
        if(previous&&previous!==node)releaseFrame(previous);
        if(node)frames.add(node);
        frameRef.current=node;
      },[]);
      React.useEffect(()=>{const f=()=>setSelection({...wanted});subscribers.add(f);return()=>subscribers.delete(f);},[]);
      const mode=selection.mode===DEMO?DEMO:RECORDS;
      const view=selection.view==='planets'?'planets':'network';
      const isDemo=mode===DEMO;
      const locate=()=>{try{frameRef.current?.contentWindow?.__MEMORY_FRAME__?.select(isDemo?null:selection.sessionId);}catch{}};
      React.useEffect(()=>{locate();},[mode,view,selection.sessionId]);
      React.useEffect(()=>{const node=frameRef.current;if(!node)return;const observer=new IntersectionObserver(entries=>{try{node.contentWindow?.__MEMORY_FRAME__?.setVisible(entries[0]?.isIntersecting!==false);}catch{}});observer.observe(node);return()=>observer.disconnect();},[mode,view,refreshKey,live?.products?.[view],demo?.products?.[view]]);

      async function getStatus(){
        try{
          const r=await fetch('/dsh-memory/status');if(!r.ok)throw Error('HTTP '+r.status);
          const s=await r.json();
          setLive(s);if(s.demo)setDemo(s.demo);
          setStatus('本地记录 · 可管理记忆');
          return s;
        }catch{setStatus('本地数据暂时不可用，请点“刷新数据”重试');return null;}
      }
      // 只有“你的记录”模式读取真实快照；演示模式绝不轮询真实数据。
      React.useEffect(()=>{
        if(isDemo)return;
        let alive=true;
        const run=()=>{if(alive&&!document.hidden)getStatus();};
        getStatus();const t=setInterval(run,10000);
        return()=>{alive=false;clearInterval(t);};
      },[isDemo]);
      React.useEffect(()=>{
        if(!isDemo)return;
        let alive=true;
        fetch('/dsh-memory/demo/status').then(r=>r.ok?r.json():Promise.reject(Error('HTTP '+r.status))).then(d=>{if(alive)setDemo(d);}).catch(()=>{});
        return()=>{alive=false;};
      },[isDemo]);
      async function refresh(){
        if(isDemo)return;
        setBusy(true);
        try{const r=await fetch('/dsh-memory/refresh',{method:'POST'});if(!r.ok)throw Error('HTTP '+r.status);await getStatus();setRefreshKey(x=>x+1);}
        catch{setStatus('刷新失败，原有快照保留');}
        finally{setBusy(false);}
      }
      // 切换模式会清空会话定位与节点选择，另一种模式的数据一律不续用。
      const switchMode=next=>{
        if(next===mode)return;
        if(next===DEMO&&demo&&demo.available===false)return;
        setWanted({mode:next,view,sessionId:null});
        // mode 本身就是 iframe 的身份；不额外重建。
      };
      const switchView=next=>{if(next===view)return;setWanted({mode,view:next,sessionId:selection.sessionId});};

      const liveCounts=live&&live.counts;
      const demoCounts=demo&&demo.counts;
      const demoUnavailable=demo&&demo.available===false;
      const liveSub=liveCounts?liveCounts.conversations+' 段对话 · '+liveCounts.memories+' 条记忆':'读取中…';
      const demoSub=demoUnavailable?'未安装':demoCounts?demoCounts.conversations+' 段对话 · '+demoCounts.memories+' 条记忆':'虚构数据';

      let info;
      const demoAction=demoUnavailable?null:['看看示例演示',()=>switchMode(DEMO)];
      if(isDemo)info={tone:'#e08a6e',title:'虚构示例',text:'以下对话、记忆与实体全部为合成数据，与你的记录无关。',action:['返回我的记录',()=>switchMode(RECORDS)]};
      else if(!live)info={tone:'#6f8299',title:'正在读取你的本地记录',text:'读取完成后会显示对话与记忆库状态。',action:null};
      else if(live.memoryState==='ready')info={tone:'#6fbf9a',title:'已保存 '+liveCounts.memories+' 条记忆',text:'保存的是你明确提供的个人要点；对话记录不会自动变成记忆。',action:demoAction};
      else if(live.memoryState==='empty')info={tone:'#d8ba7e',title:'记忆库已接入，还没有保存的记忆',text:'保存的记忆是个人要点，对话记录不会自动变成记忆。在对话里说“记住：……”即可开始。',action:demoAction};
      else info={tone:'#6f8299',title:'尚未接入记忆库',text:'现在看到的是你的真实对话网络。保存的记忆是个人要点，对话记录不会自动变成记忆。在对话里说“记住：……”即可开始。',action:demoAction};

      const products=isDemo?(demo&&demo.products):(live&&live.products);
      const source=products?products[view]:null;
      const query=new URLSearchParams({embedded:'1'});
      // 会话定位由已加载页面 API 原位完成，不更改 src。
      const src=source?(isDemo?DEMO_BASE:BASE)+source+'?'+query.toString():null;
      const frameKey=mode+'|'+view+'|'+refreshKey;
      const demoLoading=isDemo&&!demo;
      const demoBroken=isDemo&&demo&&demo.available&&!source;
      const demoProblemTitle=demoLoading?'正在载入示例演示':demoBroken?'示例演示数据不完整':'示例演示暂未安装';
      const demoProblemText=demoLoading?'只读取虚构示例，不会触碰你的记录。':demoBroken?'示例文件暂不完整，补齐后重试；你的记录不受影响。':'安装示例后即可对照两个视图；你的记录不受影响。';

      return h('section',{'data-memory-universe-panel':'true',style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column',background:'#080e18',color:'#dbe6ef'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',flexWrap:'wrap',borderBottom:'1px solid #263344',flexShrink:0}},
          h('strong',{style:{fontSize:15,marginRight:4,whiteSpace:'nowrap'}},'✺ 记忆宇宙'),
          h('div',{style:{display:'flex',gap:6,flexWrap:'wrap'}},
            h('button',{type:'button',onClick:()=>switchMode(RECORDS),style:tabStyle(mode===RECORDS,false),title:'只显示这台电脑上你的真实对话与记忆'},
              h('span',{style:{fontSize:12,fontWeight:600}},'你的记录'),
              h('small',{style:{fontSize:10,color:'#8fa3b5'}},liveSub)),
            h('button',{type:'button',onClick:()=>switchMode(DEMO),disabled:!!demoUnavailable,style:tabStyle(mode===DEMO,!!demoUnavailable),title:demoUnavailable?'示例演示尚未安装':'只显示虚构的合成示例，不读取你的记录'},
              h('span',{style:{fontSize:12,fontWeight:600,display:'inline-flex',alignItems:'center',gap:5}},'示例演示',h('i',{style:{fontStyle:'normal',fontSize:9,padding:'1px 4px',border:'1px solid rgba(226,120,96,.45)',borderRadius:3,color:'#ffb7a3',background:'rgba(160,45,32,.18)'}},'虚构')),
              h('small',{style:{fontSize:10,color:'#8fa3b5'}},demoSub))),
          h('div',{style:{display:'flex',gap:6,alignItems:'center'}},
            h('button',{type:'button',onClick:()=>switchView('network'),style:viewStyle(view==='network')},'关联网络'),
            h('button',{type:'button',onClick:()=>switchView('planets'),style:viewStyle(view==='planets')},'真实行星')),
          !isDemo?h('button',{type:'button',disabled:busy,onClick:refresh,style:{padding:'6px 10px',borderRadius:8,color:'#dbe6ef',background:'#192736',border:'1px solid #3a4658'}},busy?'刷新中…':'刷新数据'):null,
          h('span',{style:{fontSize:11,color:'#9aaebe',marginLeft:'auto'}},isDemo?'虚构示例 · 只读':status)),
        h('div',{style:{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap',padding:'8px 16px',borderBottom:'1px solid #1e2a38',background:'#0b1420',flexShrink:0}},
          h('strong',{style:{fontSize:12,color:info.tone,fontWeight:600}},'● '+info.title),
          h('span',{style:{fontSize:11,color:'#9fb2c4',lineHeight:1.6}},info.text),
          info.action?h('button',{type:'button',onClick:info.action[1],style:{marginLeft:'auto',padding:'3px 10px',borderRadius:6,fontSize:11,color:'#dbe6ef',background:'#182636',border:'1px solid #3a4658',whiteSpace:'nowrap'}},info.action[0]):null),
        src?h('iframe',{key:frameKey,ref:bindFrame,onLoad:locate,'data-memory-mode':mode,title:'DSH 内的记忆宇宙',src,style:{width:'100%',height:'100%',flex:'1 1 0',minHeight:0,border:0},allow:'clipboard-write; fullscreen'}):
          h('div',{style:{flex:'1 1 0',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,padding:24,textAlign:'center',color:'#9fb2c4'}},
            h('strong',{style:{fontSize:14,color:'#dbe6ef'}},isDemo?demoProblemTitle:'正在读取你的记录'),
            h('span',{style:{fontSize:12}},isDemo?demoProblemText:'读取完成后会自动显示；也可以点“刷新数据”重试。'),
            isDemo?h('button',{type:'button',onClick:()=>switchMode(RECORDS),style:{padding:'6px 12px',borderRadius:8,color:'#dbe6ef',background:'#192736',border:'1px solid #3a4658'}},'返回我的记录'):null),
        h('div',{style:{fontSize:11,color:'#91a6b7',padding:'6px 16px',flexShrink:0}},isDemo?'虚构示例：两个视图都可切换；不会读取或改写你的记录。':'在关联网络中点“＋ 保存记忆”记录要点；在记忆详情中可取消保存。原始聊天保留。')
      );
    }
    ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:ID},Page));
    ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:ID,order:21,label:()=> '记忆宇宙'},icon));
    ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'memory-universe',order:21,label:()=> '记忆宇宙'},Page));
    ctx.inject(['sidebarRightTabs'],s=>{
      const dispose=s.sidebarRightTabs.register({id:ID,kind:ID,title:()=> '记忆宇宙',guide:[{order:21,title:()=> '记忆宇宙',description:()=> '在 DSH 中查看真实对话、记忆与召回事件',icon}]});
      s.slots.inject('sidebar.right.pane.tab',()=>s.slots.register({name:'sidebar.right.pane.tab',key:ID},Page));
      s.slots.inject('sidebar.right.pane.tab.title',()=>s.slots.register({name:'sidebar.right.pane.tab.title',key:ID},()=>h('span',null,'✺ 记忆宇宙')));
      return dispose;
    });
    let disposed=false,polling=false;
    async function poll(){
      if(disposed||polling)return;
      polling=true;
      if(document.visibilityState==='visible')try{
        const r=await fetch('/dsh-memory/commands');
        if(r.ok){const c=await r.json();if(!disposed&&c.id>seq){seq=c.id;/* 工具入口固定打开真实数据 */setWanted({mode:RECORDS,view:c.view,sessionId:c.sessionId});ctx.get('layout')?.selectPanel(ID);}}
      }catch{}
      polling=false;
    }
    const timer=setInterval(poll,3000);poll();
    const onMessage=e=>{
      if(disposed||e.origin!==location.origin||!e.source||!e.data||typeof e.data!=='object')return;
      let fromFrame=null;
      for(const frame of frames){try{if(frame?.isConnected&&frame.contentWindow&&frame.contentWindow===e.source){fromFrame=frame;break;}}catch{}}
      if(!fromFrame)return;
      if(e.data.type==='memory-universe:open-session'){
        // 只有真实数据页可以回链原会话；演示页永远不会发送这个请求。
        if(fromFrame.dataset?.memoryMode!==RECORDS)return;
        const id=e.data.sessionId;
        if(typeof id==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(id))ctx.get('uiWorkspace')?.openSession(id);
      } else if(e.data.type==='memory-universe:demo'){
        if(wanted.mode===RECORDS)setWanted({mode:DEMO,view:wanted.view,sessionId:null});
      }
    };
    window.addEventListener('message',onMessage);
    ctx.effect(()=>()=>window.removeEventListener('message',onMessage));
    ctx.effect(()=>()=>{disposed=true;clearInterval(timer);for(const frame of [...frames])releaseFrame(frame);subscribers.clear();});
    // Non-sensitive diagnostic surface for actual desktop verification.
    window.__MEMORY_UNIVERSE_DSH__={open:(view='network',sessionId=null)=>{setWanted({mode:RECORDS,view,sessionId});ctx.layout.selectPanel(ID);},getState:()=>({...wanted,commandId:seq}),inventory:()=>inventory(),manager:()=>manager};
    ctx.effect(()=>()=>delete window.__MEMORY_UNIVERSE_DSH__);
  }
  return {name:ID,inject:['slots','layout','uiWorkspace'],apply};
}});
