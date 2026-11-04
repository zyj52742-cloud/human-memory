/* 本地图鉴：图为用户选定的天体外观示意。 */
(function(){
  'use strict';
  if(document.getElementById('bodyGuide'))return;
  var script=document.currentScript,base=new URL('.',script.src);
  var host=document.querySelector('.scene-tools')||document.querySelector('.actions');
  if(!host)return;
  var style=document.createElement('style');
  style.textContent='#bodyGuide{width:min(1540px,94vw);max-width:94vw;max-height:94vh;inset:0;margin:auto;padding:0;border:1px solid #65563d;border-radius:12px;background:#080a10;color:#e2d6bf;box-shadow:0 30px 120px #000b;font-family:"Microsoft YaHei",sans-serif}#bodyGuide::backdrop{background:#000b;backdrop-filter:blur(5px)}#bodyGuide .guide-head{display:flex;gap:12px;align-items:center;padding:14px 18px;border-bottom:1px solid #332e27}#bodyGuide .guide-head strong{font-size:15px;font-weight:400;letter-spacing:.15em}#bodyGuide .guide-head span{font-size:11px;color:#a49b8a}#bodyGuide .guide-close{margin-left:auto;background:#181a21;color:#d6c7aa;border:1px solid #625743;border-radius:6px;padding:6px 13px;cursor:pointer}#bodyGuide img{display:block;max-height:calc(94vh - 70px);width:100%;object-fit:contain}#bodyGuideButton{white-space:nowrap}.scene-tools{flex-wrap:wrap}';
  document.head.appendChild(style);
  var d=document.createElement('dialog');d.id='bodyGuide';d.setAttribute('aria-label','天体外观图鉴');
  var head=document.createElement('div');head.className='guide-head';
  var title=document.createElement('strong');title.textContent='天体图鉴';head.appendChild(title);
  var help=document.createElement('span');help.textContent='八类可选外观 · 可在行星星卡中切换';head.appendChild(help);
  var close=document.createElement('button');close.className='guide-close';close.type='button';close.textContent='关闭 ×';close.onclick=function(){d.close();};head.appendChild(close);d.appendChild(head);
  var img=document.createElement('img');img.src=new URL('body-catalog.png',base).href;img.alt='经典行星、带环行星、冰封星球、熔岩星球、海洋星球、恒星、小行星和彗星的外观图鉴';d.appendChild(img);document.body.appendChild(d);
  d.addEventListener('keydown',function(e){e.stopPropagation();});
  d.addEventListener('click',function(e){if(e.target===d){var r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
  var b=document.createElement('button');b.id='bodyGuideButton';b.type='button';b.className=host.classList.contains('actions')?'iconbtn':'';b.textContent='天体图鉴';b.title='打开八类天体外观参考图';b.onclick=function(){d.showModal();};host.appendChild(b);
})();
