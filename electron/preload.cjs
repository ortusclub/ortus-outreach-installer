const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ortusPreview', {
  open: (url) => ipcRenderer.invoke('ortus:open-live-preview', url),
  close: () => ipcRenderer.invoke('ortus:close-live-preview'),
});
