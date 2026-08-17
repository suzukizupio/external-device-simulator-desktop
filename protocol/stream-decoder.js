// Q48-008I byte stream decoder
// Browser: window.StreamDecoder / Node: require("./stream-decoder.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./mansion-controller.js"));
  } else {
    root.StreamDecoder = factory(root.MansionController);
  }
})(typeof window !== "undefined" ? window : globalThis, function (MansionController) {
  "use strict";

  if (!MansionController) throw new Error("MansionController is required before StreamDecoder");

  const CODE = MansionController.CODE;
  const CONTROL_NAMES = Object.freeze({
    [CODE.NULL]: "NULL",
    [CODE.ENQ]: "ENQ",
    [CODE.ACK]: "ACK",
    [CODE.NAK]: "NAK",
  });
  const TRANSPORT_CONTROLS = new Set(Object.keys(CONTROL_NAMES).map(Number));

  class StreamDecoderError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "StreamDecoderError";
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function makeError(code, message, details) {
    return new StreamDecoderError(code, message, details);
  }

  class StreamDecoder {
    constructor(options) {
      const opts = options || {};
      if (opts.onEvent !== undefined && typeof opts.onEvent !== "function") {
        throw makeError("INVALID_CALLBACK", "onEvent は関数で指定してください");
      }
      if (opts.version !== undefined && !Object.values(MansionController.VERSION).includes(opts.version)) {
        throw makeError("INVALID_VERSION", "version は1、2、3のいずれかで指定してください", { value: opts.version });
      }
      if (opts.from !== undefined && opts.from !== MansionController.ROLE.IC && opts.from !== MansionController.ROLE.MC) {
        throw makeError("INVALID_ROLE", "from はICまたはMCで指定してください", { value: opts.from });
      }
      if (opts.validateCommand !== undefined && typeof opts.validateCommand !== "boolean") {
        throw makeError("INVALID_BOOLEAN", "validateCommand はbooleanで指定してください", { value: opts.validateCommand });
      }
      this._parseOptions = {
        version: opts.version,
        from: opts.from,
        validateCommand: opts.validateCommand,
      };
      this._onEvent = opts.onEvent || null;
      this._buffer = [];
      this._declaredLength = null;
      this._expectedTotal = null;
    }

    get bufferedLength() {
      return this._buffer.length;
    }

    reset() {
      this._buffer = [];
      this._declaredLength = null;
      this._expectedTotal = null;
    }

    push(chunk) {
      const bytes = MansionController.toBytes(chunk, "chunk");
      const events = [];
      for (const byte of bytes) this._consume(byte, events);
      return events;
    }

    flush() {
      if (this._buffer.length === 0) return [];
      const raw = this._buffer.slice();
      const event = {
        type: "error",
        error: makeError("TRUNCATED_FRAME", "STXで始まったフレームが完結していません", {
          bufferedLength: raw.length,
          expectedTotal: this._expectedTotal,
        }),
        raw,
      };
      this.reset();
      this._notify(event);
      return [event];
    }

    _notify(event) {
      if (this._onEvent) this._onEvent(event);
    }

    _emit(events, event) {
      events.push(event);
      this._notify(event);
    }

    _emitError(events, code, message, raw, details) {
      this._emit(events, {
        type: "error",
        error: makeError(code, message, details),
        raw: raw ? raw.slice() : [],
      });
    }

    _consumeIdle(byte, events) {
      if (byte === CODE.STX) {
        this._buffer = [byte];
        this._declaredLength = null;
        this._expectedTotal = null;
        return;
      }
      if (TRANSPORT_CONTROLS.has(byte)) {
        this._emit(events, { type: "control", code: byte, name: CONTROL_NAMES[byte] });
        return;
      }
      this._emitError(
        events,
        "UNEXPECTED_BYTE",
        `フレーム外で未定義のバイト0x${byte.toString(16).toUpperCase().padStart(2, "0")}を受信しました`,
        [byte],
        { byte },
      );
    }

    _consume(byte, events) {
      if (this._buffer.length === 0) {
        this._consumeIdle(byte, events);
        return;
      }

      // BCCは生バイトなのでSTXと同値でも新規フレームとして扱わない。
      const isExpectedBcc = this._expectedTotal !== null && this._buffer.length === this._expectedTotal - 1;
      if (byte === CODE.STX && !isExpectedBcc) {
        const abandoned = this._buffer.slice();
        this._emitError(
          events,
          "UNEXPECTED_STX",
          "未完了フレーム内でSTXを受信したため、新しいフレームへ再同期しました",
          abandoned,
          { bufferedLength: abandoned.length },
        );
        this._buffer = [CODE.STX];
        this._declaredLength = null;
        this._expectedTotal = null;
        return;
      }

      this._buffer.push(byte);

      if (this._buffer.length === 2) {
        if (byte < 0x30 || byte > 0x39) {
          const raw = this._buffer.slice();
          this._emitError(events, "INVALID_LEN_ENCODING", "LENの十の位がASCII数字ではありません", raw, { byte });
          this.reset();
          if (TRANSPORT_CONTROLS.has(byte)) this._consumeIdle(byte, events);
        }
        return;
      }

      if (this._buffer.length === 3) {
        if (byte < 0x30 || byte > 0x39) {
          const raw = this._buffer.slice();
          this._emitError(events, "INVALID_LEN_ENCODING", "LENの一の位がASCII数字ではありません", raw, { byte });
          this.reset();
          if (TRANSPORT_CONTROLS.has(byte)) this._consumeIdle(byte, events);
          return;
        }
        this._declaredLength = (this._buffer[1] - 0x30) * 10 + (this._buffer[2] - 0x30);
        if (this._declaredLength < 5 || this._declaredLength > 99) {
          const raw = this._buffer.slice();
          this._emitError(events, "INVALID_LEN_RANGE", "LENは05～99の範囲です", raw, {
            declaredLength: this._declaredLength,
          });
          this.reset();
          return;
        }
        this._expectedTotal = this._declaredLength + 2;
        return;
      }

      const currentIndex = this._buffer.length - 1;
      if (byte === CODE.ETX && currentIndex < this._declaredLength) {
        const raw = this._buffer.slice();
        this._emitError(events, "UNEXPECTED_ETX", "LENで示された位置より前にETXを受信しました", raw, {
          actualIndex: currentIndex,
          expectedIndex: this._declaredLength,
        });
        this.reset();
        return;
      }

      if (this._expectedTotal !== null && this._buffer.length === this._expectedTotal) {
        const raw = this._buffer.slice();
        this.reset();
        try {
          const frame = MansionController.validateFrame(raw, this._parseOptions);
          this._emit(events, { type: "frame", raw, frame });
        } catch (error) {
          this._emit(events, { type: "error", error, raw });
        }
      }
    }
  }

  Object.defineProperties(StreamDecoder, {
    StreamDecoder: { value: StreamDecoder, enumerable: true },
    StreamDecoderError: { value: StreamDecoderError, enumerable: true },
    CONTROL_NAMES: { value: CONTROL_NAMES, enumerable: true },
  });

  return StreamDecoder;
});
