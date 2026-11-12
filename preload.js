const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nexoAI', {
  ask: (payload) => ipcRenderer.invoke('nexo-ai:ask', payload),
  hasKey: () => ipcRenderer.invoke('nexo-ai:has-key'),
  setKey: (key) => ipcRenderer.invoke('nexo-ai:set-key', key),
  getPrefs: (role) => ipcRenderer.invoke('nexo-ai:get-prefs', role),
  setPrefs: (role, text) => ipcRenderer.invoke('nexo-ai:set-prefs', { role, text }),
  audit: (evento) => ipcRenderer.invoke('nexo-ai:audit', evento),
  guardarInforme: (datos) => ipcRenderer.invoke('nexo-ai:guardar-informe', datos),
  abrirInforme: (archivo) => ipcRenderer.invoke('nexo-ai:abrir-informe', archivo)
});
