(() => {
  const options = __LABEL_EXTRACT_OPTIONS__;
  const out = { rows: [], period: '', auth: 'unknown' };
  const clean = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (location.protocol !== 'https:' || !options.hosts.includes(location.hostname)) return JSON.stringify(out);
  const controls = Array.from(document.querySelectorAll('button,a,[role="button"],.login')).filter(visible);
  if (controls.some(el => /^(退出登录|退出账号|登出)$/.test(clean(el)))) out.auth = 'signed_in';
  else if (controls.some(el => /^(登录|登 录|立即登录|登录\/注册)$/.test(clean(el))) || Array.from(document.querySelectorAll('input')).some(el => visible(el) && /密码|验证码|手机号/.test(el.getAttribute('placeholder') || el.getAttribute('type') || ''))) out.auth = 'signed_out';
  if (Array.from(document.querySelectorAll('h1,h2,[role="dialog"]')).some(el => visible(el) && /安全验证|访问异常|完成验证/.test(clean(el).slice(0,120)))) out.auth = 'challenge';
  const add = (term, metric, kind, rank, metricLabel) => {
    if (term && term.length <= 400 && !out.rows.some(row => row.kind === kind && row.term === term)) out.rows.push({term, metric, kind, rank, metricLabel});
  };
  if (options.id === 'bilibili' && location.hostname === 'trends.bilibili.com' && /^\/content\/?$/.test(location.pathname)) {
    for (const table of document.querySelectorAll('.ivu-table')) {
      let parent = table, kind = '';
      for (let i=0; i<5 && parent; i++, parent=parent.parentElement) {
        kind = clean(parent.querySelector('h3'));
        if (['热门关键词','飙升关键词'].includes(kind)) break;
      }
      if (!['热门关键词','飙升关键词'].includes(kind)) continue;
      Array.from(table.querySelectorAll('.ivu-table-body tbody tr')).filter(visible).slice(0,100).forEach((row,i) => {
        const cells = row.querySelectorAll('td');
        if (cells.length === 3) add(clean(cells[1]), clean(cells[2]), kind, Number(clean(cells[0])) || i+1, '内容指数');
      });
    }
    const link = Array.from(document.querySelectorAll('a[href*="/content/full?"]')).find(visible);
    if (link) {
      const params = new URL(link.href).searchParams, date = Number(params.get('date'));
      const cycle = {date:'日榜',week:'周榜',month:'月榜',year:'年榜'}[params.get('dateType')];
      if (cycle && date > 0 && date < 1e11) out.period = new Date(date*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})+' · '+cycle;
    }
  }
  if (options.id === 'douyin' && location.hostname === 'creator.douyin.com' && /^\/creator-micro\/creator-count\/arithmetic-index\/?$/.test(location.pathname)) {
    for (const kind of ['抖音实时热点','抖音飙升热点']) {
      let heading = Array.from(document.querySelectorAll('div,span,h2,h3')).find(el => visible(el) && clean(el) === kind);
      let group = heading;
      for (let i=0; i<5 && group && !group.querySelector('.byted-table-row'); i++) group=group.parentElement;
      if (!group || !group.querySelector('.byted-table-row') || ['抖音实时热点','抖音飙升热点'].every(text=>clean(group).includes(text))) continue;
      Array.from(group.querySelectorAll('.byted-table-row')).filter(visible).slice(0,100).forEach((row,i)=>{
        const link = row.querySelector('a[href*="arithmetic-index/hot?"]'), cells = row.querySelectorAll('.byted-table-cell-body');
        if (link && cells.length===4) add(clean(link),clean(cells[2]),kind,Number(clean(cells[0]))||i+1,'热点指数');
      });
    }
    if (out.rows.length) out.period = '平台当前榜单 · 各榜首页';
  }
  if (options.id === 'zhihu' && location.hostname === 'www.zhihu.com' && location.pathname === '/organization/search-question/init') {
    const main=document.querySelector('main');
    if (main) for (const kind of ['知乎热题','全网热点']) {
      const heading=Array.from(main.querySelectorAll('div')).find(el=>visible(el) && clean(el)===kind);
      const group=heading?.parentElement;
      if (!group) continue;
      for (const row of Array.from(group.children).filter(el=>el!==heading && visible(el)).slice(0,100)) {
        const cells=row.children;
        if (cells.length===2 && /^\d{1,2}$/.test(clean(cells[0]))) add(clean(cells[1]),'',kind,Number(clean(cells[0])),'');
      }
    }
    if (out.rows.length) out.period='平台当前选题榜';
  }
  return JSON.stringify(out);
})()
