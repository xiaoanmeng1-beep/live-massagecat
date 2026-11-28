'use strict';
(() => {
  const $=id=>document.getElementById(id), box=$('failureSettings'), api=window.desktop;
  const prev=$('prevFailures'),next=$('nextFailures'),exp=$('exportFailures'),clear=$('clearFailures'),refresh=$('refreshFailures');
  const notice=$('failureNotice'),count=$('failureCount'),list=$('failureRows');
  let pages=[0],current=null,version=0,timer=null,busy=false,loading=false;
  function controls(){
    prev.disabled=busy||loading||pages.length===1;next.disabled=busy||loading||!current?.more;
    exp.disabled=clear.disabled=busy||!current?.total;refresh.disabled=busy||loading;
  }
  function display(r){
    const li=document.createElement('li');
    for(const [cls,value] of [
      ['failure-meta',new Date(r.receivedAt).toLocaleString('zh-CN')+' · '+r.name],
      ['failure-text',r.text],['failure-reason','原因：'+r.reason]
    ]){const p=document.createElement('p');p.className=cls;p.textContent=value;li.append(p);}
    return li;
  }
  async function load(){
    if(!box.open||busy)return;
    const v=++version;loading=true;controls();
    try{
      const result=await api.getMatchFailures(pages.at(-1));
      if(v!==version||!box.open)return;
      if(!result.rows.length && pages.length>1){pages=[0];return load();}
      current=result;count.textContent=result.total?'共 '+result.total+' 条 · 第 '+pages.length+' 页':'暂无未入队记录';
      list.replaceChildren(...result.rows.map(display));
    }catch(e){if(v===version){current=null;count.textContent='读取失败，请刷新：'+e.message;list.replaceChildren();}}
    finally{if(v===version){loading=false;controls();}}
  }
  function reset(){pages=[0];}
  box.addEventListener('toggle',()=>{
    clearTimeout(timer);timer=null;++version;loading=false;
    if(box.open){reset();notice.textContent='';load();}
  });
  api.onMatchFailuresChanged(()=>{
    if(!box.open||busy||timer!==null)return;
    timer=setTimeout(()=>{timer=null;load();},300);
  });
  prev.onclick=()=>{pages.pop();load();};
  next.onclick=()=>{if(current?.more){pages.push(current.rows.at(-1).id);load();}};
  refresh.onclick=()=>{reset();load();};
  async function action(isClear){
    if(busy)return;
    busy=true;++version;loading=false;controls();
    notice.textContent=isClear?'等待确认…':'正在导出…';
    try{
      const r=await (isClear?api.clearMatchFailures():api.exportMatchFailures());
      if(r.canceled)notice.textContent='已取消';
      else {notice.textContent=isClear?'已清空 '+r.count+' 条记录':(r.count?'已导出 '+r.count+' 条记录':'暂无可导出的记录');if(isClear)reset();}
    }catch(e){notice.textContent=(isClear?'清空':'导出')+'失败：'+e.message;}
    finally{busy=false;controls();load();}
  }
  exp.onclick=()=>action(false);clear.onclick=()=>action(true);
})();
