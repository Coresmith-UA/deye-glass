const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('setup',{
  load:()=>ipcRenderer.invoke('settings:load'),
  test:form=>ipcRenderer.invoke('settings:test',form),
  save:form=>ipcRenderer.invoke('settings:save',form),
  // The file picker and the player both live in the main process: the page has no filesystem and no
  // audio (its CSP forbids media), and the point of the whitelist is that it stays that way.
  browse:()=>ipcRenderer.invoke('settings:browse'),
  play:file=>ipcRenderer.invoke('settings:play',file),
  // Mute can be switched from the toolbar or the menu while this window is open, so the form is told
  // rather than left showing a stale checkbox.
  onMute:callback=>ipcRenderer.on('settings:mute',(_e,value)=>callback(value))
});
