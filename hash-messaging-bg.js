/*
 license: The MIT License, Copyright (c) 2026 YUKI 'Piro' Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-hash-messaging
*/
'use strict';

const HashMessagingBG = (() => {
  const MAX_HASH_BYTES = 4000;
  const OVERHEAD = 120;

  const pendingRequests = new Map();
  const incomingBuffers = new Map();
  const messageHandlers = [];

  const tabState = new Map(); 
  // tabId -> { queue: [], isSending: false }

  function ensureTabState(tabId) {
    if (!tabState.has(tabId)) {
      tabState.set(tabId, { queue: [], isSending: false });
    }
    return tabState.get(tabId);
  }

  function encodeBase64(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function decodeBase64(str) {
    str = str
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    while (str.length % 4) {
      str += '=';
    }
    return decodeURIComponent(escape(atob(str)));
  }

  function chunkString(str, size) {
    const out = [];
    for (let i = 0; i < str.length; i += size) {
      out.push(str.slice(i, i + size));
    }
    return out;
  }

  function generateId() {
    return crypto.randomUUID();
  }

  function updateTabHash(tabId, baseUrl, payload) {
    browser.tabs.update(tabId, {
      url: baseUrl + '#' + payload
    });
  }

  function sendChunks(tabId, type, id, data) {
    const base64 = encodeBase64(JSON.stringify(data));
    const chunkSize = MAX_HASH_BYTES - OVERHEAD;
    const chunks = chunkString(base64, chunkSize);
    const total = chunks.length;

    let index = 0;

    return new Promise(resolve => {
      function onUpdated(updatedTabId, info, tab) {
        if (updatedTabId !== tabId || !info.url) return;

        const url = new URL(info.url);
        const h = url.hash.slice(1);

        if (h === `ACK:${id}:${index-1}`) {
          if (index < total) {
            sendNext(url.origin + url.pathname + url.search);
          } else {
            browser.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        }
      }

      function sendNext(baseUrl) {
        const payload =
          `MSG:${type}:${id}:${index}/${total}:${chunks[index]}`;
        updateTabHash(tabId, baseUrl, payload);
        index++;
      }

      browser.tabs.onUpdated.addListener(onUpdated);

      browser.tabs.get(tabId, tab => {
        const url = new URL(tab.url);
        const base = url.origin + url.pathname + url.search;
        sendNext(base);
      });
    });
  }

  function processQueue(tabId) {
    const state = ensureTabState(tabId);
    if (state.isSending) return;
    if (state.queue.length === 0) return;

    state.isSending = true;

    const { message, resolve, reject } = state.queue.shift();
    const id = generateId();

    pendingRequests.set(id, result => {
      resolve(result);
      state.isSending = false;
      processQueue(tabId);
    });

    sendChunks(tabId, 'REQ', id, message);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout'));
        state.isSending = false;
        processQueue(tabId);
      }
    }, 30000);
  }

  function sendMessage(tabId, message) {
    const state = ensureTabState(tabId);

    return new Promise((resolve, reject) => {
      state.queue.push({ message, resolve, reject });
      processQueue(tabId);
    });
  }

  function onMessage(handler) {
    messageHandlers.push(handler);
  }

  function handleIncoming(tabId, urlStr) {
    const url = new URL(urlStr);
    const h = url.hash.slice(1);

    if (!h.startsWith('MSG:')) return;

    const match = h.match(/^MSG:(REQ|RES):([^:]+):([^:]+):(.+)$/);
    if (!match) return;

    const [, type, id, seq, data] = match;
    const [indexStr, totalStr] = seq.split('/');
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);

    if (!incomingBuffers.has(id)) {
      incomingBuffers.set(id, new Array(total));
    }

    const buffer = incomingBuffers.get(id);
    buffer[index] = data;

    updateTabHash(tabId, url.origin + url.pathname + url.search,
      `ACK:${id}:${index}`);

    if (buffer.filter(v => v !== undefined).length === total) {
      const full = buffer.join('');
      const message = JSON.parse(decodeBase64(full));
      incomingBuffers.delete(id);

      if (type === 'REQ') {
        dispatchRequest(tabId, id, message);
      } else if (type === 'RES') {
        const resolver = pendingRequests.get(id);
        if (resolver) {
          resolver(message);
          pendingRequests.delete(id);
        }
      }
    }
  }

  async function dispatchRequest(tabId, id, message) {
    let responded = false;

    function sendResponse(response) {
      if (responded) return;
      responded = true;
      sendChunks(tabId, 'RES', id, response);
    }

    const tab = await browser.tabs.get(tabId);
    for (const handler of messageHandlers) {
      const response = handler(message, { tab });
      if (response !== undefined) {
        sendResponse(await response);
      }
    }
  }

  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    handleIncoming(tabId, info.url);
  });

  return { sendMessage, onMessage };
})();

export default HashMessagingBG;
