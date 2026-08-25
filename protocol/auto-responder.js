// 受信した要求電文に対し、通信仕様で応答内容が確定しているものだけを組み立てる。
// 業務データに依存する一括応答やペイロードは生成せず、その旨を呼び出し側へ返す。
//   Q48-008I: KIND/CMD台帳の responseTo で応答コマンドが確定する要求
//   Q46-005J: 4.5.1 ⑨⑩⑪ エレベータコール受信時の動作／停止情報
//   Q48-005F: 情報要求に対する情報応答（ロッカーデータは呼び出し側が与える）
// Browser: window.AutoResponder / Node: require("./auto-responder.js")
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./mansion-controller.js"),
      require("./elevator.js"),
      require("./locker4.js")
    );
  } else {
    root.AutoResponder = factory(root.MansionController, root.ElevatorProtocol, root.Telegram4);
  }
})(typeof window !== "undefined" ? window : globalThis, function (MansionController, ElevatorProtocol, Telegram4) {
  "use strict";

  if (!MansionController || !ElevatorProtocol || !Telegram4) {
    throw new Error("AutoResponder requires MansionController, ElevatorProtocol and Telegram4");
  }

  const ROLE = MansionController.ROLE;
  const COMMAND_TYPE = MansionController.COMMAND_TYPE;
  const DIRECTION = ElevatorProtocol.DIRECTION;

  function latin1Bytes(text, name) {
    return Array.from(String(text == null ? "" : text), (character) => {
      const code = character.charCodeAt(0);
      if (code > 0xFF) throw new RangeError(`${name}に1バイトで表せない文字「${character}」があります`);
      return code;
    });
  }

  function unsupported(reason, definition) {
    return { type: "unsupported", reason, definition: definition || null };
  }

  function peerRole(role) {
    return role === ROLE.IC ? ROLE.MC : ROLE.IC;
  }

  function canSend(definition, options) {
    try {
      MansionController.getCommandDefinition(definition.kind, definition.command, {
        version: options.version,
        from: options.role,
        product: options.product,
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  // 受信MESGの先頭6バイトがADDRとして成立するときだけ、応答へ引き継ぐ。
  function inheritedAddress(parsed, options) {
    if (parsed.message.length < 6) return "";
    const candidate = parsed.messageText.slice(0, 6);
    try {
      MansionController.validateAddress(candidate, {
        version: options.version,
        topology: options.topology,
        vixusAdvance: options.product === MansionController.PRODUCT.VIXUS_ADVANCE,
      });
      return candidate;
    } catch (_error) {
      return "";
    }
  }

  function mansionResponse(frame, options) {
    const opts = options || {};
    const role = opts.role === ROLE.MC ? ROLE.MC : ROLE.IC;
    const parsed = MansionController.validateFrame(frame, {
      version: opts.version,
      from: peerRole(role),
      product: opts.product,
    });
    const request = parsed.commandDefinition || MansionController.findCommandDefinition(parsed.kind, parsed.command);
    if (!request) return unsupported("台帳にないKIND/CMDです");
    if (request.type !== COMMAND_TYPE.REQUEST) return null;

    const candidates = MansionController.COMMAND_REGISTRY.filter((definition) =>
      definition.kind === request.kind &&
      definition.responseTo === request.command &&
      (definition.type === COMMAND_TYPE.RESPONSE || definition.type === COMMAND_TYPE.COMPLETION) &&
      (opts.version == null || definition.versions.includes(opts.version)) &&
      canSend(definition, { version: opts.version, role, product: opts.product }));
    // 応答電文があればそれを返し、初期化要求のように応答が完了電文しかない場合はそれを使う。
    const answer = candidates.find((definition) => definition.type === COMMAND_TYPE.RESPONSE) ||
      candidates.find((definition) => definition.type === COMMAND_TYPE.COMPLETION && !definition.bulk) || null;
    // 一括応答は分割数と業務データが仕様だけでは決まらないため生成しない。
    if (!answer) {
      const bulk = candidates.find((definition) => definition.bulk);
      if (bulk) return unsupported(`${bulk.name}は業務データが必要なため自動生成しません`, bulk);
      return unsupported(`${request.name}に対する応答コマンドが台帳にありません`, request);
    }
    if (answer.bulk) return unsupported(`${answer.name}は業務データが必要なため自動生成しません`, answer);

    const address = opts.keepAddress === false ? "" : inheritedAddress(parsed, opts);
    const message = latin1Bytes(address + (opts.message == null ? "" : opts.message), "MESG");
    return {
      type: "frame",
      frame: MansionController.buildFrame({
        kind: answer.kind,
        command: answer.command,
        message,
        version: opts.version,
        from: role,
        product: opts.product,
      }),
      definition: answer,
      request,
      address,
    };
  }

  // Q46-005J 4.5.1 ⑨⑩⑪：エレベータコールに対し、動作中はESTAT、停止中はESTOPを
  // 同じルーム番号で返す。他のコマンドは片方向通知のため応答を作らない。
  function elevatorResponse(frame, options) {
    const opts = options || {};
    const parsed = ElevatorProtocol.parseFrame(frame, {
      profile: opts.profile,
      direction: DIRECTION.TO_ELEVATOR,
    });
    if (parsed.command !== "ECALL") return null;
    const command = opts.moving === false ? "ESTOP" : "ESTAT";
    return {
      type: "frame",
      frame: ElevatorProtocol.buildFrame({
        command,
        profile: opts.profile,
        direction: DIRECTION.FROM_ELEVATOR,
        gate: "0000",
        room: parsed.room.raw,
        person: "000",
      }),
      command,
      request: parsed,
    };
  }

  // Q48-005F：情報要求を受けたときだけ応答パケットを組む。
  // ロッカーデータは装置の状態そのものなので、呼び出し側から受け取る。
  function locker4Response(frame, options) {
    const opts = options || {};
    const parsed = Telegram4.parseTelegram(frame);
    if (parsed.type !== "request") return null;
    if (!Array.isArray(opts.lockers) || opts.lockers.length === 0) {
      return unsupported("応答するロッカーデータが1件も設定されていません");
    }
    const modelNo = opts.modelNo == null ? parsed.modelNo : opts.modelNo;
    if (modelNo == null) return unsupported("機種NOが空白のため応答電文を生成できません");
    return {
      type: "frames",
      frames: Telegram4.buildResponsePackets({
        modelNo,
        packetSize: opts.packetSize,
        lockers: opts.lockers,
      }),
      request: parsed,
    };
  }

  return Object.freeze({
    mansionResponse,
    elevatorResponse,
    locker4Response,
  });
});
