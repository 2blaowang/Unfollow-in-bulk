/* 预加载脚本:向渲染进程暴露受控的 IPC 接口 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bili', {
  /* 登录 */
  checkLogin: () => ipcRenderer.invoke('login:check'),
  startLogin: () => ipcRenderer.invoke('login:start'),
  logout: () => ipcRenderer.invoke('login:logout'),
  onLoginSuccess: (cb) => ipcRenderer.on('login:success', (_e, info) => cb(info)),
  /* 取关 */
  nav: () => ipcRenderer.invoke('bili:nav'),
  followingsPage: (mid, pn, ps) => ipcRenderer.invoke('bili:followings', mid, pn, ps),
  unfollow: (mid) => ipcRenderer.invoke('bili:unfollow', mid),
  /* 视频下载 */
  resolveVideo: (text) => ipcRenderer.invoke('video:resolve', text),
  getPlayurl: (bvid, cid) => ipcRenderer.invoke('video:playurl', bvid, cid),
  pickSave: (defaultName) => ipcRenderer.invoke('video:pick-save', defaultName),
  downloadStreams: (args) => ipcRenderer.invoke('video:download', args),
  mux: (args) => ipcRenderer.invoke('video:mux', args),
  cleanup: (files) => ipcRenderer.invoke('video:cleanup', files),
  ffmpegCheck: () => ipcRenderer.invoke('video:ffmpeg-check'),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, p) => cb(p)),
  /* 窗口 */
  openUnfollow: () => ipcRenderer.invoke('unfollow:open'),
  /* 抖音视频下载 */
  resolveDyVideo: (text) => ipcRenderer.invoke('dyvideo:resolve', text),
  fetchDyVideo: (id) => ipcRenderer.invoke('dyvideo:fetch', id),
  downloadDyVideo: (args) => ipcRenderer.invoke('dyvideo:download', args),
  /* 微信视频号(实验) */
  wxvStart: () => ipcRenderer.invoke('wxv:start'),
  wxvStop: () => ipcRenderer.invoke('wxv:stop'),
  wxvStatus: () => ipcRenderer.invoke('wxv:status'),
  wxvInstallCert: () => ipcRenderer.invoke('wxv:install-cert'),
  wxvDownload: (url, savePath, reqHeaders) => ipcRenderer.invoke('wxv:download', url, savePath, reqHeaders),
  wxvOpen: (p) => ipcRenderer.invoke('wxv:open', p),
  onWxvCaptured: (cb) => ipcRenderer.on('wxv:captured', (_e, info) => cb(info)),
  onWxvLog: (cb) => ipcRenderer.on('wxv:log', (_e, line) => cb(line)),
  onWxvStatus: (cb) => ipcRenderer.on('wxv:status', (_e, s) => cb(s)),
  onWxvFeed: (cb) => ipcRenderer.on('wxv:feed', (_e, item) => cb(item)),
  downloadWxvFeed: (item, savePath) => ipcRenderer.invoke('wxv:feed-download', item, savePath),
  /* 微信表情包导出 */
  emojiStatus: () => ipcRenderer.invoke('emoji:status'),
  emojiAccounts: () => ipcRenderer.invoke('emoji:accounts'),
  emojiInstall: (mode) => ipcRenderer.invoke('emoji:install', mode),
  emojiPickDir: () => ipcRenderer.invoke('emoji:pick-dir'),
  emojiOpen: (p) => ipcRenderer.invoke('emoji:open', p),
  emojiExport: (opts) => ipcRenderer.invoke('emoji:export', opts),
  emojiStop: () => ipcRenderer.invoke('emoji:stop'),
  onEmojiLog: (cb) => ipcRenderer.on('emoji:log', (_e, p) => cb(p && p.msg)),
  onEmojiProgress: (cb) => ipcRenderer.on('emoji:progress', (_e, p) => cb(p)),
  onEmojiDone: (cb) => ipcRenderer.on('emoji:done', (_e, p) => cb(p)),
});
