import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    ArkAddress,
    Batch,
    CSVMultisigTapscript,
    EmulatorPacket,
    EsploraProvider,
    Extension,
    InMemoryContractRepository,
    InMemoryIntentRepository,
    InMemoryVirtualTxRepository,
    InMemoryWalletRepository,
    Intent,
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

export const LOAN = 330n;
const ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(ROOT, ".reference/arkade-regtest/regtest.mjs");

export type Actor = { identity: SingleKey; wallet: Wallet; key: Uint8Array; address: string };

export type Input = {
    txid: string;
    vout: number;
    value: number;
    tapTree: Uint8Array;
    tapLeafScript: TapLeafScript;
};

export type Spend = {
    inputs: Input[];
    outputs: { script: Uint8Array; amount: bigint }[];
    /** Units of the carried asset per input and output index; zero is absent. */
    assetIn: bigint[];
    assetOut: bigint[];
    covenants: { vin: number; script: Uint8Array }[];
    signers: { actor: Actor; vins: number[] }[];
};

export async function poll<T>(
    label: string,
    read: () => Promise<T>,
    ready: (v: T) => boolean,
    timeoutMs = 60_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (ready(value)) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

export const walletInput = (coin: ExtendedVirtualCoin): Input => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: coin.tapTree,
    tapLeafScript: coin.forfeitTapLeafScript,
});

