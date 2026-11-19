import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
    ArkAddress,
    CSVMultisigTapscript,
    EmulatorPacket,
    EsploraProvider,
    Batch,
    Extension,
    Intent,
    InMemoryContractRepository,
    InMemoryIntentRepository,
    InMemoryVirtualTxRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Transaction,
    Wallet,
    arkade,
    asset,
    attachPrevArkTxs,
    buildOffchainTx,
    configureEventSource,
    networks,
    withPrevTxs,
    type ExtendedVirtualCoin,
    type Identity,
    type SignerSession,
    type TapLeafScript,
    type VirtualCoin,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import {
    CarrierAccountScript,
    CarrierLeaf,
    type CarrierAccountParams,
} from "../../packages/covenant/src/index.js";

const { AssetGroup, AssetId, AssetInput, AssetOutput, Packet } = asset;

if (!globalThis.EventSource) throw new Error("run with --experimental-eventsource");
configureEventSource((url) => new EventSource(url));

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(ROOT, ".reference/arkade-regtest/regtest.mjs");
const ENV = resolve(import.meta.dirname, "carrier.env");
const env = Object.fromEntries(
    readFileSync(ENV, "utf8")
        .split("\n")
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => line.split("=", 2) as [string, string]),
);
const ARKD = `http://localhost:${env.ARKD_PORT}`;
const ESPLORA = `http://localhost:${env.MEMPOOL_WEB_PORT}/api`;
const EMULATOR = `http://localhost:${env.EMULATOR_PORT}`;
const LOAN = 330n;

const regtest = (command: string, ...args: string[]) =>
    execFileSync(process.execPath, [CLI, command, "--env", ENV, ...args], {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 120_000,
    }).toString();

const ark = new RestArkProvider(ARKD);
const indexer = new RestIndexerProvider(ARKD);
const emulator = new RestEmulatorProvider(EMULATOR);

type Actor = { identity: SingleKey; wallet: Wallet; key: Uint8Array; address: string };

async function actor(): Promise<Actor> {
    const identity = SingleKey.fromHex(randomBytes(32).toString("hex"));
    const wallet = await Wallet.create({
        identity,
        arkProvider: ark,
        indexerProvider: indexer,
        onchainProvider: new EsploraProvider(ESPLORA),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
            intentRepository: new InMemoryIntentRepository(),
            virtualTxRepository: new InMemoryVirtualTxRepository(),
        },
        settlementConfig: false,
    });
    return {
        identity,
        wallet,
        key: await identity.xOnlyPublicKey(),
        address: await wallet.getAddress(),
    };
}

async function poll<T>(label: string, read: () => Promise<T>, ready: (v: T) => boolean) {
    const deadline = Date.now() + 60_000;
    for (;;) {
        const value = await read();
        if (ready(value)) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

const units = (coin: VirtualCoin, id: string) =>
    coin.assets?.find((a) => a.assetId === id)?.amount ?? 0n;

async function coinAt(txid: string, vout: number): Promise<VirtualCoin> {
    const { vtxos } = await poll(
        `${txid}:${vout}`,
        () => indexer.getVtxos({ outpoints: [{ txid, vout }] }),
        (r) => r.vtxos.length === 1,
    );
    return vtxos[0]!;
}

async function fund(who: Actor, sats: number): Promise<ExtendedVirtualCoin> {
    regtest("ark", "send", "--to", who.address, "--amount", String(sats), "--password", "secret");
    const coins = await poll(
        `${sats} sats for ${who.address}`,
        () => who.wallet.getSpendableVtxos(),
        (cs) => cs.some((c) => c.value === sats && !c.assets?.length),
    );
    return coins.find((c) => c.value === sats && !c.assets?.length)!;
}

type Input = {
    txid: string;
    vout: number;
    value: number;
    tapTree: Uint8Array;
    tapLeafScript: TapLeafScript;
};

const walletInput = (coin: ExtendedVirtualCoin): Input => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: coin.tapTree,
    tapLeafScript: coin.forfeitTapLeafScript,
});

const accountInput = (
    account: CarrierAccountScript,
    leaf: CarrierLeaf,
    coin: VirtualCoin,
): Input => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: account.encode(),
    tapLeafScript: account.findLeaf(hex.encode(account.scripts[leaf]!)),
});

