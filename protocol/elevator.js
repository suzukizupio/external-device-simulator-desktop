// Q46-005J elevator interworking telegram codec (Ver.1.25).
// Browser: window.ElevatorProtocol / Node: require("./protocol/elevator.js")
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ElevatorProtocol = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE = Object.freeze({ NULL: 0x00, STX: 0x02, ETX: 0x03, ENQ: 0x05, ACK: 0x06, NAK: 0x15 });
  const DIRECTION = Object.freeze({ TO_ELEVATOR: "toElevator", FROM_ELEVATOR: "fromElevator" });
  const COMMAND = Object.freeze({
    ECALL: "ECALL",
    HINFO: "HINFO",
    GINFO: "GINFO",
    KINFO: "KINFO",
    COPEN: "COPEN",
    CCLSE: "CCLSE",
    EOPEN: "EOPEN",
    ECLSE: "ECLSE",
    INITI: "INITI",
    ESTAT: "ESTAT",
    ESTOP: "ESTOP",
    INITE: "INITE",
    CHECK: "CHECK",
  });
  const PROFILE = Object.freeze({
    FULL: "full",
    DASH_VHX: "dash-vhx",
    DASH_WISM: "dash-wism",
    V_FINE_VBZ: "v-fine-vbz",
    FAGUS: "fagus",
    VIXUS: "vixus",
    VIXUS_1PR: "vixus-1pr",
    VIXUS_ADVANCE: "vixus-advance",
    DEARIS: "dearis",
  });

  const TO_ELEVATOR = Object.freeze([
    COMMAND.ECALL, COMMAND.HINFO, COMMAND.GINFO, COMMAND.KINFO,
    COMMAND.COPEN, COMMAND.CCLSE, COMMAND.EOPEN, COMMAND.ECLSE, COMMAND.INITI,
  ]);
  const FROM_ELEVATOR = Object.freeze([
    COMMAND.ESTAT, COMMAND.ESTOP, COMMAND.INITI, COMMAND.INITE, COMMAND.CHECK,
  ]);
  const V_FINE_TO = Object.freeze([
    COMMAND.HINFO, COMMAND.GINFO, COMMAND.KINFO, COMMAND.EOPEN, COMMAND.ECLSE, COMMAND.INITI,
  ]);
  const V_FINE_FROM = Object.freeze([COMMAND.INITI, COMMAND.INITE, COMMAND.CHECK]);

  const COMMAND_META = Object.freeze({
    ECALL: Object.freeze({ gate: false, room: true, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    HINFO: Object.freeze({ gate: true, room: true, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    GINFO: Object.freeze({ gate: true, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    KINFO: Object.freeze({ gate: true, room: true, person: true, directions: [DIRECTION.TO_ELEVATOR] }),
    COPEN: Object.freeze({ gate: true, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    CCLSE: Object.freeze({ gate: true, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    EOPEN: Object.freeze({ gate: true, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    ECLSE: Object.freeze({ gate: true, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR] }),
    INITI: Object.freeze({ gate: false, room: false, person: false, directions: [DIRECTION.TO_ELEVATOR, DIRECTION.FROM_ELEVATOR] }),
    ESTAT: Object.freeze({ gate: false, room: true, person: false, directions: [DIRECTION.FROM_ELEVATOR] }),
    ESTOP: Object.freeze({ gate: false, room: true, person: false, directions: [DIRECTION.FROM_ELEVATOR] }),
    INITE: Object.freeze({ gate: false, room: false, person: false, directions: [DIRECTION.FROM_ELEVATOR] }),
    CHECK: Object.freeze({ gate: false, room: false, person: false, directions: [DIRECTION.FROM_ELEVATOR] }),
  });

  const PROFILE_CONFIG = Object.freeze({
    full: Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    "dash-vhx": Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    "dash-wism": Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    "v-fine-vbz": Object.freeze({ to: V_FINE_TO, from: V_FINE_FROM, managementMax: 9 }),
    fagus: Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    vixus: Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    "vixus-1pr": Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
    "vixus-advance": Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 99 }),
    dearis: Object.freeze({ to: TO_ELEVATOR, from: FROM_ELEVATOR, managementMax: 9 }),
  });

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function integer(value, min, max, name) {
    let number = value;
    if (typeof value === "string" && /^\d+$/.test(value)) number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new RangeError(name + " must be an integer from " + min + " to " + max);
    }
    return number;
  }

  function bytes(value, name) {
    if (value == null || typeof value.length !== "number") throw new TypeError(name + " must be byte array-like");
    const result = Array.from(value);
    result.forEach(function (byte, index) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xFF) {
        throw new RangeError(name + "[" + index + "] is not a byte");
      }
    });
    return result;
  }

  function digits(number, width) {
    return String(number).padStart(width, "0");
  }

  function ascii(value) {
    return Array.from(value, function (character) { return character.charCodeAt(0); });
  }

  function asciiText(value, name) {
    const result = String.fromCharCode.apply(null, value);
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] < 0x20 || value[index] > 0x7E) throw new Error(name + " contains non-ASCII data");
    }
    return result;
  }

  function resolveProfile(profile) {
    const name = profile == null ? PROFILE.FULL : profile;
    if (!own(PROFILE_CONFIG, name)) throw new RangeError("unknown elevator profile: " + name);
    return { name: name, config: PROFILE_CONFIG[name] };
  }

  function resolveDirection(direction) {
    if (direction == null) return null;
    if (direction !== DIRECTION.TO_ELEVATOR && direction !== DIRECTION.FROM_ELEVATOR) {
      throw new RangeError("unknown elevator direction: " + direction);
    }
    return direction;
  }

  function resolveCommand(command) {
    if (typeof command !== "string" || !own(COMMAND_META, command)) {
      throw new RangeError("unknown elevator command: " + command);
    }
    return command;
  }

  function assertProfileCommand(command, profile, direction) {
    const config = resolveProfile(profile);
    const requestedDirection = resolveDirection(direction);
    const allowedTo = config.config.to.indexOf(command) !== -1;
    const allowedFrom = config.config.from.indexOf(command) !== -1;
    if (requestedDirection === DIRECTION.TO_ELEVATOR && !allowedTo) {
      throw new Error(command + " is not supported toward the elevator by profile " + config.name);
    }
    if (requestedDirection === DIRECTION.FROM_ELEVATOR && !allowedFrom) {
      throw new Error(command + " is not supported from the elevator by profile " + config.name);
    }
    if (requestedDirection == null && !allowedTo && !allowedFrom) {
      throw new Error(command + " is not supported by profile " + config.name);
    }
    return config;
  }

  function formatGate(value) {
    if (value == null) return "0000";
    if (typeof value === "string") {
      if (!/^\d{4}$/.test(value)) throw new RangeError("gate must contain exactly four decimal digits");
      return value;
    }
    if (typeof value === "number") {
      return "00" + digits(integer(value, 0, 99, "gate id"), 2);
    }
    if (typeof value !== "object") throw new TypeError("gate must be a string, number, or object");
    const buildingNo = integer(value.buildingNo == null ? 0 : value.buildingNo, 0, 99, "gate building number");
    const idValue = value.id == null ? (value.gateNo == null ? 0 : value.gateNo) : value.id;
    const id = integer(idValue, 0, 99, "gate id");
    return digits(buildingNo, 2) + digits(id, 2);
  }

  function parseGate(value) {
    const raw = formatGate(value);
    return { raw: raw, buildingNo: Number(raw.slice(0, 2)), id: Number(raw.slice(2, 4)) };
  }

  function validateRoomRaw(raw, profile) {
    if (!/^\d{2}[0-9BC][0-9]{3}$/.test(raw)) {
      throw new RangeError("room must be six characters: building(2) plus Bddd, dddd, or Cddd");
    }
    if (raw === "000000") return raw;
    const suffix = raw.slice(2);
    if (suffix[0] === "B") {
      integer(suffix.slice(1), 1, 999, "three-digit room number");
    } else if (suffix[0] === "C") {
      const config = resolveProfile(profile).config;
      integer(suffix.slice(1), 1, config.managementMax, "management room number");
    } else {
      integer(suffix, 1000, 9999, "four-digit room number");
    }
    return raw;
  }

  function formatRoom(value, profile) {
    if (value == null) return "000000";
    if (typeof value === "string") return validateRoomRaw(value, profile);
    if (typeof value === "number") value = { roomNo: value };
    if (typeof value !== "object") throw new TypeError("room must be a string, number, or object");
    const buildingNo = integer(value.buildingNo == null ? 0 : value.buildingNo, 0, 99, "room building number");
    if (value.managementNo != null) {
      const maximum = resolveProfile(profile).config.managementMax;
      const managementNo = integer(value.managementNo, 1, maximum, "management room number");
      return digits(buildingNo, 2) + "C" + digits(managementNo, 3);
    }
    const roomNo = integer(value.roomNo == null ? 0 : value.roomNo, 0, 9999, "room number");
    if (roomNo === 0) {
      if (buildingNo !== 0) throw new RangeError("zero room number requires building number zero");
      return "000000";
    }
    if (roomNo < 1000) return digits(buildingNo, 2) + "B" + digits(roomNo, 3);
    return digits(buildingNo, 2) + digits(roomNo, 4);
  }

  function parseRoom(value, profile) {
    const raw = formatRoom(value, profile);
    const buildingNo = Number(raw.slice(0, 2));
    const suffix = raw.slice(2);
    if (raw === "000000") return { raw: raw, buildingNo: 0, kind: "none", number: 0 };
    if (suffix[0] === "C") return { raw: raw, buildingNo: buildingNo, kind: "management", number: Number(suffix.slice(1)) };
    return {
      raw: raw,
      buildingNo: buildingNo,
      kind: "dwelling",
      number: Number(suffix[0] === "B" ? suffix.slice(1) : suffix),
    };
  }

  function formatPerson(value) {
    if (value == null) return "000";
    if (typeof value === "string") {
      if (!/^\d{3}$/.test(value)) throw new RangeError("person must contain exactly three decimal digits");
      return value;
    }
    return digits(integer(value, 0, 999, "person number"), 3);
  }

  function calculateBCC(frameWithoutBcc) {
    const frame = bytes(frameWithoutBcc, "frameWithoutBcc");
    if (frame.length < 2 || frame[0] !== CODE.STX) throw new Error("BCC input must start with STX");
    let bcc = 0;
    for (let index = 1; index < frame.length; index += 1) bcc ^= frame[index];
    return bcc & 0xFF;
  }

  function verifyBCC(frame) {
    try {
      const packet = bytes(frame, "frame");
      if (packet.length < 3 || packet[0] !== CODE.STX) return false;
      return calculateBCC(packet.slice(0, -1)) === packet[packet.length - 1];
    } catch (_error) {
      return false;
    }
  }

  function gateOption(options) {
    if (own(options, "gate")) return options.gate;
    return {
      buildingNo: own(options, "gateBuildingNo") ? options.gateBuildingNo : (options.buildingNo == null ? 0 : options.buildingNo),
      id: own(options, "gateId") ? options.gateId : (options.gateNo == null ? 0 : options.gateNo),
    };
  }

  function roomOption(options) {
    if (own(options, "room")) return options.room;
    const result = {
      buildingNo: own(options, "roomBuildingNo") ? options.roomBuildingNo : (options.buildingNo == null ? 0 : options.buildingNo),
    };
    if (own(options, "managementNo")) result.managementNo = options.managementNo;
    else result.roomNo = options.roomNo == null ? 0 : options.roomNo;
    return result;
  }

  function assertUnusedFields(command, gate, room, person) {
    const meta = COMMAND_META[command];
    if (!meta.gate && gate !== "0000") throw new Error(command + " requires gate 0000");
    if (!meta.room && room !== "000000") throw new Error(command + " requires room 000000");
    if (!meta.person && person !== "000") throw new Error(command + " requires person 000");
  }

  function buildFrame(options) {
    if (options == null || typeof options !== "object") throw new TypeError("options are required");
    const command = resolveCommand(options.command);
    const profile = assertProfileCommand(command, options.profile, options.direction);
    const gate = formatGate(gateOption(options));
    const room = formatRoom(roomOption(options), profile.name);
    const person = formatPerson(own(options, "person") ? options.person : options.personNo);
    assertUnusedFields(command, gate, room, person);

    const frame = [CODE.STX].concat(ascii(command + gate + room + person), [CODE.ETX]);
    if (frame.length !== 20) throw new Error("internal elevator frame length error");
    frame.push(calculateBCC(frame));
    return frame;
  }

  function parseFrame(value, options) {
    options = options || {};
    const frame = bytes(value, "frame");
    if (frame.length !== 21) throw new Error("elevator frame must be exactly 21 bytes");
    if (frame[0] !== CODE.STX) throw new Error("invalid elevator STX");
    if (frame[19] !== CODE.ETX) throw new Error("invalid elevator ETX");
    if (!verifyBCC(frame)) throw new Error("invalid elevator BCC");

    const command = resolveCommand(asciiText(frame.slice(1, 6), "command"));
    const profile = assertProfileCommand(command, options.profile, options.direction);
    const gate = parseGate(asciiText(frame.slice(6, 10), "gate"));
    const room = parseRoom(asciiText(frame.slice(10, 16), "room"), profile.name);
    const personRaw = asciiText(frame.slice(16, 19), "person");
    const person = integer(personRaw, 0, 999, "person number");
    assertUnusedFields(command, gate.raw, room.raw, personRaw);

    return {
      command: command,
      directions: COMMAND_META[command].directions.slice(),
      profile: profile.name,
      gate: gate,
      room: room,
      person: person,
      personRaw: personRaw,
      bcc: frame[20],
      bytes: frame.slice(),
    };
  }

  function validateFrame(frame, options) {
    try {
      parseFrame(frame, options);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function toHex(value) {
    return bytes(value, "value").map(function (byte) { return byte.toString(16).toUpperCase().padStart(2, "0"); }).join(" ");
  }

  return Object.freeze({
    CODE: CODE,
    DIRECTION: DIRECTION,
    COMMAND: COMMAND,
    COMMAND_META: COMMAND_META,
    PROFILE: PROFILE,
    formatGate: formatGate,
    parseGate: parseGate,
    formatRoom: formatRoom,
    parseRoom: parseRoom,
    formatPerson: formatPerson,
    calculateBCC: calculateBCC,
    calcBCC: calculateBCC,
    verifyBCC: verifyBCC,
    build: buildFrame,
    buildFrame: buildFrame,
    buildTelegram: buildFrame,
    parse: parseFrame,
    parseFrame: parseFrame,
    parseTelegram: parseFrame,
    validate: validateFrame,
    validateFrame: validateFrame,
    toHex: toHex,
  });
});