export const accountInput = (
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

// The renew leaf is [server, emulator:renew]: nobody holds a key on it, so the
// forfeit's signatures are injected by the emulator and arkd, never by us.
const injectedSignaturesOnly = (session: SignerSession): Identity => ({
    sign: async (tx: Transaction) => tx,
    signerSession: () => session,
    signMessage: async () => new Uint8Array(),
    compressedPublicKey: async () => new Uint8Array(33),
    xOnlyPublicKey: async () => new Uint8Array(32),
});

/** One isolated regtest stack, addressed through the env file that started it. */
export function connect(envFile: string) {
    const envPath = resolve(import.meta.dirname, envFile);
    const env = Object.fromEntries(
        readFileSync(envPath, "utf8")
            .split("\n")
            .filter((line) => /^[A-Z0-9_]+=/.test(line))
            .map((line) => line.split("=", 2) as [string, string]),
    );
    const arkdUrl = `http://localhost:${env.ARKD_PORT}`;
    const esploraUrl = `http://localhost:${env.MEMPOOL_WEB_PORT}/api`;
    const ark = new RestArkProvider(arkdUrl);
    const indexer = new RestIndexerProvider(arkdUrl);
    const emulator = new RestEmulatorProvider(`http://localhost:${env.EMULATOR_PORT}`);
    let assetId = "";
    let serverKey = new Uint8Array();
    let emulatorKey = new Uint8Array();
    let hrp = "";

    const regtest = (command: string, ...args: string[]) =>
        execFileSync(process.execPath, [CLI, command, "--env", envPath, ...args], {
            cwd: ROOT,
            stdio: "pipe",
            timeout: 120_000,
        }).toString();

    const units = (coin: VirtualCoin) =>
        coin.assets?.find((a) => a.assetId === assetId)?.amount ?? 0n;

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

    async function actor(): Promise<Actor> {
        const identity = SingleKey.fromHex(randomBytes(32).toString("hex"));
        const wallet = await Wallet.create({
            identity,
            arkProvider: ark,
            indexerProvider: indexer,
            onchainProvider: new EsploraProvider(esploraUrl),
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

    async function coinAt(txid: string, vout: number): Promise<VirtualCoin> {
        const { vtxos } = await poll(
            `${txid}:${vout}`,
            () => indexer.getVtxos({ outpoints: [{ txid, vout }] }),
            (r) => r.vtxos.length === 1,
        );
        return vtxos[0]!;
    }

    async function fund(who: Actor, sats: number): Promise<ExtendedVirtualCoin> {
        regtest(
            "ark",
            "send",
            "--to",
            who.address,
            "--amount",
            String(sats),
            "--password",
            "secret",
        );
        const coins = await poll(
            `${sats} sats for ${who.address}`,
            () => who.wallet.getSpendableVtxos(),
            (cs) => cs.some((c) => c.value === sats && !c.assets?.length),
        );
        return coins.find((c) => c.value === sats && !c.assets?.length)!;
    }

    /** Fetches keys and issues the test asset from `issuer`'s funded wallet. */
    async function setup(issuer: Actor) {
        serverKey = hex.decode((await ark.getInfo()).signerPubkey).slice(1);
        emulatorKey = hex.decode((await emulator.getInfo()).signerPubkey).slice(1);
        hrp = ArkAddress.decode(issuer.address).hrp;
        const issued = await issuer.wallet.assetManager.issue({
            amount: 1_000n,
            metadata: { decimals: 0, name: "Carrier Test", ticker: "CAR" },
        });
        assetId = issued.assetId;
    }

    const account = (owner: Actor, lender: Actor) => {
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
        const script = new CarrierAccountScript({
            serverKey,
            emulatorKey,
            params,
            vtxoMinAmount: 1n,
        });
        const roundTrip = AssetId.create(
            hex.encode(params.assetId.txid.slice().reverse()),
            params.assetId.groupIndex,
        ).toString();
        if (roundTrip !== assetId) throw new Error(`asset id byte order: ${roundTrip}`);
        return script;
    };

    async function open(script: CarrierAccountScript, lender: Actor): Promise<VirtualCoin> {
        const address = script.address(hrp, serverKey).encode();
        const txid = await lender.wallet.send({ address, amount: Number(LOAN) });
        const found = await poll(
            `account funding ${txid}`,
            () => indexer.getVtxos({ scripts: [hex.encode(script.pkScript)] }),
            (r) => r.vtxos.some((c) => c.txid === txid),
        );
        return found.vtxos.find((c) => c.txid === txid)!;
    }

    /** Builds the graph, signs the human inputs, and has the emulator co-sign and submit it. */
    async function submit(spend: Spend): Promise<string> {
        const packet = packetFor(spend.assetIn, spend.assetOut);
        const extension = Extension.create([
            packet,
            EmulatorPacket.create(spend.covenants),
        ]).txOut();
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
            for (const vin of vins)
                checkpoints[vin] = await who.identity.sign(checkpoints[vin]!, [0]);
        }
        const signed = await emulator.submitTx(
            base64.encode(arkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT())),
        );
        return Transaction.fromPSBT(base64.decode(signed.signedArkTx)).id;
    }

    /**
     * Joins a batch through the renew leaf. `cosigner` only supplies a signer
     * session for the tree; it holds no key on the account.
     */
    async function renew(
        script: CarrierAccountScript,
        coin: VirtualCoin,
        cosigner: Actor,
    ): Promise<{ commitment: string; successor: VirtualCoin }> {
        const leaf = script.findLeaf(hex.encode(script.scripts[CarrierLeaf.Renew]!));
        const [proofCoin] = await withPrevTxs(
            [
                {
                    ...coin,
                    tapTree: script.encode(),
                    forfeitTapLeafScript: leaf,
                    intentTapLeafScript: leaf,
                },
            ],
            indexer,
        );
        const session = cosigner.identity.signerSession();
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
        const held = units(coin);
        const proof = Intent.create(
            message,
            [proofCoin!],
            [
                { script: script.pkScript, amount: BigInt(coin.value) },
                Extension.create([
                    ...(held > 0n ? [packetFor([0n, held], [held])] : []),
                    EmulatorPacket.create([
                        { vin: 1, script: script.covenant.renew, witness: new Uint8Array() },
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
            ark.getEventStream(abort.signal, [sessionKey, `${coin.txid}:${coin.vout}`]),
            arkade.createArkadeBatchHandler(
                intentId,
                [{ ...proofCoin!, arkadeScriptBytes: script.covenant.renew }],
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
        const successor = await poll(
            "renewed account",
            async () => (await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)] })).vtxos,
            (cs) => cs.some((c) => !c.isSpent && c.txid !== coin.txid),
        ).then((cs) => cs.find((c) => !c.isSpent && c.txid !== coin.txid)!);
        return { commitment, successor };
    }

    return {
        ark,
        indexer,
        emulator,
        regtest,
        actor,
        fund,
        setup,
        account,
        open,
        submit,
        renew,
        coinAt,
        units,
        assetId: () => assetId,
    };
}
