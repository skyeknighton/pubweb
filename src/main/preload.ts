import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chaosnet', {
  uploadPage: (data: any) => ipcRenderer.invoke('upload-page', data),
  uploadImagePage: (data: any) => ipcRenderer.invoke('upload-page', data),
  getPages: () => ipcRenderer.invoke('get-pages'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getPeerStatus: () => ipcRenderer.invoke('get-peer-status'),
});
