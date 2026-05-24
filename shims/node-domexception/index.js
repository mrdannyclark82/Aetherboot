if (!globalThis.DOMException) {
  try {
    const { MessageChannel } = require('worker_threads');
    const port = new MessageChannel().port1;
    const ab = new ArrayBuffer(0);
    port.postMessage(ab, [ab, ab]);
  } catch (err) {
    if (err && err.constructor && err.constructor.name === 'DOMException') {
      globalThis.DOMException = err.constructor;
    }
  }
}

module.exports = globalThis.DOMException || class DOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name || 'DOMException';
  }
};
