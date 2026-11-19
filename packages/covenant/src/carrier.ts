import { arkade, timelockToSequence, VtxoScript, type RelativeTimelock } from "@arkade-os/sdk";
import { PubT, validatePubkey } from "@scure/btc-signer/utils.js";
import { CARRIER_ARTIFACT } from "./carrier-account-artifact.js";
import type { AssetIdRef } from "./params.js";

export { CARRIER_ARTIFACT };

/** Order fixes the merkle root, so it is part of the address. Do not reorder. */
export enum CarrierLeaf {
    Deposit = 0,
    Send = 1,
    Close = 2,
    Renew = 3,
    Exit = 4,
}

export interface CarrierAccountParams {
    ownerKey: Uint8Array;
    lenderKey: Uint8Array;
    /** Sats the lender fronted; `send` keeps at least this, `close` repays exactly it. */
    loan: bigint;
    /** CSV on the owner-only exit, relative to the unroll confirmation. */
    exitDelay: RelativeTimelock;
    /** One asset per account; a second asset is never guarded by `deposit`. */
    assetId: AssetIdRef;
}

export interface CarrierAccountOptions {
    serverKey: Uint8Array;
    emulatorKey: Uint8Array;
    params: CarrierAccountParams;
    vtxoMinAmount: bigint;
}

export type CarrierScripts = {
    deposit: Uint8Array;
    send: Uint8Array;
    close: Uint8Array;
    renew: Uint8Array;
};

type Compiled = InstanceType<typeof arkade.ArkadeProgramScript>;
type Args = ConstructorParameters<typeof arkade.ArkadeProgramScript>[1];

let program: ReturnType<typeof arkade.programFromArtifact> | undefined;

export function validateCarrierParams(p: CarrierAccountParams, vtxoMinAmount: bigint): void {
    for (const [name, k] of [
        ["owner", p.ownerKey],
        ["lender", p.lenderKey],
    ] as const) {
        if (k?.length !== 32)
            throw new Error(`carrier: ${name} key must be 32 bytes, got ${k?.length ?? 0}`);
        validatePubkey(k, PubT.schnorr);
    }
    // Owner == lender would let `close` repay the owner to themself.
    if (p.ownerKey.every((b, i) => b === p.lenderKey[i]))
        throw new Error("carrier: owner and lender keys must differ");
    if (p.loan < vtxoMinAmount)
        throw new Error(`carrier: loan ${p.loan} is below the minimum ${vtxoMinAmount}`);
    if (p.assetId?.txid?.length !== 32) throw new Error("carrier: asset txid must be 32 bytes");
    if (!Number.isInteger(p.assetId.groupIndex) || p.assetId.groupIndex < 0)
        throw new Error("carrier: asset group index must be a non-negative integer");
    timelockToSequence(p.exitDelay);
}

export function carrierArgs(p: CarrierAccountParams, serverKey: Uint8Array): Args {
    return {
        ownerKey: p.ownerKey,
        lenderKey: p.lenderKey,
        loan: p.loan,
        exitDelay: BigInt(timelockToSequence(p.exitDelay)),
        assetTxid: p.assetId.txid,
        assetGidx: BigInt(p.assetId.groupIndex),
        server: serverKey,
    };
}

export const compileCarrier = (
    p: CarrierAccountParams,
    serverKey: Uint8Array,
    emulatorKey: Uint8Array,
): Compiled =>
    new arkade.ArkadeProgramScript(
        (program ??= arkade.programFromArtifact(CARRIER_ARTIFACT)),
        carrierArgs(p, serverKey),
        { serverKey, emulatorKey },
    );

function fromArtifact(o: CarrierAccountOptions) {
    validateCarrierParams(o.params, o.vtxoMinAmount);
    const compiled = compileCarrier(o.params, o.serverKey, o.emulatorKey);
    const fn = (name: string) => {
        const f = compiled.functionByName(name);
        if (!f) throw new Error(`carrier: artifact declares no ${name}`);
        return f;
    };
    const covenant = (name: keyof CarrierScripts) => {
        const script = fn(name).arkadeScript;
        if (!script) throw new Error(`carrier: ${name} carries no arkade script`);
        return script;
    };
    return {
        covenant: {
            deposit: covenant("deposit"),
            send: covenant("send"),
            close: covenant("close"),
            renew: covenant("renew"),
        },
        scripts: ["deposit", "send", "close", "renew", "exit"].map((n) => fn(n).leafScript),
    };
}

/** A carrier account: the lender's sats carry the owner's asset across payments. */
export class CarrierAccountScript extends VtxoScript {
    readonly covenant: CarrierScripts;

    constructor(readonly options: CarrierAccountOptions) {
        const tree = fromArtifact(options);
        super(tree.scripts);
        this.covenant = tree.covenant;
    }
}
