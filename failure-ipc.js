'use strict';
const path=require('node:path');
const { exportMatchFailures }=require('./failure-export');

function registerFailureIpc(ipcMain,dialog,getWindow,dataStore) {
  const checkFailureSender=event=>{
    if(event.sender!==getWindow()?.webContents || event.senderFrame!==event.sender.mainFrame)throw Error('仅支持在主管理窗口操作');
  };
  ipcMain.handle('live:failures-list',(event,before)=>{checkFailureSender(event);return dataStore.listMatchFailures(before);});
  ipcMain.handle('live:failures-export',async event=>{
    checkFailureSender(event);
    if(!dataStore.matchFailureStats().total)return {count:0};
    const {canceled,filePath}=await dialog.showSaveDialog(getWindow(),{title:'导出全部未入队评论',defaultPath:'未入队评论-'+new Date().toLocaleDateString('sv-SE')+'.csv',
      filters:[{name:'Excel / WPS 表格（CSV）',extensions:['csv']}],properties:['showOverwriteConfirmation','createDirectory']});
    if(canceled || !filePath)return {canceled:true};
    if(path.extname(filePath).toLowerCase()!=='.csv')throw Error('请选择 .csv 文件名');
    return exportMatchFailures(dataStore.file,filePath);
  });
  ipcMain.handle('live:failures-clear',async event=>{
    checkFailureSender(event);
    const {total,lastId}=dataStore.matchFailureStats();
    if(!total)return {count:0};
    const {response}=await dialog.showMessageBox(getWindow(),{type:'warning',buttons:['取消','清空记录'],defaultId:0,cancelId:0,
      message:'清空这 '+total+' 条未入队记录？',detail:'清空后不可恢复。原始直播评论和报价不变，确认期间新增的记录也会保留。'});
    if(response!==1)return {canceled:true};
    const count=dataStore.clearMatchFailures(lastId);
    const win=getWindow();
    if(win && !win.isDestroyed()) win.webContents.send('live:failures-changed');
    return {count};
  });
}
module.exports={registerFailureIpc};
