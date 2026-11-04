/* Offline, grounded text associations. No model, network, or memory writes. */
'use strict';
const crypto = require('node:crypto');
const segmenter = new Intl.Segmenter('zh-CN', {granularity:'word'});
const VERSION = 'local-text-v1';
const STOP = new Set(('我 你 他 她 它 我们 你们 他们 自己 这个 那个 这些 那些 什么 怎么 为什么 如何 是否 可以 能够 需要 应该 已经 现在 今天 昨天 继续 开始 最后 目前 一个 一下 一些 这样 那样 还有 就是 不是 因为 所以 然后 但是 如果 没有 不要 不用 不会 不是 真的 感觉 知道 看到 看看 告诉 觉得 直接 帮忙 帮我 帮你 帮用户 用户 请问 请你 麻烦 好的 你好 谢谢 问题 事情 东西 内容 信息 数据 时间 日期 工作 项目 目录 文件 文件夹 路径 绝对路径 输入 输出 修改 改动 只读 允许 禁止 范围 规则 约束 授权 任务 任务单 派单 执行 执行方 验收 候选 回报 格式 说明 要求 结果 功能 实现 使用 工具 工程 版本 测试 检查 完成 通过 支持 记录 读取 写入 列举 调用 回复 解释 确认 分析 建议 方案 代码 程序 软件 系统 页面 本地 全局 公开 默认 相关 关系 问题 成功 失败 解决 优化 修复 设置 配置 安装 联网 下载 接口 脚本 保存 报告 原始 总设计 验收方 桥接工具 负责 明确 长期 常规 本轮 本次 用户已 用户原话 不需要 不允许 不修改 不删除 不调用 不读取 不写入 与此 这里 那里 真的 一直 只能 不能 怎么样 当中 里面 之间 所有 任何 这次 后续 不变 小时 分钟 数字 the this that with from have will your into only user assistant system instructions true false null undefined const return function window users lenovo desktop source session sessions json text content read write update data files path python node js md jsonl utf type name title 请 不 是 的 了 吗 呢 吧 啊 嗯 好 行 等').split(/\s+/));
// Common equivalents are normalized explicitly; an exact matching quote is kept.
const ALIASES = [
 ['记忆宇宙',['记忆宇宙','human-memory','human memory']],
 ['记忆星图',['记忆星图','行星星图']],
 ['随手记·记账',['随手记','记账','记帐','账单','记账小程序']],
 ['AI写真',['ai写真','ai 写真','写真']],
 ['八字命理',['八字','四柱','排盘','命理']],
 ['DSH桥接',['dsh-bridge','codex-dsh','dsh 桥接','dsh桥接','桥接插件']],
 ['思考强度',['思考强度','推理强度','reasoning_effort','reasoning effort']],
 ['三角洲行动',['三角洲行动']],
 ['GitHub',['github','git hub']],
 ['PowerPoint',['powerpoint','ppt','幻灯片']],
 ['语音合成',['语音合成','声音克隆','声音复刻','index-tts','fish.audio']],
 ['磁盘清理',['磁盘清理','磁盘空间','清理c盘','清理 c 盘']],
 ['历史会话恢复',['历史会话恢复','聊天记录恢复','恢复聊天','恢复记录']],
];
const PLATFORMS=new Set(['codex','dsh','deepseek','chatgpt','workbuddy','openai','claude','ai','gpt']);
for(const word of ('未命名 命名 对话 询问 含义 用途 意义 导致 当前 收到 避免 大规模 一次 严格 中文 一位 另外 想要 哪个 哪里 干什么 意思 理解 观察 效果 官方 电脑 删除 删掉 更新 整理 产物 选择 思考 以后 出来 左右 上面 下面 几个 进行 来自 其实 可能 具体 这是什么 这是什么意思 是什么 总结 人物 我不理解 我的意思 你在 你是 你是一位 你是一次 实际 可行性 技能 警告 反馈 实现能力 开发能力 普通 响应 上下文 正常 不正常 只允许 作为 必须 学生 任务描述 本任务 模型调用 现在默认').split(/\s+/))STOP.add(word);
for(const word of ('交接 标识 放进 各自 以下 文字 核对 一件事 试着 步骤 咨询 能否 查看 类似 包括 以内 结论 回答 答复 注意 硬约束 多余 提示 不解释 原话 概括 以后 尽量 同时 告诉我 想知道 带来 只说 不足 中的 请先 执行前 不确定 可靠性 占用 运行 真实 可用 速度 快慢 最小 最小模型 连通 执行端 中文环境').split(/\s+/))STOP.add(word);
for(const word of ('拿到 一张 接手 干活 之前 发生 重新 全面 评审 能力 交流 从而 交给 替换 预览 清单 阅读 访问 基于 观察 观点 补充 重复 写入范围 交付 回传 生产 验证 人工 亲自').split(/\s+/))STOP.add(word);
for(const word of ('或者 或者是 做的 的是 确实 不知道 不想 不错 汇报 调动 打开 情况 再次 是不是 而且 不通 使用说明 原因 当时').split(/\s+/))STOP.add(word);
ALIASES.push(
 ['图像生成',['图像生成','生成图片','图片生成','imagegen','图片编辑']],
 ['视频制作',['视频制作','生成视频','制作视频','剪映','视频剪辑']],
 ['语音提取',['语音提取','提取语音','提取声音','角色语音']],
 ['自传写作',['自传','回忆录']],
 ['国产芯片与软件',['国产芯片','国产化适配','国产基础软件']],
 ['实验报告',['实验报告']],
 ['海岛奇兵',['海岛奇兵']],
 ['WorkBuddy',['work buddy','workbuddy']],
 ['Kimi Code',['kimi code','kimi-code']],
 ['前端开发',['前端开发','前端网页','前端能力']],
);
const id = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,16);
const normalize = s => String(s||'').normalize('NFKC').toLowerCase();
function clean(s) {
 return String(s||'').replace(/<(system-reminder|environment_context|instructions|INSTRUCTIONS|app-context)[^>]*>[\s\S]*?<\/\1>/gi,' ')
  .replace(/```[\s\S]*?```/g,' ').replace(/[A-Za-z]:[\\/][^\s<>"'，；）]+/g,' ')
  .replace(/https?:\/\/\S+/g,' ').replace(/\b[a-f0-9]{8}-[a-f0-9-]{20,}\b/gi,' ')
  .replace(/来自\s*Codex[（(][^）)]*[）)]的任务单[。\s]*你是执行方[：:][^\n。]*[。]?/g,' ')
  .replace(/\s+/g,' ').trim();
}
function valid(s) {
 if(STOP.has(s)||/^\d/.test(s)||PLATFORMS.has(s))return false;
 if(/^[我你他她它这那哪]|(?:什么|怎么|是否|可以|已经|不理解|我的意思)/u.test(s))return false;
 if(/^[a-z][a-z0-9_.+-]{2,28}$/i.test(s))return true;
 return /^[\p{Script=Han}]{2,10}$/u.test(s);
}
function analyze(records) {
 const docs = records.slice().sort((a,b)=>a.id.localeCompare(b.id)).map(rec=>{
  const features=new Map(), pieces=(rec.messages||[]).length?[{text:rec.title||'',kind:'title',turn:0},...(rec.messages||[]).map(m=>({text:m.text,kind:'user',turn:m.turn,event:m.event}))]:[];
  const add=(key,label,piece,weight,alias=false)=>{
   if(!alias&&!valid(label))return;
   if(!features.has(key))features.set(key,{key,label,weight:0,title:false,alias,quotes:[]});
   const f=features.get(key);f.weight=Math.max(f.weight,weight);f.title ||= piece.kind==='title';
   // Quote text comes from the original, redacted title/user message, not a generated summary.
   if(f.quotes.length<3&&!f.quotes.some(q=>q.kind===piece.kind&&q.turn===piece.turn)){
    const raw=String(piece.text);const needle=normalize(label);let p=normalize(raw).indexOf(needle);
    if(p<0 && alias){const forms=ALIASES.find(a=>a[0]===label)?.[1]||[];for(const form of forms){p=normalize(raw).indexOf(form);if(p>=0)break;}}
    if(p>=0)f.quotes.push({kind:piece.kind,turn:piece.turn,event:piece.event,text:raw.slice(Math.max(0,p-48),Math.min(raw.length,p+100))});
   }
  };
  for(const piece of pieces){
   const text=normalize(clean(piece.text)),weight=piece.kind==='title'?4:1;
   for(const [label,forms] of ALIASES){if(forms.some(form=>/^[a-z]+$/.test(form)?new RegExp('(?<![a-z])'+form+'(?![a-z])','i').test(text):text.includes(form)))add('alias:'+label,label,piece,weight*1.5,true);}
   const words=[...segmenter.segment(text)].filter(s=>s.isWordLike);
   for(let i=0;i<words.length;i++){
    const s=words[i].segment;if(!valid(s))continue;add(s,s,piece,weight);
    // Mine short contiguous noun-like compounds without joining across punctuation/stop words.
    let phrase=s,end=words[i].index+s.length;
    for(let j=i+1;j<=Math.min(i+2,words.length-1);j++){
     const next=words[j];if(next.index!==end||!valid(next.segment)||!/[\p{Script=Han}]/u.test(next.segment))break;
     phrase+=next.segment;end=next.index+next.segment.length;if(phrase.length>10)break;
     add(phrase,phrase,piece,weight*1.12);
    }
   }
  }
  return {...rec,features};
 });
 const df=new Map();for(const d of docs)for(const key of d.features.keys())df.set(key,(df.get(key)||0)+1);
 const n=docs.length;
 for(const d of docs){
  for(const [key,f] of d.features){
   const freq=df.get(key);if(freq<2||(!f.alias&&freq>Math.max(5,n*.35))||!f.quotes.length){d.features.delete(key);continue;}
   f.weight*=Math.log(1+n/(1+freq));
   if(!f.alias&&f.label.length<=2)f.weight*=.72;
  }
  // Cap long conversations so shared boilerplate does not dominate vector similarity.
  const ranked=[...d.features.values()].sort((a,b)=>b.weight-a.weight||a.key.localeCompare(b.key)).slice(0,70);
  d.features=new Map(ranked.map(f=>[f.key,f]));d.norm=Math.sqrt(ranked.reduce((sum,f)=>sum+f.weight*f.weight,0))||1;
 }
 const candidates=[];
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
  const a=docs[i],b=docs[j],shared=[];let dot=0;
  for(const [key,f] of a.features){const g=b.features.get(key);if(g){dot+=f.weight*g.weight;shared.push({f,g,rank:Math.sqrt(f.weight*g.weight)*(f.alias?1.35:1)*(f.title&&g.title?1.4:1)});}}
  shared.sort((x,y)=>Number(y.f.alias)-Number(x.f.alias)||Number(y.f.title&&y.g.title)-Number(x.f.title&&x.g.title)||y.rank-x.rank||x.f.key.localeCompare(y.f.key));
  const terms=[];
  for(const item of shared){if(terms.some(x=>normalize(x.f.label).includes(normalize(item.f.label))))continue;
   // One strong phrase/name, or two different specific words, is required.
   if(item.f.alias||item.f.title||item.g.title||df.get(item.f.key)<=Math.max(3,n*.12))terms.push(item);
   if(terms.length===4)break;
  }
  const strong=terms.some(x=>x.f.alias||(x.f.title&&x.g.title&&x.f.label.length>=4));
  let score=dot/(a.norm*b.norm);
  const sharedTitle=terms.filter(x=>x.f.title&&x.g.title);
  if(strong&&sharedTitle.length)score=Math.max(score,.36+Math.min(.26,sharedTitle.length*.06));
  if(!terms.length||(!strong&&terms.length<2)||score<.2)continue;
  if(!strong&&!terms.some(x=>x.f.title&&x.g.title)&&score<.4)continue;
  // Shared short generic words alone cannot create an edge.
  if(!strong&&terms.every(x=>x.f.label.length<=2)&&score<.34)continue;
  const best=terms[0];
  const quote=f=>f.quotes.find(q=>q.kind==='user')||f.quotes[0];
  candidates.push({id:'content:'+id(a.id+'|'+b.id),source:a.id,target:b.id,type:'content',inferred:true,
   score:+Math.min(.99,score).toFixed(3),basis:'共同话题：'+terms.map(t=>t.f.label).join('、'),
   terms:terms.map(t=>t.f.label),evidence:[{nodeId:a.id,...quote(best.f)},{nodeId:b.id,...quote(best.g)}],method:VERSION,
   _a:a,_b:b,_term:best.f.key});
 }
 candidates.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 const degree=new Map(),edges=[];
 for(const e of candidates){if((degree.get(e.source)||0)>=4||(degree.get(e.target)||0)>=4)continue;
  edges.push(e);for(const nodeId of [e.source,e.target])degree.set(nodeId,(degree.get(nodeId)||0)+1);
 }
 const memberships={};
 for(const d of docs){
  const incident=edges.filter(e=>e.source===d.id||e.target===d.id);const scores=new Map();
  for(const e of incident)for(const label of e.terms){const f=[...d.features.values()].find(x=>x.label===label);if(!f)continue;
   scores.set(label,(scores.get(label)||0)+e.score*(f.alias?4:1)*(f.title?3:1)*Math.min(3,Math.log2(label.length+1)));
  }
  const ranked=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const topic=ranked[0]?.[0]||null;
  memberships[d.id]={topic,topicId:topic?'topic:'+id(topic):null,terms:ranked.slice(0,6).map(x=>x[0]),links:incident.length,
   indexedUserMessages:d.userMessages||0,sampledUserMessages:d.messages?.length||0};
 }
 for(const e of edges){delete e._a;delete e._b;delete e._term;}
 return {version:VERSION,generatedAt:new Date().toISOString(),memberships,edges,metadata:{method:'本机分词、常见同义词与词频加权；自动推测，非已确认事实',conversations:n,links:edges.length,maxLinksPerConversation:4,usesModel:false,usesNetwork:false}};
}
module.exports={analyze,clean,VERSION};
if(require.main===module){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{try{process.stdout.write(JSON.stringify(analyze(JSON.parse(input))));}catch(e){process.stderr.write(e.stack);process.exitCode=1;}});}
