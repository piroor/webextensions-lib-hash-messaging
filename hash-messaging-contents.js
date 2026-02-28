/*
 license: The MIT License, Copyright (c) 2026 YUKI "Piro" Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-hash-messaging
*/
'use strict';

const HashMessagingContents = (() => {
  const MAX_HASH_BYTES = 4000;
  const OVERHEAD = 120;

  const pendingRequests = new Map();
  const incomingBuffers = new Map();
  const messageHandlers = [];

  const sendQueue = [];
  let isSending = false;
  let secret = null;

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

  function sendRaw(payload) {
    history.replaceState(null, '', '#' + payload);
  }

  function sendChunks(type, id, data) {
    const base64 = encodeBase64(JSON.stringify(data));
    const chunkSize = MAX_HASH_BYTES - OVERHEAD;
    const chunks = chunkString(base64, chunkSize);
    const total = chunks.length;

    let index = 0;

    return new Promise(resolve => {
      function handleAck() {
        const h = location.hash.slice(1);
        if (h === `ACK:${secret}:${id}:${index - 1}`) {
          if (index < total) {
            sendNext();
          } else {
            window.removeEventListener('hashchange', handleAck);
            resolve();
          }
        }
      }

      function sendNext() {
        const payload =
          `MSG:${secret}:${type}:${id}:${index}/${total}:${chunks[index]}`;
        sendRaw(payload);
        index++;
      }

      window.addEventListener('hashchange', handleAck);
      sendNext();
    });
  }

  function processQueue() {
    if (isSending) return;
    if (sendQueue.length === 0) return;
    if (!secret) return;

    isSending = true;

    const { message, resolve, reject } = sendQueue.shift();
    const id = generateId();

    pendingRequests.set(id, result => {
      resolve(result);
      isSending = false;
      processQueue();
    });

    sendChunks('REQ', id, message);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout'));
        isSending = false;
        processQueue();
      }
    }, 30000);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      sendQueue.push({ message, resolve, reject });
      processQueue();
    });
  }

  function onMessage(handler) {
    messageHandlers.push(handler);
  }

  function handleIncoming() {
    const h = location.hash.slice(1);

    if (h.startsWith('INIT:')) {
      secret = h.slice(5);
      sendRaw(`ACK-INIT:${secret}`);
      processQueue();
      return;
    }

    if (!h.startsWith('MSG:')) return;

    const match = h.match(/^MSG:([^:]+):(REQ|RES):([^:]+):([^:]+):(.+)$/);
    if (!match) return;

    if (match[1] !== secret) return;

    const [, , type, id, seq, data] = match;
    const [indexStr, totalStr] = seq.split('/');
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);

    if (!incomingBuffers.has(id)) {
      incomingBuffers.set(id, new Array(total));
    }

    const buffer = incomingBuffers.get(id);
    buffer[index] = data;

    sendRaw(`ACK:${secret}:${id}:${index}`);

    if (buffer.filter(v => v !== undefined).length === total) {
      const full = buffer.join('');
      const message = JSON.parse(decodeBase64(full));
      incomingBuffers.delete(id);

      if (type === 'REQ') {
        dispatchRequest(id, message);
      } else {
        const resolver = pendingRequests.get(id);
        if (resolver) {
          resolver(message);
          pendingRequests.delete(id);
        }
      }
    }
  }

  async function dispatchRequest(id, message) {
    let responded = false;

    function sendResponse(response) {
      if (responded) return;
      responded = true;
      sendChunks('RES', id, response);
    }

    for (const handler of messageHandlers) {
      const response = handler(message, {});
      if (response !== undefined) {
        sendResponse(await response);
      }
    }
  }

  window.addEventListener('hashchange', handleIncoming);
  handleIncoming();

  return { sendMessage, onMessage };
})();

export default HashMessagingContents;
