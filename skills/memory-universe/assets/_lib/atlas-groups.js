/* 记忆宇宙：确定性的分组与布局规划。
 * 纯数据函数，不依赖 Three.js 或 DOM，可单独用 Node 复算。
 * 只使用节点已有的 project / created / kind 字段，不生成主题或虚构记忆。 */
(function (root) {
 'use strict';

 var DEFAULTS = {
  halfMax: 24,      // 单组超过这个数量，就把该批对话改用自然周分组
  weekMax: 34,      // 单周仍超过这个数量，就把该周按自然日拆开
  radiusBase: 20,
  radiusScale: 11,
  radiusCap: 110,
  colsMax: 7
 };

 function hash(s) {
  var h = 2166136261;
  s = String(s);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
 }
 function rand(s, k) { return (hash(s + '|' + k) % 1000000) / 1000000; }

 function numericDate(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  var n = Date.parse(v);
  return Number.isFinite(n) ? n : Date.now();
 }
 function dayStart(ms) {
  var d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
 }
 function weekStart(ms) {
  var d = new Date(ms);
  var offset = (d.getDay() + 6) % 7; // 周一为一周开始
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
 }
 function halfStart(ms) {
  var d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() < 16 ? 1 : 16).getTime();
 }
 function projectOf(n) { return n.project || '未记录项目'; }
 function cmpId(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }

 function formatDate(ms, withYear) {
  var d = new Date(ms);
  return (withYear ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日';
 }
 function formatRange(start, end, withYear) {
  var a = new Date(start), b = new Date(end);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) {
   return formatDate(start, withYear);
  }
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
   return (withYear ? a.getFullYear() + '年' : '') + (a.getMonth() + 1) + '月' + a.getDate() + '–' + b.getDate() + '日';
  }
  return formatDate(start, withYear) + '–' + formatDate(end, withYear);
 }

 function sortNodes(list) {
  return list.slice().sort(function (a, b) { return numericDate(a.created) - numericDate(b.created) || cmpId(a.id, b.id); });
 }
 function makeGroup(level, project, list, idSuffix) {
  var nodes = sortNodes(list);
  var start = Infinity, end = -Infinity;
  nodes.forEach(function (n) { var t = numericDate(n.created); if (t < start) start = t; if (t > end) end = t; });
  return {
   id: 'conversation|' + project + '|' + level + '|' + idSuffix,
   kind: 'conversation',
   level: level,
   project: project,
   nodes: nodes,
   count: nodes.length,
   start: start,
   end: end
  };
 }

 function conversationGroups(nodes, opts) {
  var conv = nodes.filter(function (n) { return n.type === 'conversation'; });
  var groupOf = new Map();
  if (!conv.length) return { groups: [], groupOf: groupOf, level: 'none', halfMax: 0 };

  var sorted = sortNodes(conv);
  var totals = new Map();
  sorted.forEach(function (n) { var p = projectOf(n); totals.set(p, (totals.get(p) || 0) + 1); });
  var projectOrder = Array.from(totals.keys()).sort(function (a, b) {
   return totals.get(b) - totals.get(a) || (a < b ? -1 : a > b ? 1 : 0);
  });

  var half = new Map();
  sorted.forEach(function (n) {
   var p = projectOf(n), k = p + '|' + halfStart(numericDate(n.created));
   if (!half.has(k)) half.set(k, []);
   half.get(k).push(n);
  });
  var halfMax = 0;
  half.forEach(function (list) { if (list.length > halfMax) halfMax = list.length; });

  var buckets = []; // {level, project, list}
  if (halfMax > opts.halfMax) {
   var weeks = new Map();
   sorted.forEach(function (n) {
    var p = projectOf(n), k = p + '|' + weekStart(numericDate(n.created));
    if (!weeks.has(k)) weeks.set(k, []);
    weeks.get(k).push(n);
   });
   weeks.forEach(function (list, key) {
    var project = key.slice(0, key.lastIndexOf('|'));
    if (list.length > opts.weekMax) {
     var days = new Map();
     list.forEach(function (n) {
      var d = dayStart(numericDate(n.created));
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(n);
     });
     days.forEach(function (dayList, day) {
      buckets.push({ level: 'day', project: project, list: dayList, day: day });
     });
    } else {
     buckets.push({ level: 'week', project: project, list: list, day: weekStart(numericDate(list[0].created)) });
    }
   });
  } else {
   half.forEach(function (list, key) {
    var project = key.slice(0, key.lastIndexOf('|'));
    buckets.push({ level: 'half', project: project, list: list, day: halfStart(numericDate(list[0].created)) });
   });
  }

  var years = new Set(sorted.map(function (n) { return new Date(numericDate(n.created)).getFullYear(); }));
  var withYear = years.size > 1;
  var groups = buckets.map(function (b) {
   var g = makeGroup(b.level, b.project, b.list, String(b.day));
   g.label = b.project + ' · ' + formatRange(g.start, g.end, withYear);
   g.rangeText = formatDate(g.start, withYear) + ' – ' + formatDate(g.end, withYear);
   return g;
  });

  var projectIndex = new Map();
  projectOrder.forEach(function (p, i) { projectIndex.set(p, i); });
  groups.sort(function (a, b) {
   return (projectIndex.get(a.project) - projectIndex.get(b.project)) || (a.start - b.start) || cmpId(a.id, b.id);
  });
  groups.forEach(function (g) { g.nodes.forEach(function (n) { groupOf.set(n.id, g.id); }); });
  return { groups: groups, groupOf: groupOf, level: halfMax > opts.halfMax ? 'week' : 'half', halfMax: halfMax };
 }

 function memoryAndEntityGroups(nodes, opts, groupOf) {
  var groups = [];
  var memory = nodes.filter(function (n) { return n.type === 'memory'; });
  if (memory.length) {
   var byKind = new Map();
   memory.forEach(function (n) {
    var k = n.kind || 'fact';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(n);
   });
   var kinds = opts.kinds || {};
   var kindGroups = Array.from(byKind.entries()).map(function (entry) {
    var kind = entry[0], list = sortNodes(entry[1]);
    var start = Infinity, end = -Infinity;
    list.forEach(function (n) { var t = numericDate(n.created); if (t < start) start = t; if (t > end) end = t; });
    return {
     id: 'memory|' + kind,
     kind: 'memory',
     memoryKind: kind,
     label: kinds[kind] || kind,
     nodes: list,
     count: list.length,
     start: start,
     end: end
    };
   });
   kindGroups.sort(function (a, b) { return cmpId(a.label, b.label); });
   kindGroups.forEach(function (g) { groups.push(g); });
  }
  var entities = nodes.filter(function (n) { return n.type === 'entity'; });
  if (entities.length) {
   var list = sortNodes(entities);
   var start = Infinity, end = -Infinity;
   list.forEach(function (n) { var t = numericDate(n.created); if (t < start) start = t; if (t > end) end = t; });
   groups.push({
    id: 'entity|all',
    kind: 'entity',
    label: opts.entityLabel || '实体与人物',
    nodes: list,
    count: list.length,
    start: start,
    end: end
   });
  }
  groups.forEach(function (g) { g.nodes.forEach(function (n) { groupOf.set(n.id, g.id); }); });
  return groups;
 }

 function contentGroups(nodes) {
  var conv = nodes.filter(function(n){return n.type === 'conversation';});
  var byId = new Map(conv.map(function(n){return [n.id,n];}));
  var buckets = new Map(), unknown = [];
  conv.forEach(function(n){
   var facts = n.contentAssociation;
   if(!facts?.topic && n.sub && n.parent)facts=byId.get('conv:'+n.parent)?.contentAssociation;
   if(!facts?.topic){unknown.push(n);return;}
   if(!buckets.has(facts.topicId))buckets.set(facts.topicId,{topic:facts.topic,list:[]});
   buckets.get(facts.topicId).list.push(n);
  });
  var groups = Array.from(buckets.entries()).map(function(entry){
   var g=makeGroup('content','',entry[1].list,entry[0]);
   g.label=g.topic=entry[1].topic;g.rangeText=formatRange(g.start,g.end,true);return g;
  });
  groups.sort(function(a,b){return b.count-a.count||cmpId(a.label,b.label);});
  // These batches express missing information, not an inferred common subject.
  var rest=sortNodes(unknown);
  for(var i=0;i<rest.length;i+=24){var g=makeGroup('unlinked','',rest.slice(i,i+24),String(i));g.label=g.topic='暂未关联'+(rest.length>24?' · '+(i/24+1):'');g.rangeText='信息不足或未找到可靠的共同话题；不代表这些对话有内容联系。';groups.push(g);}
  return {groups:groups,level:'content',halfMax:0};
 }

 function plan(nodes, options) {
  var opts = Object.assign({}, DEFAULTS, options || {});
  var groupOf = new Map();
  var conv = opts.content ? contentGroups(nodes) : conversationGroups(nodes, opts);
  conv.groups.forEach(function (g) { g.nodes.forEach(function (n) { groupOf.set(n.id, g.id); }); });
  var others = memoryAndEntityGroups(nodes, opts, groupOf);
  var groups = conv.groups.concat(others);
  return {
   groups: groups,
   groupOf: groupOf,
   level: conv.level,
   halfMax: conv.halfMax,
   denseGroups: groups.filter(function (g) { return g.kind === 'conversation' && g.level !== 'half'; }).length
  };
 }

 function layout(groups, options) {
  var opts = Object.assign({}, DEFAULTS, options || {});
  var positions = new Map();
  if (!groups.length) {
   return { positions: positions, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, cell: { x: 0, y: 0 }, cols: 0, rows: 0, maxRadius: 0 };
  }
  groups.forEach(function (g) {
   g.radius = Math.min(opts.radiusCap, opts.radiusBase + Math.sqrt(Math.max(1, g.count)) * opts.radiusScale);
  });
  var maxRadius = groups.reduce(function (m, g) { return Math.max(m, g.radius); }, 0);
  var cellX = maxRadius * 2 + 74;
  var cellY = maxRadius * 2 + 96;
  var cols = Math.max(1, Math.min(opts.colsMax, Math.round(Math.sqrt(groups.length * 1.55))));
  var rows = Math.ceil(groups.length / cols);

  groups.forEach(function (g, i) {
   var row = Math.floor(i / cols);
   var colInRow = i % cols;
   var col = row % 2 ? cols - 1 - colInRow : colInRow;
   var x = (col - (cols - 1) / 2) * cellX;
   var y = ((rows - 1) / 2 - row) * cellY + Math.sin(x / Math.max(1, cellX * 2)) * 18;
   var z = ((hash(g.id) % 1000) / 1000 - 0.5) * 110;
   g.center = { x: x, y: y, z: z };
   g.col = col; g.row = row;

   var list = sortNodes(g.nodes);
   var phase = (hash(g.id) % 628) / 100;
   list.forEach(function (n, j) {
    var px = x, py = y;
    if (list.length > 1) {
     var r = g.radius * Math.sqrt((j + 0.5) / list.length);
     var a = j * 2.39996322972865 + phase;
     px = x + Math.cos(a) * r;
     py = y + Math.sin(a) * r * 0.88;
    }
    var pz = z + (rand(n.id, 'z') - 0.5) * Math.min(95, 26 + g.radius * 0.75);
    positions.set(n.id, { x: px, y: py, z: pz });
   });
  });

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  groups.forEach(function (g) {
   minX = Math.min(minX, g.center.x - g.radius); maxX = Math.max(maxX, g.center.x + g.radius);
   minY = Math.min(minY, g.center.y - g.radius); maxY = Math.max(maxY, g.center.y + g.radius);
  });
  return {
   positions: positions,
   bounds: { minX: minX, maxX: maxX, minY: minY, maxY: maxY },
   cell: { x: cellX, y: cellY },
   cols: cols,
   rows: rows,
   maxRadius: maxRadius
  };
 }

 var api = { plan: plan, layout: layout, formatRange: formatRange, DEFAULTS: DEFAULTS };
 if (typeof module !== 'undefined' && module.exports) module.exports = api;
 root.AtlasGroups = api;
})(typeof window !== 'undefined' ? window : globalThis);
