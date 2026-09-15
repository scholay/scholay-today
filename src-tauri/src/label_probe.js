// Fixed, narrowly scoped DOM adapter. No network, cookie/storage access, form
// values, account names, full-page text, or AI. Options come from validated IPC.
((options) => {
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const result = { auth: 'unknown', rows: [], period: '', clicked: false };
  if (location.protocol !== 'https:' || !options.hosts.includes(location.hostname)) return JSON.stringify(result);
  const controls = [...document.querySelectorAll('button,a,[role="button"],.login')].filter(visible);
  const login = controls.find(el => /^(登录|立即登录|登录\/注册|登录注册|登录账号|登 录)$/.test(text(el)));
  const logout = controls.find(el => /^(退出登录|退出账号|登出)$/.test(text(el)));
  const headings = [...document.querySelectorAll('h1,h2,h3,[role="dialog"]')].filter(visible);
  const challenge = headings.some(el => /^(安全验证|请完成验证|请完成安全验证)/.test(text(el)));
  const loginForm = [...document.querySelectorAll('input')].some(el => visible(el) && (el.type === 'password' || /手机号|验证码|密码|手机号码|邮箱地址|登录账号/.test(el.getAttribute('placeholder') || '')));
  // Unknown stays unknown. Data availability alone never proves authentication.
  result.auth = challenge ? 'challenge' : logout ? 'signed_in' : login || loginForm ? 'signed_out' : 'unknown';
  if (options.action === 'login') {
    // An opener is not a form submission. Never fill/submit login forms,
    // request an SMS, accept agreements, or select extra OAuth scopes here.
    if (login && !loginForm && !login.closest('form') && login.getAttribute('type') !== 'submit') { login.click(); result.clicked = true; }
    return JSON.stringify(result);
  }
  if (options.id !== 'bilibili' || location.hostname !== 'trends.bilibili.com' || !/^\/content\/?$/.test(location.pathname)) return JSON.stringify(result);
  const full = [...document.querySelectorAll('a[href]')].find(el => visible(el) && el.getAttribute('href')?.startsWith('/content/full?'));
  if (full) {
    const params = new URL(full.href).searchParams;
    const epoch = Number(params.get('date'));
    const cycle = {date:'日榜', week:'周榜', month:'月榜', year:'年榜'}[params.get('dateType')];
    if (cycle && epoch > 1e9 && epoch < 1e10) result.period = cycle + ' · ' + new Date(epoch * 1000).toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai'});
  }
  for (const table of [...document.querySelectorAll('.ivu-table')].filter(visible).slice(0, 4)) {
    let parent = table.parentElement, kind = '';
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      const title = text(parent.querySelector('h3'));
      if (title === '热门关键词' || title === '飙升关键词') { kind = title; break; }
    }
    if (!kind) continue;
    const rows = [...table.querySelectorAll('.ivu-table-body tbody tr')].filter(visible).slice(0, 100);
    rows.forEach((row, i) => {
      const cells = row.querySelectorAll('td');
      if (cells.length !== 3) return;
      const term = text(cells[1]), metric = text(cells[2]);
      if (!term || term.length > 100 || !/^[\d,.]+\s*[万亿WwKkMm%]*$/.test(metric)) return;
      if (options.action === 'keyword' && term === options.term && kind === options.kind) {
        const link = cells[1].querySelector('.keyword_content');
        if (visible(link) && !result.clicked) { link.click(); result.clicked = true; }
      }
      result.rows.push({term, metric, kind, rank: i + 1});
    });
  }
  return JSON.stringify(result);
})(__LABEL_PROBE_OPTIONS__)
