/* Kontrola, že všechny funkce/proměnné, které si renderer navzájem předává, existují. */
const fs = require('fs'), path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

const need = ['askQuestion', 'askPrompt', 'tryParseArgs', 'withBackend', 'normTool', 'sanitizeResponse', 'saveConvos',
  'renderPlanBox', 'updateThink', 'setSendBusy', 'setActivity', 'setFooter', 'hidePlanBox', 'renderChatList',
  'renderMessages', 'playDone', 'prefsGo', 'escapeHtml', 'newConvo', 'activeConvo', 'projectMatch', 'getEffort',
  'zenIdOf', 'modelLabel', 'updateTokenMeter', 'resetTokenMeter', 'mdToHtml', 'bindCopyButtons', 'bindThink',
  'runToolMsgs', 'buildRunSummary', 'looksDone', 'looksPromise', 'publicErr', 'lastUserText', 'ensureForRequest',
  'detectIntent', 'expandAtRefs', 'videoResWH', 'activeProjectType', 'missingBinId', 'refreshVideoEmpty',
  'setVideoMode', 'fmtTok', 'stopEverything', 'runAgent', 'oneShot', 'sendMessage', 'handleSlash',
  'flushPending', 'parseSSE', 'updateQueue', 'renderAttachStrip', 'imageContext', 'autoGrow', 'setFolderLabel',
  'showView', 'renderProjects', 'renderModelList', 'updateModelLabel', 'renderEffortList', 'clampDropdown',
  'closeModels', 'activityFor', 'humanTool', 'renderToolCard', 'addMsg', 'thinkState', 'resetThink',
  'streamingChats', 'activeConvoId', 'conversations', 'pendingQueue', 'stopRequested', 'errLog', 'dlog',
  'el', 'TOOL_RESULT_CHARS', 'PROMPT_CHAR_BUDGET', 'MAX_TOKENS', 'SEND_MAX_TOKENS', 'prefs', 'selectedModel'];

let bad = 0;
for (const n of need) {
  const re = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?(?:function\\s+' + n + '\\b|(?:const|let|var)\\s+' + n + '\\b)');
  if (!re.test(s)) { bad++; console.log('MISSING  ' + n); }
}
console.log(bad ? '\n' + bad + ' problemu' : '\nvse v poradku');
process.exit(bad ? 1 : 0);
