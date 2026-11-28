'use strict';
const {ipcRenderer}=require('electron');

// Keep the official form and challenge iframe intact, with the same session.
// This preload changes presentation only. It never reads form values, sends
// SMS, solves challenges, clicks submit or copies authentication credentials.
window.addEventListener('DOMContentLoaded',()=>{
  if(location.hostname==='uc.guazi.com'&&location.pathname==='/guazi-mall-ucenter/captcha'){
    const style=document.createElement('style');style.textContent=`
      html,body {min-width:0!important;width:100%!important;margin:0!important;background:#fff!important;--unit:1px;}
      body * {visibility:hidden!important;}
      .captcha-container,.captcha-container *,[id*="captcha" i],[id*="captcha" i] *,[class*="captcha" i],[class*="captcha" i] *,iframe {visibility:visible!important;}
      .captcha-container {margin:0!important;padding:8px!important;min-height:380px!important;height:auto!important;width:100%!important;box-sizing:border-box!important;}
    `;document.head.append(style);
    // Display the provider's original verification page; the user operates it.
    ipcRenderer.send('guazi-login:document-state',{ready:true,challenge:true,loginPhase:'challenge'});
    return;
  }
  if(location.hostname!=='www.guazi.com'||!location.pathname.startsWith('/gujia'))return;
  const style=document.createElement('style');
  style.textContent=`
    html,body {min-width:0!important;width:100%!important;margin:0!important;background:white!important;overflow:hidden!important;}
    body * {visibility:hidden!important;}
    .login-box-popup,.login-box-popup *,
    [id*="captcha" i],[id*="captcha" i] *,[class*="captcha" i],[class*="captcha" i] *,
    iframe[src*="captcha" i],.adm-toast-main,.adm-toast-main * {visibility:visible!important;}
    .login-box-popup {position:fixed!important;inset:0!important;background:#fff!important;overflow:auto!important;}
    .login-box-popup .login-box {position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:100%!important;max-width:none!important;margin:0!important;padding:14px!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:#fff!important;box-sizing:border-box!important;}
    .login-box-popup .login-form {position:static!important;inset:auto!important;transform:none!important;width:100%!important;height:auto!important;max-width:none!important;margin:0!important;padding:0!important;}
    .login-box-popup .close-btn,.login-box-popup .form-title {display:none!important;}
    .login-box-popup .form-field {position:relative!important;inset:auto!important;transform:none!important;display:flex!important;align-items:center!important;width:100%!important;height:42px!important;max-width:none!important;margin:0 0 12px!important;box-sizing:border-box!important;}
    .login-box-popup .form-input {position:static!important;transform:none!important;flex:1 1 0!important;width:100%!important;height:42px!important;min-width:0!important;padding:0 10px!important;margin:0!important;border:1px solid #dedede!important;border-radius:5px!important;color:#27292d!important;background:#fff!important;font:14px "PingFang SC",sans-serif!important;box-sizing:border-box!important;}
    .login-box-popup .yzm-btn {display:flex!important;align-items:center!important;justify-content:center!important;flex:0 0 100px!important;height:42px!important;line-height:normal!important;margin-left:8px!important;padding:0!important;border:1px solid #b9d6f6!important;border-radius:5px!important;text-align:center!important;font:12px "PingFang SC",sans-serif!important;color:#176fc7!important;background:#f4f9ff!important;box-sizing:border-box!important;}
    .login-box-popup .form-error {position:static!important;height:auto!important;min-height:0!important;font-size:12px!important;line-height:18px!important;margin:2px 0 4px!important;}
    .login-box-popup .form-btn {position:static!important;transform:none!important;display:flex!important;align-items:center!important;justify-content:center!important;width:100%!important;height:42px!important;padding:0!important;margin-top:8px!important;border:0!important;border-radius:5px!important;background:#2f8df4!important;color:#fff!important;font:14px "PingFang SC",sans-serif!important;letter-spacing:normal!important;}
    .login-box-popup .legal {position:static!important;transform:none!important;font-size:11px!important;line-height:1.5!important;margin-top:10px!important;}
  `;
  document.head.append(style);
  const visible=node=>{
    const r=node.getBoundingClientRect(),s=getComputedStyle(node);
    return r.width>80&&r.height>30&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
  };
  const challengeSelector='[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i]';
  let previous='',scheduled=false;
  function update(){
    scheduled=false;
    const ready=!!document.querySelector('.login-box-popup input[name="username"]') &&
      [...document.querySelectorAll('.login-box-popup .login-box')].some(visible);
    const challenge=[...document.querySelectorAll(challengeSelector)].some(visible);
    const error=[...document.querySelectorAll('.login-box-popup .form-error,.adm-toast-main')]
      .filter(visible).map(e=>e.textContent.trim()).filter(Boolean).join('；').slice(0,180)
      .replace(/\d{6,}/g,'[已隐藏]');
    const state={ready,challenge,loginPhase:challenge?'challenge':'idle',notice:error?'error':'',errorMessage:error};
    const json=JSON.stringify(state);
    if(previous!==json){previous=json;ipcRenderer.send('guazi-login:document-state',state);}
  }
  function schedule(){if(!scheduled){scheduled=true;setTimeout(update,40);}}
  const observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true,attributeFilter:['class','style','src']});
  window.addEventListener('resize',schedule);
  window.addEventListener('beforeunload',()=>observer.disconnect(),{once:true});
  update();
});
