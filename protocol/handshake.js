// 4線式コンテンション方式の送信側FSM。
// 実時間タイマーは持たず、呼び出し側が receiveControl()/timeout() をイベントとして渡す。
(function (global) {
  "use strict";

  const CODE = { EOT: 0x04, ENQ: 0x05, ACK: 0x06, NAK: 0x15 };
  const STATE = {
    IDLE: "idle",
    WAIT_LINK_ACK: "waitLinkAck",
    WAIT_TEXT_ACK: "waitTextAck",
    COMPLETE: "complete",
    FAILED: "failed",
    CANCELLED: "cancelled",
  };

  function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`${name}は${min}～${max}の整数で指定してください`);
    }
    return value;
  }

  function normalizePacket(input, index) {
    if (!input || typeof input.length !== "number") throw new TypeError(`パケット${index + 1}はバイト配列で指定してください`);
    const packet = Array.from(input);
    if (packet.length === 0) throw new RangeError(`パケット${index + 1}が空です`);
    packet.forEach((value, byteIndex) => {
      if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
        throw new RangeError(`パケット${index + 1}の${byteIndex}バイト目が不正です`);
      }
    });
    return packet;
  }

  function normalizePackets(input) {
    if (!Array.isArray(input) || input.length === 0) throw new RangeError("送信パケットを1件以上指定してください");
    return input.map(normalizePacket);
  }

  class SendHandshakeFSM {
    constructor(options) {
      options = options || {};
      this.maxRetries = options.maxRetries == null ? 5 : integer(options.maxRetries, "最大再送回数", 0, 65535);
      this.retryLimits = this._normalizeRetryLimits(options.retryLimits);
      this.retryUnexpectedControl = options.retryUnexpectedControl === true;
      this.sendEot = options.sendEot !== false;
      this.textRetryMode = options.textRetryMode == null ? "restart" : options.textRetryMode;
      if (this.textRetryMode !== "restart" && this.textRetryMode !== "sameText") {
        throw new RangeError("textRetryModeはrestartまたはsameTextで指定してください");
      }
      this.onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
      this._initialPackets = options.packets == null ? null : normalizePackets(options.packets);
      this.reset();
    }

    reset() {
      this.state = STATE.IDLE;
      this.packets = [];
      this.packetIndex = 0;
      this.retriesUsed = 0;
      this.retryCounts = {};
      this.lastFailure = null;
    }

    isActive() {
      return this.state === STATE.WAIT_LINK_ACK || this.state === STATE.WAIT_TEXT_ACK;
    }

    snapshot() {
      return {
        state: this.state,
        packetIndex: this.packetIndex,
        packetCount: this.packets.length,
        retriesUsed: this.retriesUsed,
        retryCounts: Object.assign({}, this.retryCounts),
        maxRetries: this.maxRetries,
        sendEot: this.sendEot,
        textRetryMode: this.textRetryMode,
        lastFailure: this.lastFailure,
      };
    }

    start(packets) {
      if (this.isActive()) throw new Error("送信シーケンスは既に実行中です");
      const source = packets == null ? this._initialPackets : packets;
      this.packets = normalizePackets(source);
      this.packetIndex = 0;
      this.retriesUsed = 0;
      this.retryCounts = {};
      this.lastFailure = null;
      this.state = STATE.WAIT_LINK_ACK;
      return this._events(this._sendControl("ENQ", CODE.ENQ));
    }

    receiveControl(value) {
      integer(value, "制御コード", 0, 0xFF);
      if (!this.isActive()) return this._events(this._event("ignored", { reason: "inactive", value }));

      if (value === CODE.NAK) return this._retry("nak");
      if (value === CODE.ENQ) return this._events(this._event("collision", { value }));
      if (value !== CODE.ACK) {
        return this.retryUnexpectedControl
          ? this._retry("unexpected-control")
          : this._events(this._event("ignored", { reason: "unexpected-control", value }));
      }

      if (this.state === STATE.WAIT_LINK_ACK) {
        this.state = STATE.WAIT_TEXT_ACK;
        return this._events(this._event("send", {
          kind: "TEXT",
          bytes: this.packets[this.packetIndex].slice(),
          packetIndex: this.packetIndex,
          packetCount: this.packets.length,
          attempt: this.retriesUsed + 1,
        }));
      }

      if (this.packetIndex + 1 < this.packets.length) {
        this.packetIndex += 1;
        this.state = STATE.WAIT_LINK_ACK;
        return this._events(this._sendControl("ENQ", CODE.ENQ));
      }

      this.state = STATE.COMPLETE;
      const complete = this._event("complete", {
        packetCount: this.packets.length,
        retriesUsed: this.retriesUsed,
      });
      return this.sendEot ? this._events(this._sendControl("EOT", CODE.EOT), complete) : this._events(complete);
    }

    timeout(reason) {
      if (!this.isActive()) return this._events(this._event("ignored", { reason: "inactive-timeout" }));
      return this._retry(reason || "timeout");
    }

    transportError(reason) {
      if (!this.isActive()) return this._events(this._event("ignored", { reason: "inactive-transport-error" }));
      return this._retry(reason || "transport-error");
    }

    cancel(reason) {
      if (!this.isActive()) return this._events(this._event("ignored", { reason: "inactive-cancel" }));
      this.state = STATE.CANCELLED;
      return this._events(this._event("cancelled", { reason: reason || "cancelled" }));
    }

    _retry(reason) {
      this.lastFailure = reason;
      const retryKey = this._retryKey(reason);
      const maxRetries = this.retryLimits ? this.retryLimits[retryKey] : this.maxRetries;
      const retriesForKey = this.retryLimits ? (this.retryCounts[retryKey] || 0) : this.retriesUsed;
      if (retriesForKey >= maxRetries) {
        this.state = STATE.FAILED;
        return this._events(this._event("failed", {
          reason,
          retryKey,
          packetIndex: this.packetIndex,
          retriesUsed: this.retriesUsed,
          retriesForKey,
          maxRetries,
        }));
      }
      this.retriesUsed += 1;
      this.retryCounts[retryKey] = (this.retryCounts[retryKey] || 0) + 1;
      const failedPacketIndex = this.packetIndex;
      if (this.state === STATE.WAIT_TEXT_ACK && this.textRetryMode === "sameText") {
        const retrySameText = this._event("retry", {
          reason,
          failedPacketIndex,
          restartPacketIndex: failedPacketIndex,
          retriesUsed: this.retriesUsed,
          retriesForKey: this.retryCounts[retryKey],
          retryKey,
          maxRetries,
        });
        return this._events(retrySameText, this._event("send", {
          kind: "TEXT",
          bytes: this.packets[this.packetIndex].slice(),
          packetIndex: this.packetIndex,
          packetCount: this.packets.length,
          attempt: this.retriesUsed + 1,
        }));
      }
      this.packetIndex = 0;
      this.state = STATE.WAIT_LINK_ACK;
      const retry = this._event("retry", {
        reason,
        failedPacketIndex,
        restartPacketIndex: 0,
        retriesUsed: this.retriesUsed,
        retriesForKey: this.retryCounts[retryKey],
        retryKey,
        maxRetries,
      });
      return this._events(retry, this._sendControl("ENQ", CODE.ENQ));
    }

    _normalizeRetryLimits(value) {
      if (value == null) return null;
      if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("retryLimitsはオブジェクトで指定してください");
      const keys = ["linkResponse", "linkTimeout", "textResponse", "textTimeout", "other"];
      const result = {};
      for (const key of keys) {
        const fallback = key === "other" ? this.maxRetries : (value.other == null ? this.maxRetries : value.other);
        result[key] = value[key] == null ? integer(fallback, `${key}再送回数`, 0, 65535) : integer(value[key], `${key}再送回数`, 0, 65535);
      }
      return Object.freeze(result);
    }

    _retryKey(reason) {
      const link = this.state === STATE.WAIT_LINK_ACK;
      if (reason === "timeout") return link ? "linkTimeout" : "textTimeout";
      if (reason === "nak" || reason === "unexpected-control") return link ? "linkResponse" : "textResponse";
      return "other";
    }

    _sendControl(kind, value) {
      return this._event("send", {
        kind,
        bytes: [value],
        packetIndex: this.packetIndex,
        packetCount: this.packets.length,
        attempt: this.retriesUsed + 1,
      });
    }

    _event(type, details) {
      return Object.assign({ type, state: this.state }, details || {});
    }

    _events() {
      const events = Array.from(arguments);
      if (this.onEvent) events.forEach(event => this.onEvent(event));
      return events;
    }
  }

  const api = { CODE, STATE, SendHandshakeFSM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.HandshakeProtocol = api;

})(typeof window !== "undefined" ? window : globalThis);