type Spend = {
    inputs: Input[];
    outputs: { script: Uint8Array; amount: bigint }[];
    /** Units of the carried asset per input and output index; zero is absent. */
    assetIn: bigint[];
    assetOut: bigint[];
    covenants: { vin: number; script: Uint8Array }[];
    signers: { actor: Actor; vins: number[] }[];
};

let assetId = "";

const packetFor = (assetIn: bigint[], assetOut: bigint[]) =>
    Packet.create([
        AssetGroup.create(
            AssetId.fromString(assetId),
            null,
            assetIn.flatMap((u, vin) => (u > 0n ? [AssetInput.create(vin, u)] : [])),
            assetOut.flatMap((u, vout) => (u > 0n ? [AssetOutput.create(vout, u)] : [])),
            [],
        ),
    ]);

// The renew leaf is [server, emulator:renew]: nobody holds a key on it, so the
// forfeit's signatures are injected by the emulator and arkd, never by us.
const injectedSignaturesOnly = (session: SignerSession): Identity => ({
    sign: async (tx: Transaction) => tx,
    signerSession: () => session,
    signMessage: async () => new Uint8Array(),
    compressedPublicKey: async () => new Uint8Array(33),
    xOnlyPublicKey: async () => new Uint8Array(32),
});

/** Builds the graph, signs the human inputs, and has the emulator co-sign and submit it. */
async function submit(spend: Spend): Promise<string> {
    const packet = packetFor(spend.assetIn, spend.assetOut);
    const extension = Extension.create([packet, EmulatorPacket.create(spend.covenants)]).txOut();
    const info = await ark.getInfo();
    const unroll = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
    const graph = buildOffchainTx(spend.inputs, [...spend.outputs, extension], unroll);
    await attachPrevArkTxs(
        graph.arkTx,
        spend.inputs.map((i) => i.txid),
        indexer,
    );
    let arkTx = graph.arkTx;
    const checkpoints = [...graph.checkpoints];
    for (const { actor: who, vins } of spend.signers) {
        arkTx = await who.identity.sign(arkTx, vins);
        for (const vin of vins) checkpoints[vin] = await who.identity.sign(checkpoints[vin]!, [0]);
    }
    const signed = await emulator.submitTx(
        base64.encode(arkTx.toPSBT()),
        checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    return Transaction.fromPSBT(base64.decode(signed.signedArkTx)).id;
}

describe("carrier account on a live arkd + emulator", () => {
    let serverKey: Uint8Array;
    let emulatorKey: Uint8Array;
    let hrp: string;
    let alice: Actor, bob: Actor, carol: Actor, lender: Actor;
    let aliceAccount: CarrierAccountScript, carolAccount: CarrierAccountScript;
    let aliceCoin: VirtualCoin, carolCoin: VirtualCoin;

    const account = (owner: Actor) => {
        const params: CarrierAccountParams = {
            ownerKey: owner.key,
            // A payout destination: the lender's own wallet output key, so
            // the repaid loan lands as a coin its wallet can spend.
            lenderKey: ArkAddress.decode(lender.address).vtxoTaprootKey,
            loan: LOAN,
            exitDelay: { type: "seconds", value: 86_016n },
            assetId: {
                txid: Uint8Array.from(hex.decode(assetId.slice(0, 64))).reverse(),
                groupIndex: AssetId.fromString(assetId).groupIndex,
            },
        };
        return new CarrierAccountScript({ serverKey, emulatorKey, params, vtxoMinAmount: 1n });
    };

    const open = async (script: CarrierAccountScript): Promise<VirtualCoin> => {
        const address = script.address(hrp, serverKey).encode();
        const txid = await lender.wallet.send({ address, amount: Number(LOAN) });
        const tx = await poll(
            `account funding ${txid}`,
            () => indexer.getVtxos({ scripts: [hex.encode(script.pkScript)] }),
            (r) => r.vtxos.some((c) => c.txid === txid),
        );
        return tx.vtxos.find((c) => c.txid === txid)!;
    };

    beforeAll(async () => {
        const info = await ark.getInfo();
        serverKey = hex.decode(info.signerPubkey).slice(1);
        emulatorKey = hex.decode((await emulator.getInfo()).signerPubkey).slice(1);
        [alice, bob, carol, lender] = await Promise.all([actor(), actor(), actor(), actor()]);
        hrp = ArkAddress.decode(alice.address).hrp;
        await fund(bob, 100_000);
        await fund(lender, 10_000);
        const issued = await bob.wallet.assetManager.issue({
            amount: 1_000n,
            metadata: { decimals: 0, name: "Carrier Test", ticker: "CAR" },
        });
        assetId = issued.assetId;
        expect(
            AssetId.create(
                hex.encode(account(alice).options.params.assetId.txid.slice().reverse()),
                AssetId.fromString(assetId).groupIndex,
            ).toString(),
        ).toBe(assetId);
        aliceAccount = account(alice);
        carolAccount = account(carol);
        aliceCoin = await open(aliceAccount);
        carolCoin = await open(carolAccount);
    }, 300_000);

    const bobAssetCoin = async () =>
        (
            await poll(
                "bob's asset coin",
                () => bob.wallet.getSpendableVtxos(),
                (cs) => cs.some((c) => units(c, assetId) > 0n),
            )
        ).find((c) => units(c, assetId) > 0n)!;

    const deposit = async (amount: bigint, account: CarrierAccountScript, coin: VirtualCoin) => {
        const from = await bobAssetCoin();
        const held = units(coin, assetId);
        const txid = await submit({
            inputs: [walletInput(from), accountInput(account, CarrierLeaf.Deposit, coin)],
            outputs: [
                { script: hex.decode(from.script), amount: BigInt(from.value) },
                { script: account.pkScript, amount: BigInt(coin.value) },
            ],
            assetIn: [units(from, assetId), held],
            assetOut: [units(from, assetId) - amount, held + amount],
            covenants: [{ vin: 1, script: account.covenant.deposit }],
            signers: [{ actor: bob, vins: [0] }],
        });
        return coinAt(txid, 1);
    };

    it("opens an account with the lender's dust and nothing else", () => {
        expect(BigInt(aliceCoin.value)).toBe(LOAN);
        expect(units(aliceCoin, assetId)).toBe(0n);
        expect(aliceCoin.script).toBe(hex.encode(aliceAccount.pkScript));
    });

    it("lets a sender pay into the account without the owner", async () => {
        aliceCoin = await deposit(100n, aliceAccount, aliceCoin);
        expect(BigInt(aliceCoin.value)).toBe(LOAN);
        expect(units(aliceCoin, assetId)).toBe(100n);
        aliceCoin = await deposit(50n, aliceAccount, aliceCoin);
        expect(units(aliceCoin, assetId)).toBe(150n);
    });

    it("refuses a deposit that does not grow the account", async () => {
        const from = await bobAssetCoin();
        const held = units(aliceCoin, assetId);
        await expect(
            submit({
                inputs: [
                    walletInput(from),
                    accountInput(aliceAccount, CarrierLeaf.Deposit, aliceCoin),
                ],
                outputs: [
                    { script: hex.decode(from.script), amount: BigInt(from.value) },
                    { script: aliceAccount.pkScript, amount: LOAN },
                ],
                assetIn: [units(from, assetId), held],
                assetOut: [units(from, assetId), held],
                covenants: [{ vin: 1, script: aliceAccount.covenant.deposit }],
                signers: [{ actor: bob, vins: [0] }],
            }),
            // The account input fails on its last clause, `asset > held`, not on
            // an earlier abort.
        ).rejects.toThrow(/input 1: .*opcode=OP_GREATERTHAN.*false stack entry/);
        const unchanged = await coinAt(aliceCoin.txid, aliceCoin.vout);
        expect(unchanged.isSpent).toBe(false);
    });

    it("pays account to account in one transaction, with no new dust", async () => {
        const held = units(aliceCoin, assetId);
        const txid = await submit({
            inputs: [
                accountInput(aliceAccount, CarrierLeaf.Send, aliceCoin),
                accountInput(carolAccount, CarrierLeaf.Deposit, carolCoin),
            ],
            outputs: [
                { script: aliceAccount.pkScript, amount: LOAN },
                { script: carolAccount.pkScript, amount: LOAN },
            ],
            assetIn: [held, 0n],
            assetOut: [held - 40n, 40n],
            covenants: [
                { vin: 0, script: aliceAccount.covenant.send },
                { vin: 1, script: carolAccount.covenant.deposit },
            ],
            signers: [{ actor: alice, vins: [0] }],
        });
        aliceCoin = await coinAt(txid, 0);
        carolCoin = await coinAt(txid, 1);
        expect(units(aliceCoin, assetId)).toBe(held - 40n);
        expect(units(carolCoin, assetId)).toBe(40n);
        expect(BigInt(aliceCoin.value) + BigInt(carolCoin.value)).toBe(2n * LOAN);
    });

    it("closes: repays the lender exactly the loan and hands the owner the asset", async () => {
        const own = await fund(alice, 2_000);
        const held = units(aliceCoin, assetId);
        const lenderScript = hex.decode(hex.encode(ArkAddress.decode(lender.address).pkScript));
        const txid = await submit({
            inputs: [accountInput(aliceAccount, CarrierLeaf.Close, aliceCoin), walletInput(own)],
            outputs: [
                { script: lenderScript, amount: LOAN },
                { script: hex.decode(own.script), amount: BigInt(own.value) },
            ],
            assetIn: [held, 0n],
            assetOut: [0n, held],
            covenants: [{ vin: 0, script: aliceAccount.covenant.close }],
            signers: [{ actor: alice, vins: [0, 1] }],
        });
        const repaid = await coinAt(txid, 0);
        const owner = await coinAt(txid, 1);
        expect(BigInt(repaid.value)).toBe(LOAN);
        expect(repaid.script).toBe(hex.encode(lenderScript));
        expect(units(owner, assetId)).toBe(held);
        await poll(
            "lender sees the repaid loan",
            () => lender.wallet.getSpendableVtxos(),
            (cs) => cs.some((c) => c.txid === txid && c.vout === 0),
        );
    });

    // The question emulator#151 raises: can a multi-leaf covenant coin carrying
    // an asset be renewed through a real batch, forfeit and all?
    it("renews through a batch, keeping script, value and asset", async () => {
        const before = carolCoin;
        const leaf = carolAccount.findLeaf(hex.encode(carolAccount.scripts[CarrierLeaf.Renew]!));
        const [proofCoin] = await withPrevTxs(
            [
                {
                    ...before,
                    tapTree: carolAccount.encode(),
                    forfeitTapLeafScript: leaf,
                    intentTapLeafScript: leaf,
                },
            ],
            indexer,
        );
        const session = carol.identity.signerSession();
        const sessionKey = hex.encode(await session.getPublicKey());
        const message: Intent.RegisterMessage = {
            type: "register",
            onchain_output_indexes: [],
            valid_at: 0,
            expire_at: 0,
            cosigners_public_keys: [sessionKey],
        };
        // In the proof, input 0 is the message input and the coin is input 1,
        // so OP_TUNNEL pins output 0: same script, value and asset.
        const held = units(before, assetId);
        const proof = Intent.create(
            message,
            [proofCoin!],
            [
                { script: carolAccount.pkScript, amount: BigInt(before.value) },
                Extension.create([
                    packetFor([0n, held], [held]),
                    EmulatorPacket.create([
                        { vin: 1, script: carolAccount.covenant.renew, witness: new Uint8Array() },
                    ]),
                ]).txOut(),
            ],
        );
        const signedProof = await emulator.submitIntent({
            proof: base64.encode(proof.toPSBT()),
            message,
        });
        const intentId = await ark.registerIntent({ proof: signedProof, message });
        const abort = new AbortController();
        const commitment = await Batch.join(
            ark.getEventStream(abort.signal, [sessionKey, `${before.txid}:${before.vout}`]),
            arkade.createArkadeBatchHandler(
                intentId,
                [{ ...proofCoin!, arkadeScriptBytes: carolAccount.covenant.renew }],
                injectedSignaturesOnly(session),
                signedProof,
                message,
                session,
                ark,
                emulator,
                networks.regtest,
            ),
            { abortController: abort },
        ).finally(() => abort.abort());
        expect(commitment).toMatch(/^[0-9a-f]{64}$/);

        const successor = await poll(
            "renewed account",
            async () =>
                (await indexer.getVtxos({ scripts: [hex.encode(carolAccount.pkScript)] })).vtxos,
            (cs) => cs.some((c) => !c.isSpent && c.txid !== before.txid),
        ).then((cs) => cs.find((c) => !c.isSpent && c.txid !== before.txid)!);
        expect(successor.isPreconfirmed).toBe(false);
        expect(BigInt(successor.value)).toBe(LOAN);
        expect(units(successor, assetId)).toBe(held);
        expect((await coinAt(before.txid, before.vout)).isSpent).toBe(true);
        carolCoin = successor;
    });
});
