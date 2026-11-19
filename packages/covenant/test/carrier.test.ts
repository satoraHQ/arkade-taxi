import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CSVMultisigTapscript } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
    CARRIER_ARTIFACT,
    CarrierAccountScript,
    CarrierLeaf,
    compileCarrier,
    type CarrierAccountParams,
} from "../src/carrier.js";

// The same seeds carrier_account_test.go derives its keys from.
const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const SERVER = key(1);
const EMULATOR = key(2);
const ASSET_TXID = new Uint8Array(32);
ASSET_TXID.set([0xa5, 0x5e, 0x70]);

const params = (over: Partial<CarrierAccountParams> = {}): CarrierAccountParams => ({
    ownerKey: key(3),
    lenderKey: key(4),
    loan: 330n,
    exitDelay: { value: 144n, type: "blocks" },
    assetId: { txid: ASSET_TXID, groupIndex: 0 },
    ...over,
});

const opts = (p: CarrierAccountParams = params()) => ({
    serverKey: SERVER,
    emulatorKey: EMULATOR,
    params: p,
    vtxoMinAmount: 330n,
});

const VECTORS = resolve(import.meta.dirname, "carrier-vectors.json");
const FUNCTIONS = ["deposit", "send", "close", "renew", "exit"] as const;

function vectors() {
    const s = new CarrierAccountScript(opts());
    return {
        serverKey: hex.encode(SERVER),
        emulatorKey: hex.encode(EMULATOR),
        arkade: Object.fromEntries(
            Object.entries(s.covenant).map(([name, script]) => [name, hex.encode(script)]),
        ),
        leaves: Object.fromEntries(FUNCTIONS.map((n, i) => [n, hex.encode(s.scripts[i]!)])),
        pkScript: hex.encode(s.pkScript),
    };
}

describe("carrier account", () => {
    it("builds the module the script uses from the committed artifact", () => {
        const onDisk = JSON.parse(
            readFileSync(resolve(import.meta.dirname, "../contracts/carrier_account.json"), "utf8"),
        );
        expect(CARRIER_ARTIFACT.contractName).toBe("CarrierAccount");
        expect(CARRIER_ARTIFACT.functions).toEqual(onDisk.functions);
        expect(CARRIER_ARTIFACT.constructorInputs).toEqual(onDisk.constructorInputs);
        expect(onDisk).not.toHaveProperty("updatedAt");
    });

    it("lays out five leaves in CarrierLeaf order, each from the artifact", () => {
        const s = new CarrierAccountScript(opts());
        const c = compileCarrier(params(), SERVER, EMULATOR);
        expect(s.scripts).toHaveLength(5);
        FUNCTIONS.forEach((name, i) =>
            expect(hex.encode(s.scripts[i]!), name).toBe(
                hex.encode(c.functionByName(name)!.leafScript),
            ),
        );
        expect(CarrierLeaf.Exit).toBe(4);
    });

    it("exits with the owner alone after the delay", () => {
        const s = new CarrierAccountScript(opts());
        expect(s.scripts[CarrierLeaf.Exit]).toEqual(
            CSVMultisigTapscript.encode({
                timelock: params().exitDelay,
                pubkeys: [params().ownerKey],
            }).script,
        );
    });

    it("is deterministic and moves the address with every bound param", () => {
        const base = new CarrierAccountScript(opts()).pkScript;
        expect(new CarrierAccountScript(opts()).pkScript).toEqual(base);
        for (const over of [
            { ownerKey: key(9) },
            { lenderKey: key(9) },
            { loan: 400n },
            { exitDelay: { value: 288n, type: "blocks" } },
            { assetId: { txid: new Uint8Array(32).fill(1), groupIndex: 0 } },
            { assetId: { txid: ASSET_TXID, groupIndex: 1 } },
        ] as Partial<CarrierAccountParams>[])
            expect(new CarrierAccountScript(opts(params(over))).pkScript).not.toEqual(base);
    });

    it("refuses unsafe params", () => {
        for (const [over, msg] of [
            [{ lenderKey: key(3) }, "must differ"],
            [{ loan: 329n }, "below the minimum"],
            [{ ownerKey: new Uint8Array(31) }, "32 bytes"],
            [{ assetId: { txid: new Uint8Array(31), groupIndex: 0 } }, "asset txid"],
            [{ assetId: { txid: ASSET_TXID, groupIndex: -1 } }, "group index"],
        ] as [Partial<CarrierAccountParams>, string][])
            expect(() => new CarrierAccountScript(opts(params(over)))).toThrow(msg);
    });

    // The Go engine test assembles its own scripts from the artifact and asserts
    // them against this file, so the builder and the executed bytes cannot drift.
    it("matches the committed vectors", () => {
        if (process.env.CARRIER_VECTORS_WRITE)
            writeFileSync(VECTORS, `${JSON.stringify(vectors(), null, 2)}\n`);
        expect(vectors()).toEqual(JSON.parse(readFileSync(VECTORS, "utf8")));
    });
});
