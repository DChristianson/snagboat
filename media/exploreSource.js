// The Explore tab's source in the detail webview: builds the source object
// explore.js expects (see its header) over the VS Code API detail.js holds
// and the page's message events, keeps the tab's state under an `explore`
// key of the webview state, and mounts the tab into the root detail.js
// provides. This is the only place the explorer touches VS Code; the web
// demo supplies a source of its own.
(function () {
  const S = window.snagboat;
  const explore = window.snagboatExplore;
  if (!S || !explore) return;
  const { vscode, persist, exploreRoot, tooltip, showTip, hideTip } = S;
  const listeners = { sessions: [], explorer: [] };
  // The session open in the Sessions tab: what it saved, then what the extension says.
  let openId = (vscode.getState() || {}).sessionId || null;

  window.addEventListener('message', (evt) => {
    const d = evt.data;
    if (!d) return;
    if (d.type === 'exploreSessions') for (const cb of listeners.sessions) cb(d.list);
    else if (d.type === 'explorer') for (const cb of listeners.explorer) cb(d.state);
    else if (d.type === 'session') openId = d.view ? d.view.summary.sessionId : null;
  });

  const source = {
    listSessions() {
      vscode.postMessage({ type: 'listExploreSessions' });
    },
    loadSessions(ids) {
      vscode.postMessage({ type: 'explore', sessionIds: ids });
    },
    closeExplorer() {
      vscode.postMessage({ type: 'closeExplorer' });
    },
    getState() {
      return (vscode.getState() || {}).explore || {};
    },
    setState(partial) {
      persist({ explore: { ...source.getState(), ...partial } });
    },
    onSessions(cb) {
      listeners.sessions.push(cb);
    },
    onExplorer(cb) {
      listeners.explorer.push(cb);
    },
    openSessionId() {
      return openId;
    },
  };

  const ctx = { ...window.snagboatVizKit, tooltip, showTip, hideTip };
  const tab = explore.mount(exploreRoot, source, ctx);
  // detail.js restored the tab before this script ran; give the tab its first show now.
  if ((vscode.getState() || {}).tab === 'explore') tab.shown();
})();
