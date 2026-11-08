import { describe, expect, it } from "vitest";
import { Initiator } from "./noise";
import {
  Responder,
  hex,
  importStaticKey,
  randomStaticKey,
  toHex,
} from "./noiseResponder.testing";
import { PHONE_PROLOGUE } from "./protocol";
import vectors from "./noise.vectors.json";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Noise_IK_25519_AESGCM_SHA256", () => {
  it.each(vectors.vectors)(
    "follows the cacophony vector as the initiator and the responder",
    async (vector) => {
      const [first, second, ...transport] = vector.messages;
      const initiatorStatic = await importStaticKey(vector.init_static);
      const { handshake, message } = await Initiator.start({
        local: initiatorStatic,
        remote: hex(vector.init_remote_static),
        prologue: hex(vector.init_prologue),
        payload: hex(first.payload),
        ephemeral: await importStaticKey(vector.init_ephemeral),
      });
      expect(toHex(message)).toBe(first.ciphertext);

      const { responder, payload } = await Responder.read({
        local: await importStaticKey(vector.resp_static),
        prologue: hex(vector.resp_prologue),
        message,
      });
      expect(toHex(payload)).toBe(first.payload);
      expect(toHex(responder.remoteStatic)).toBe(
        toHex(initiatorStatic.publicKey),
      );
      const answer = await responder.write(
        hex(second.payload),
        await importStaticKey(vector.resp_ephemeral),
      );
      expect(toHex(answer.message)).toBe(second.ciphertext);

      const finished = await handshake.finish(answer.message);
      expect(toHex(finished.payload)).toBe(second.payload);
      expect(toHex(finished.transport.handshakeHash)).toBe(
        vector.handshake_hash,
      );
      expect(toHex(answer.transport.handshakeHash)).toBe(vector.handshake_hash);

      for (const [index, step] of transport.entries()) {
        const [sender, receiver] =
          index % 2 === 0
            ? [finished.transport, answer.transport]
            : [answer.transport, finished.transport];
        const sealed = await sender.seal(hex(step.payload));
        expect(toHex(sealed)).toBe(step.ciphertext);
        expect(toHex(await receiver.open(sealed))).toBe(step.payload);
      }
    },
  );

  it("rejects an answer from another server key", async () => {
    const server = await randomStaticKey();
    const impostor = await randomStaticKey();
    const { handshake, message } = await Initiator.start({
      local: await randomStaticKey(),
      remote: server.publicKey,
      prologue: PHONE_PROLOGUE,
      payload: encoder.encode("{}"),
    });
    await expect(
      Responder.read({ local: impostor, prologue: PHONE_PROLOGUE, message }),
    ).rejects.toThrow();
    const { responder } = await Responder.read({
      local: server,
      prologue: PHONE_PROLOGUE,
      message,
    });
    const answer = await responder.write(encoder.encode('{"ok":true}'));
    const tampered = answer.message.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(handshake.finish(tampered)).rejects.toThrow();
  });

  it("keeps the order of transport messages sent without waiting", async () => {
    const server = await randomStaticKey();
    const { handshake, message } = await Initiator.start({
      local: await randomStaticKey(),
      remote: server.publicKey,
      prologue: PHONE_PROLOGUE,
      payload: new Uint8Array(),
    });
    const { responder } = await Responder.read({
      local: server,
      prologue: PHONE_PROLOGUE,
      message,
    });
    const answer = await responder.write(new Uint8Array());
    const { transport } = await handshake.finish(answer.message);
    const sealed = await Promise.all(
      ["un", "deux", "trois"].map((word) =>
        transport.seal(encoder.encode(word)),
      ),
    );
    const opened = await Promise.all(
      sealed.map((part) => answer.transport.open(part)),
    );
    expect(opened.map((part) => decoder.decode(part))).toEqual([
      "un",
      "deux",
      "trois",
    ]);
  });
});
