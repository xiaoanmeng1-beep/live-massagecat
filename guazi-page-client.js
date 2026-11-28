'use strict';

// Use the request client shipped by the official valuation page, in that page's
// own session. Never copy a signature, a device identity or another user's token.
// These module IDs are from /gujia/'s current public bundle; fail explicitly if
// the site changes, instead of silently issuing an unsigned or different API.
function pageCall(method, params = {}) {
  const allowed = new Set(['brands', 'series', 'models', 'cities', 'user', 'quote']);
  if (!allowed.has(method)) throw Error('未知瓜子操作');
  return `(async () => {
    if (location.hostname !== 'www.guazi.com' || !location.pathname.startsWith('/gujia'))
      return {ok:false, code:'PAGE_CHANGED', message:'瓜子估价页面已跳转，请重新登录或刷新'};
    try {
      if (!window.__valuationGuazi) {
        if (!window.TURBOPACK?.push || Array.isArray(window.TURBOPACK))
          return {ok:false,code:'PAGE_NOT_READY',message:'瓜子页面尚未加载完成'};
        window.TURBOPACK.push(['lmc-valuation-client', 'lmc-valuation-client', ctx => {
          window.__valuationGuazi = { request:ctx.i(35008).request, catalog:ctx.i(33566), auth:ctx.i(33488) };
        }]);
        window.TURBOPACK.push(['lmc-valuation-entry', {otherChunks:[],runtimeModuleIds:['lmc-valuation-client']}]);
        await Promise.resolve();
      }
      const api = window.__valuationGuazi;
      if (!api?.request) throw Error('官方估价客户端结构已变更');
      const params = ${JSON.stringify(params)};
      let data;
      switch (${JSON.stringify(method)}) {
        case 'brands': data = await api.catalog.getMinorList(); break;
        case 'series': data = await api.catalog.getTagList(params); break;
        case 'models': data = await api.catalog.getCarIdList(params); break;
        case 'cities': data = await api.catalog.getCityList(); break;
        case 'user': {
          const user = await api.auth.getUserInfoByTokenApi();
          // Return confirmation and a mask only. Authentication remains inside
          // the partition, never in app IPC, exported data or runtime logs.
          data = {authenticated:!!user?.chdUserId};
          break;
        }
        case 'quote': data = await api.request({method:'GET',baseURL:'https://marketing.guazi.com',
          url:'/marketing/model-price/getWithFallback',params}); break;
      }
      return {ok:true,data};
    } catch (e) {
      return {ok:false,code:String(e?.code || 'GUAZI_REQUEST_FAILED'),
        message:String(e?.message || e?.msg || '瓜子请求失败').slice(0,180)};
    }
  })()`;
}

module.exports = { pageCall };
