(function (global) {
  "use strict";

  class PacketSeries {
    constructor() {
      this.reset();
    }

    reset() {
      this.active = false;
      this.type = null;
      this.modelNo = null;
      this.expectedPackage = null;
      this.packetCount = 0;
    }

    snapshot() {
      return Object.freeze({
        active: this.active,
        type: this.type,
        modelNo: this.modelNo,
        expectedPackage: this.expectedPackage,
        packetCount: this.packetCount,
      });
    }

    accept(packet) {
      if (!packet || (packet.type !== "request" && packet.type !== "response")) throw new TypeError("parsed locker4 packet is required");
      if (!Number.isInteger(packet.packageNo) || packet.packageNo < 0 || packet.packageNo > 99) throw new RangeError("packageNo is invalid");
      if (!this.active) {
        this.active = true;
        this.type = packet.type;
        this.modelNo = packet.modelNo;
        this.expectedPackage = packet.packageNo;
      }
      if (packet.type !== this.type || packet.modelNo !== this.modelNo || packet.packageNo !== this.expectedPackage) {
        this.reset();
        throw new Error("4線式パケット列のpackageNo／機種No／方向が連続していません");
      }
      this.packetCount += 1;
      this.expectedPackage -= 1;
      return this.snapshot();
    }

    finish() {
      const result = this.snapshot();
      this.reset();
      if (!result.active || result.expectedPackage >= 0) throw new Error("4線式パケット列が未完了です");
      return Object.freeze({ type: result.type, modelNo: result.modelNo, packetCount: result.packetCount });
    }

    abort() {
      this.reset();
    }
  }

  const api = Object.freeze({ PacketSeries });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Locker4Receiver = api;
})(typeof window !== "undefined" ? window : globalThis);
