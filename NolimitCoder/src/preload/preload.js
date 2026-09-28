const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStore: () => ipcRenderer.invoke('store:get'),
  setStore: (data) => ipcRenderer.invoke('store:set', data),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  onAuthChanged: (cb) => ipcRenderer.on('auth:changed', (_, p) => cb(p)),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPaths: () => ipcRenderer.invoke('app:paths'),
  fetchZenModels: (apiKey) => ipcRenderer.invoke('net:fetch-zen-models', apiKey),
  discoverLocal: () => ipcRenderer.invoke('net:discover-local'),
  chatStreamStart: (payload) => ipcRenderer.send('chat:stream-start', payload),
  chatStreamAbort: () => ipcRenderer.send('chat:stream-abort'),
  projectsDir: () => ipcRenderer.invoke('projects:dir'),
  projectList: () => ipcRenderer.invoke('projects:list'),
  projectCreate: (name) => ipcRenderer.invoke('projects:create', name),
  projectRename: (oldName, newName) => ipcRenderer.invoke('projects:rename', oldName, newName),
  projectRenamePath: (oldPath, newName) => ipcRenderer.invoke('projects:renamePath', oldPath, newName),
  projectDelete: (name) => ipcRenderer.invoke('projects:delete', name),
  projectPick: () => ipcRenderer.invoke('projects:pick'),
  projectFiles: (dirPath, includeContents) => ipcRenderer.invoke('projects:files', dirPath, includeContents),
  openPath: (p) => ipcRenderer.invoke('projects:openPath', p),
  toolsExec: (data) => ipcRenderer.invoke('tools:exec', data),
  cancelDownload: (id) => ipcRenderer.invoke('tools:cancel-download', id),
  debugLog: (tag, data) => { try { ipcRenderer.send('log:debug', { tag, data }); } catch {} },
  knownFolders: () => ipcRenderer.invoke('sys:knownFolders'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  previewStart: (dirPath) => ipcRenderer.invoke('preview:start', dirPath),
  previewStop: (dirPath) => ipcRenderer.invoke('preview:stop', dirPath),
  previewWatch: (dirPath) => ipcRenderer.invoke('preview:watch', dirPath),
  previewUnwatch: (dirPath) => ipcRenderer.invoke('preview:unwatch', dirPath),
  onPreviewFileChanged: (cb) => ipcRenderer.on('preview:file-changed', (_, d) => cb(d)),
  videoExport: (data) => ipcRenderer.invoke('video:export', data),
  videoReveal: (filePath) => ipcRenderer.invoke('video:reveal', filePath),
  videoAbort: () => ipcRenderer.invoke('video:abort'),
  onVideoProgress: (cb) => ipcRenderer.on('video:progress', (_, d) => cb(d)),
  termRun: (data) => ipcRenderer.invoke('term:run', data),
  isAdmin: () => ipcRenderer.invoke('sys:isAdmin'),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunchAdmin'),
  helperState: () => ipcRenderer.invoke('sys:helperState'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyRefresh: () => ipcRenderer.invoke('proxy:refresh'),
  onProxyStatus: (cb) => ipcRenderer.on('proxy:status', (_, d) => cb(d)),

  onChunk: (cb) => ipcRenderer.on('chat:stream-chunk', (_, d) => cb(d)),
  onEnd: (cb) => ipcRenderer.on('chat:stream-end', () => cb()),
  onError: (cb) => ipcRenderer.on('chat:stream-error', (_, e) => cb(e)),
  onAppBlocked: (cb) => ipcRenderer.on('app:blocked', (_, d) => cb(d)),
  onDownload: (cb) => ipcRenderer.on('nlc-download', (_, p) => cb(p)),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('chat:stream-chunk');
    ipcRenderer.removeAllListeners('chat:stream-end');
    ipcRenderer.removeAllListeners('chat:stream-error');
    ipcRenderer.removeAllListeners('nlc-download');
    ipcRenderer.removeAllListeners('auth:changed');
  }
});
