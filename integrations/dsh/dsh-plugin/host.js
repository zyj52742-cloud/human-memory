import fs from 'node:fs/promises';
import {readdirSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export const name = 'local-memory-universe';
const ROOT = path.resolve(process.env.MEMORY_UNIVERSE_ROOT || path.join(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '../_runtime/network'));
const PRODUCTS = path.dirname(ROOT);
const PREFIX = '/dsh-memory/';
const DEMO_DIR = path.join(ROOT, '_demo');
const DEMO_LABEL = '虚构示例';
const STARMAP='planets';
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};

// 演示模式只允许这些确切文件；目录、通配、JSON 一律不开放。
const DEMO_FILES = new Set([
  '01-记忆宇宙.html',
  '02-记忆星图.html',
  'USAGE.md',
  '_lib/atlas.css',
  '_lib/atlas.js',
  '_lib/atlas-groups.js',
  '_lib/atlas-memory.js',
  '_lib/network-data.js',
  '_lib/data.js',
  '_lib/three.min.js',
  '_lib/memory-webgl.js',
  '_lib/tex_procedural.js',
  '_lib/body-guide.js',
  '_lib/body-catalog.png',
]);

function python(args, input) {
  return new Promise((resolve,reject)=>{
    const child=spawn('python',['-B',...args],{cwd:ROOT,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    let output='',error='';
    child.stdout.on('data',c=>output+=c.toString('utf8'));
    child.stderr.on('data',c=>error+=c.toString('utf8'));
    const timer=setTimeout(()=>{child.kill();reject(Error('本地数据读取超时'));},60000);
    child.on('error',e=>{clearTimeout(timer);reject(e)});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(error.slice(-1200)||output.slice(-1200)||'Python '+code))});
  });
}

async function readMemoryRequest(req) {
  if(!/^application\/json(?:;|$)/i.test(req.headers?.['content-type']||'')||req.headers?.['x-memory-universe']!=='1')throw Error('需要从记忆宇宙页面提交');
  if(req.headers?.['sec-fetch-site']==='cross-site')throw Error('不接受跨站记忆操作');
  const chunks=[];let size=0;
  const timer=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>32768)throw Error('请求内容过长');chunks.push(Buffer.from(chunk));}}
  finally{clearTimeout(timer);}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!data||typeof data!=='object'||Array.isArray(data)||!['remember','cancel'].includes(data.action))throw Error('无效的记忆操作');
  return data;
}

function safeSegments(raw) {
  let decoded;
  try {decoded=decodeURIComponent(raw);}catch{return null;}
  if(decoded.includes('\0'))return null;
  const parts=decoded.split('/');
  if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')||p.includes(':')))return null;
  return parts;
}

function inside(parent,file) {
  return file===parent||file.startsWith(parent+path.sep);
}

export function safeProductFile(raw, products=PRODUCTS, root=ROOT, starmap=STARMAP) {
  const parts=safeSegments(raw);
  if(!parts)return null;
  const allowed=new Set([path.basename(root),starmap]);
  if(!allowed.has(parts[0]))return null;
  const file=path.resolve(products,...parts);
  if(!inside(products,file))return null;
  // The browser receives only finished HTML, frontend libraries, and the user guide.
  if(!(parts[1]==='_lib'||parts.length===2&&/^(01-.*\.html|04-使用说明\.md)$/.test(parts[1])))return null;
  if(!MIME[path.extname(file)]||path.extname(file)==='.json')return null;
  return file;
}

export function safeFile(raw) {
  return safeProductFile(raw,PRODUCTS,ROOT,STARMAP);
}

export function safeDemoFile(raw, demoRoot=DEMO_DIR) {
  const parts=safeSegments(raw);
  if(!parts)return null;
  const rel=parts.join('/');
  if(!DEMO_FILES.has(rel))return null;
  const file=path.resolve(demoRoot,...parts);
  if(!inside(demoRoot,file))return null;
  try {
    const real=realpathSync(file);
    const realRoot=realpathSync(demoRoot);
    if(!inside(realRoot,real))return null;
  } catch {return null;}
  if(!MIME[path.extname(file)]||path.extname(file)==='.json')return null;
  return file;
}

