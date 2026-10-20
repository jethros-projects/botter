import { BotterError, invalid, sdkError } from './sdk-errors.mjs';

/** A single consumer, bounded subscription. Cancellation settles independently of a stalled producer. */
export class TranscriptSubscription {
  #queue = []; #waiting; #finished = false; #failure; #controller; #cleanup; #resolve; #reject; #iteratorTaken = false; #pendingNext = false; #finish; #cursor;
  constructor(source, { controller, maxBufferEvents, cleanup, onFinish, normalizeEvent }) {
    this.#controller = controller; this.#cleanup = cleanup;
    this.done = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.done.catch(() => {});
    const finish = error => {
      if (this.#finished) return;
      this.#finished = true; this.#failure = error;
      this.#cleanup(); onFinish();
      if (error) this.#reject(error); else this.#resolve();
      this.#waiting?.(); this.#waiting = undefined;
    };
    this.#finish = finish;
    const aborted = () => {
      this.#queue.length = 0;
      finish(controller.signal.reason instanceof BotterError && controller.signal.reason.code === 'TIMEOUT'
        ? controller.signal.reason : undefined);
    };
    controller.signal.addEventListener('abort', aborted, { once: true });
    const oldCleanup = this.#cleanup;
    this.#cleanup = () => { oldCleanup(); controller.signal.removeEventListener('abort', aborted); };
    if (controller.signal.aborted) aborted();
    (async () => {
      try {
        for await (const event of source) {
          if (this.#finished) break;
          if (this.#queue.length >= maxBufferEvents) {
            const error = new BotterError('Watch buffer overflowed. Reload history before starting a new watch.', { code: 'RESYNC_REQUIRED' });
            this.#queue.length = 0; finish(error); controller.abort(error); break;
          }
          this.#queue.push(normalizeEvent(event)); this.#waiting?.(); this.#waiting = undefined;
          if (['resyncRequired', 'cursorTooOld'].includes(event.type)) { finish(); controller.abort(); break; }
        }
        finish();
      } catch (error) { if (!this.#finished) finish(sdkError(error, controller.signal)); }
    })().catch(() => {});
  }
  async cancel() { this.#queue.length = 0; this.#finish(); this.#controller.abort(); }
  get cursor() { return this.#cursor ? structuredClone(this.#cursor) : undefined; }
  [Symbol.asyncIterator]() {
    if (this.#iteratorTaken) throw invalid('A subscription supports one iterator.');
    this.#iteratorTaken = true;
    return {
      next: async () => {
        if (this.#pendingNext) throw invalid('Wait for the previous next() call before requesting another event.');
        this.#pendingNext = true;
        try {
          while (!this.#queue.length && !this.#finished) await new Promise(resolve => { this.#waiting = resolve; });
          if (this.#queue.length) {
            const event = this.#queue.shift();
            if (event.type === 'entry' || event.type === 'delete') this.#cursor = { botId: event.botId, sessionId: event.sessionId, generation: event.generation, afterUpdatedSeq: event.updatedSeq };
            else if (event.type === 'cleared') this.#cursor = { botId: event.botId, sessionId: event.sessionId, generation: event.newGeneration, afterUpdatedSeq: '0' };
            return { done: false, value: event };
          }
          if (this.#failure) throw this.#failure;
          return { done: true, value: undefined };
        } finally { this.#pendingNext = false; }
      },
      return: async () => { await this.cancel(); return { done: true, value: undefined }; },
    };
  }
}

