const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('deye',{
  subscribe: callback=>{ipcRenderer.on('snapshot',(_e,data)=>callback(data));ipcRenderer.send('ready');},
  action: name=>{if(['menu','hide','refresh','toggleMode','togglePin','toggleMute','drag-start','drag-end'].includes(name)) ipcRenderer.send('action',name);}
});