// 未接入记忆库 / 已接入但零记忆 / 已保存记忆，三态只依赖快照事实。
export function memoryStateOf(snapshot) {
  const meta=snapshot?.metadata||{};
  const memories=Number(meta?.counts?.memories)||0;
  const sources=Array.isArray(meta.memorySources)?meta.memorySources:[];
  const okSource=sources.some(s=>s&&s.status==='ok');
  if(memories>0)return 'ready';
  if(meta.memoryAvailable||okSource)return 'empty';
  return 'none';
}

function parseDemoData(text) {
  const start=text.indexOf('{'), end=text.lastIndexOf('}');
  if(start<0||end<=start)throw Error('demo data');
  const data=JSON.parse(text.slice(start,end+1));
  const nodes=Array.isArray(data.nodes)?data.nodes:[];
  const count=type=>nodes.filter(n=>n&&n.type===type).length;
  const raw=(data.metadata&&data.metadata.counts)||{};
  const pick=(key,fallback)=>Number.isFinite(raw[key])?raw[key]:fallback;
  const counts={
    conversations:pick('conversations',count('conversation')),
    memories:pick('memories',count('memory')),
    entities:pick('entities',count('entity')),
    edges:pick('edges',Array.isArray(data.edges)?data.edges.length:0),
  };
  return {data,counts};
}

export function createDemoInfo(demoRoot=DEMO_DIR) {
  let cached=null,cachedAt=0,pending=null;
  return async function demoInfo() {
    if(cached&&Date.now()-cachedAt<30000)return cached;
    if(pending)return pending;
    pending=(async()=>{
      try {
        const text=await fs.readFile(path.join(demoRoot,'_lib','network-data.js'),'utf8');
        const {data,counts}=parseDemoData(text);
        return {
          available:true,
          label:DEMO_LABEL,
          generatedAt:data.generatedAt||null,
          counts,
          products:{network:'01-记忆宇宙.html',planets:'02-记忆星图.html'},
          notice:'演示内容全部为合成示例，不读取也不影响你的记录。',
        };
      } catch {
        return {
          available:false,
          label:DEMO_LABEL,
          generatedAt:null,
          counts:null,
          products:null,
          notice:'示例演示尚未安装，你的记录不受影响。',
        };
      }
    })().finally(()=>{pending=null;});
    const value=await pending;
    cached=value;cachedAt=Date.now();
    return value;
  };
}

export function buildStatus(snapshot, demo, root, starmap) {
  const meta=snapshot.metadata||{};
  const state=memoryStateOf(snapshot);
  return {
    // 旧字段保持不变，旧客户端与旧诊断接口继续可用。
    generatedAt:snapshot.generatedAt,
    counts:meta.counts,
    profiles:snapshot.profiles||[],
    events:(snapshot.events||[]).length,
    signature:snapshot.runtimeSignature,
    memoryAvailable:meta.memoryAvailable,
    notice:meta.notice,
    products:{
      network:path.basename(root)+'/01-记忆宇宙.html',
      planets:starmap?starmap+'/01-记忆星图.html':null,
    },
    // 新增字段：三态记忆库状态与只读演示摘要。
    memoryState:state,
    demo,
  };
}

function embeddedNetworkHTML(html, file, requestURL) {
  const embedded=new URL(requestURL,'http://localhost').searchParams.get('embedded')==='1';
  if(!embedded||path.basename(file)!=='01-记忆宇宙.html')return html;
  // The DSH container already provides the title and view switcher.
  const style='<style data-memory-embedded="network">.topbar{display:none!important}.sidebar{top:0!important;padding-top:22px}#stage{top:0!important}.detail{top:12px!important}.stage-heading{top:22px}</style>';
  return html.replace('</head>',style+'</head>');
}

export function makeHandler(options={}) {
  const root=options.root||ROOT;
  const products=options.products||PRODUCTS;
  const starmap=options.starmap===undefined?STARMAP:options.starmap;
  const demoRoot=options.demoRoot||path.join(root,'_demo');
  const snapshot=options.snapshot;
  const refresh=options.refresh;
  const manageMemory=options.manageMemory;
  const getCommand=options.getCommand||(()=>({id:0,mode:'records',view:'network',sessionId:null}));
  const demoInfo=createDemoInfo(demoRoot);
  return async function handler(req,res,ctx) {
    const denied=ctx?.connection?.requestRejection?.(req);
    if(denied!==undefined&&denied!==null&&denied!==false){res.writeHead(typeof denied==='number'?denied:403);res.end();return;}
    const route=new URL(req.url,'http://localhost').pathname.slice(PREFIX.length);
    const method=req.method||'GET';
    const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(method==='HEAD'?'':body);};
    try {
      if(route==='refresh'||route==='memory/manage'){if(method!=='POST')return send(405,'{"error":"method"}');}
      else if(!['GET','HEAD'].includes(method))return send(405,'{"error":"method"}');
      if(route==='commands')return send(200,JSON.stringify(getCommand()));
      if(route==='memory/manage'){
        if(!manageMemory)return send(503,JSON.stringify({ok:false,error:'记忆管理服务尚未就绪'}));
        let body;
        try{body=await readMemoryRequest(req);}catch(e){return send(400,JSON.stringify({ok:false,error:e.message}));}
        const result=await manageMemory(body);
        return send(result.ok?200:422,JSON.stringify(result));
      }
      if(route==='status'){
        const s=await snapshot();
        const demo=await demoInfo();
        return send(200,JSON.stringify(buildStatus(s,demo,root,starmap)));
      }
      if(route==='refresh'){const s=await refresh();return send(200,JSON.stringify({ok:true,counts:s.metadata.counts}));}
      if(route==='demo/status'){
        // 只读演示摘要：不读取个人记忆库，也不触发真实快照。
        return send(200,JSON.stringify(await demoInfo()));
      }
      if(route==='live.js')return send(200,await fs.readFile(path.join(root,'_lib','dsh-live.js')),'application/javascript; charset=utf-8');
      if(route==='frame.js')return send(200,await fs.readFile(path.join(root,'_lib','dsh-frame.js')),'application/javascript; charset=utf-8');
      if(route.startsWith('demo/products/')){
        const raw=route.slice('demo/products/'.length),file=safeDemoFile(raw,demoRoot);
        if(!file)return send(404,'{"error":"demo-file"}');
        let bytes=await fs.readFile(file);
        if(path.extname(file)==='.html'){
          // 演示页只注入演示标志；绝不注入 __MEMORY_DSH__，也不加载 live.js。
          const html=embeddedNetworkHTML(bytes.toString('utf8'),file,req.url);
          bytes=Buffer.from(html.replace('</head>','<script>window.__MEMORY_DEMO__=true;</script></head>').replace('</body>','<script src="/dsh-memory/frame.js"></script></body>'));
        }
        return send(200,bytes,MIME[path.extname(file)]);
      }
      if(route.startsWith('products/')){
        const raw=route.slice(9),file=safeProductFile(raw,products,root,starmap);
        if(!file)return send(404,'{"error":"file"}');
        // Both real views share the finished local session snapshot; never serve the private index.
        if(starmap&&file===path.join(products,starmap,'_lib','data.js')){
          try {
            await fs.access(path.join(root,'_lib','content-links.json'));
            return send(200,await fs.readFile(path.join(root,'_lib','stars.js')),'application/javascript; charset=utf-8');
          } catch {} // Before the first content refresh retain the original planetary snapshot.
        }
        if(file===path.join(root,'_lib','network-data.js')){
          const s=await snapshot();
          return send(200,'window.__MEMORY_NETWORK__='+JSON.stringify(s).replaceAll('<','\\u003c')+';','application/javascript; charset=utf-8');
        }
        let bytes=await fs.readFile(file);
        if(path.extname(file)==='.html'){
          const html=embeddedNetworkHTML(bytes.toString('utf8'),file,req.url);
          bytes=Buffer.from(html.replace('</head>','<script>window.__MEMORY_DSH__=true;</script></head>').replace('</body>','<script src="/dsh-memory/live.js"></script><script src="/dsh-memory/frame.js"></script></body>'));
        }
        return send(200,bytes,MIME[path.extname(file)]);
      }
      return send(404,'{"error":"route"}');
    } catch(e){return send(500,JSON.stringify({error:String(e.message).slice(0,300)}));}
  };
}

export function apply(root) {
  const health={startedAt:new Date().toISOString(),phase:'apply'};
  const record=phase=>{health.phase=phase;writeFileSync(path.join(ROOT,'_lib','plugin-health.json'),JSON.stringify(health));};
  record('apply');
  let command={id:0,mode:'records',view:'network',sessionId:null};
  let cached=null,pending=null,cacheAt=0,refreshing=null;
  async function snapshot(force=false) {
    if(!force&&cached&&Date.now()-cacheAt<2500)return cached;
    if(pending){if(!force)return pending;await pending;}
    pending=python([path.join(ROOT,'engine','dsh_memory.py'),'snapshot']).then(out=>{cached=JSON.parse(out);cacheAt=Date.now();return cached;}).finally(()=>pending=null);
    return pending;
  }
  async function refresh() {
    if(refreshing)return refreshing;
    refreshing=python([path.join(ROOT,'engine','refresh_atlas.py')]).then(()=>snapshot(true)).finally(()=>refreshing=null);
    return refreshing;
  }
  let memoryQueue=Promise.resolve();
  function manageMemory(body){
    const task=memoryQueue.then(async()=>{
      const result=JSON.parse(await python([path.join(ROOT,'engine','manage_memory.py')],JSON.stringify(body)));
      cached=null;
      if(result.ok){const s=await snapshot(true);result.counts=s.metadata.counts;}
      return result;
    });
    memoryQueue=task.catch(()=>{});return task;
  }
  const open=(view,sessionId)=>{command={id:Math.max(Date.now(),command.id+1),mode:'records',view:view==='planets'?'planets':'network',sessionId:sessionId||null};return {opened:true,mode:command.mode,view:command.view,sessionId:command.sessionId};};
  const handler=makeHandler({snapshot,refresh,manageMemory,getCommand:()=>command});
  root.inject(['webServer','connection'],ctx=>{
    record('routes');
    const dispose=ctx.webServer.register({kind:'prefix',path:PREFIX.slice(0,-1),handler:(req,res)=>handler(req,res,ctx)});
    health.routes=true;
    ctx.effect(()=>()=>dispose());
  });
  root.inject(['tools'],ctx=>{
    record('tools-register');
    const session=exec=>exec.agent?.session?.id||'';
    ctx.tools.register({
      name:'memory_universe_open',
      description:'在 DSH 应用内部打开记忆宇宙或真实行星星图，可定位当前会话。不会打开外部浏览器、删除会话或改动记忆。',
      parameters:{type:'object',properties:{view:{type:'string',enum:['network','planets'],description:'network=记忆关联网络；planets=真实行星。'},sessionId:{type:'string',description:'可选，要定位的DSH真实会话ID；省略时使用当前会话。'}},additionalProperties:false},
      async execute(args,exec){
        if(args.view!==undefined&&!['network','planets'].includes(args.view))throw Error('view must be network or planets');
        if(args.sessionId!==undefined&&(typeof args.sessionId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(args.sessionId)))throw Error('invalid sessionId');
        return open(args.view,args.sessionId||session(exec));
      },
      output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
      presentCall:()=>({card:'generic',title:'在 DSH 中打开记忆宇宙',kind:'other'})
    });
    ctx.tools.register({
      name:'memory_universe_memory',
      description:'调用本机已有类人脑记忆引擎。remember保存用户明确提供的个人事实或偏好，recall按话题召回并记录真实事件。按profile隔离聊天对象，来源会话自动记录。不会删除DSH会话。',
      parameters:{type:'object',properties:{action:{type:'string',enum:['remember','recall']},text:{type:'string',description:'用户原话或当前检索话题。不要编造用户事实。'},profile:{type:'string',description:'同一聊天对象的稳定身份。DSH本人默认default；外部聊天应使用platform:userId等稳定标识。'}},required:['action','text'],additionalProperties:false},
      async execute(args,exec){
        if(!['remember','recall'].includes(args.action))throw Error('action must be remember or recall');
        if(typeof args.text!=='string'||!args.text.trim())throw Error('text is required');
        if(args.profile!==undefined&&(typeof args.profile!=='string'||!args.profile.trim()))throw Error('profile must be a nonempty string');
        const result=JSON.parse(await python([path.join(ROOT,'engine','dsh_memory.py'),args.action,'--text',args.text,'--profile',args.profile||'default','--session',session(exec)]));
        cached=null;return result;
      },
      output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
      presentCall:args=>({card:'generic',title:args.action==='remember'?'保存一条真实记忆':'召回相关记忆',kind:'other'})
    });
    health.tools=['memory_universe_open','memory_universe_memory'].filter(n=>ctx.tools.get(n));
    record('ready');
  });
}
