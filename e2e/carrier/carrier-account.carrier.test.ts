import { beforeAll, describe, expect, it } from "vitest";
import { ArkAddress, type VirtualCoin } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { CarrierLeaf, type CarrierAccountScript } from "../../packages/covenant/src/index.js";
import { LOAN, accountInput, connect, poll, walletInput, type Actor } from "./stack.js";

const s = connect("carrier.env");

describe("carrier account on a live arkd + emulator", () => {
    let alice: Actor, bob: Actor, carol: Actor, lender: Actor;
    let aliceAccount: CarrierAccountScript, carolAccount: CarrierAccountScript;
    let aliceCoin: VirtualCoin, carolCoin: VirtualCoin;

    beforeAll(async () => {
        [alice, bob, carol, lender] = await Promise.all([
            s.actor(),
            s.actor(),
            s.actor(),
            s.actor(),
        ]);
        await s.fund(bob, 100_000);
        await s.fund(lender, 10_000);
        await s.setup(bob);
        aliceAccount = s.account(alice, lender);
        carolAccount = s.account(carol, lender);
        aliceCoin = await s.open(aliceAccount, lender);
        carolCoin = await s.open(carolAccount, lender);
    }, 300_000);

    const bobAssetCoin = async () =>
        (
            await poll(
                "bob's asset coin",
                () => bob.wallet.getSpendableVtxos(),
                (cs) => cs.some((c) => s.units(c) > 0n),
            )
        ).find((c) => s.units(c) > 0n)!;

    const deposit = async (amount: bigint, account: CarrierAccountScript, coin: VirtualCoin) => {
        const from = await bobAssetCoin();
        const held = s.units(coin);
        const txid = await s.submit({
            inputs: [walletInput(from), accountInput(account, CarrierLeaf.Deposit, coin)],
            outputs: [
                { script: hex.decode(from.script), amount: BigInt(from.value) },
                { script: account.pkScript, amount: BigInt(coin.value) },
            ],
            assetIn: [s.units(from), held],
            assetOut: [s.units(from) - amount, held + amount],
            covenants: [{ vin: 1, script: account.covenant.deposit }],
            signers: [{ actor: bob, vins: [0] }],
        });
        return s.coinAt(txid, 1);
    };

    it("opens an account with the lender's dust and nothing else", () => {
        expect(BigInt(aliceCoin.value)).toBe(LOAN);
        expect(s.units(aliceCoin)).toBe(0n);
        expect(aliceCoin.script).toBe(hex.encode(aliceAccount.pkScript));
    });

    it("lets a sender pay into the account without the owner", async () => {
        aliceCoin = await deposit(100n, aliceAccount, aliceCoin);
        expect(BigInt(aliceCoin.value)).toBe(LOAN);
        expect(s.units(aliceCoin)).toBe(100n);
        aliceCoin = await deposit(50n, aliceAccount, aliceCoin);
        expect(s.units(aliceCoin)).toBe(150n);
    });

    it("refuses a deposit that does not grow the account", async () => {
        const from = await bobAssetCoin();
        const held = s.units(aliceCoin);
        await expect(
            s.submit({
                inputs: [
                    walletInput(from),
                    accountInput(aliceAccount, CarrierLeaf.Deposit, aliceCoin),
                ],
                outputs: [
                    { script: hex.decode(from.script), amount: BigInt(from.value) },
                    { script: aliceAccount.pkScript, amount: LOAN },
                ],
                assetIn: [s.units(from), held],
                assetOut: [s.units(from), held],
                covenants: [{ vin: 1, script: aliceAccount.covenant.deposit }],
                signers: [{ actor: bob, vins: [0] }],
            }),
            // The account input fails on its last clause, `asset > held`, not on
            // an earlier abort.
        ).rejects.toThrow(/input 1: .*opcode=OP_GREATERTHAN.*false stack entry/);
        expect((await s.coinAt(aliceCoin.txid, aliceCoin.vout)).isSpent).toBe(false);
    });

    it("pays account to account in one transaction, with no new dust", async () => {
        const held = s.units(aliceCoin);
        const txid = await s.submit({
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
        aliceCoin = await s.coinAt(txid, 0);
        carolCoin = await s.coinAt(txid, 1);
        expect(s.units(aliceCoin)).toBe(held - 40n);
        expect(s.units(carolCoin)).toBe(40n);
        expect(BigInt(aliceCoin.value) + BigInt(carolCoin.value)).toBe(2n * LOAN);
    });

    it("closes: repays the lender exactly the loan and hands the owner the asset", async () => {
        const own = await s.fund(alice, 2_000);
        const held = s.units(aliceCoin);
        const lenderScript = ArkAddress.decode(lender.address).pkScript;
        const txid = await s.submit({
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
        const repaid = await s.coinAt(txid, 0);
        const owner = await s.coinAt(txid, 1);
        expect(BigInt(repaid.value)).toBe(LOAN);
        expect(repaid.script).toBe(hex.encode(lenderScript));
        expect(s.units(owner)).toBe(held);
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
        const { commitment, successor } = await s.renew(carolAccount, before, carol);
        expect(commitment).toMatch(/^[0-9a-f]{64}$/);
        expect(successor.isPreconfirmed).toBe(false);
        expect(BigInt(successor.value)).toBe(LOAN);
        expect(s.units(successor)).toBe(s.units(before));
        expect((await s.coinAt(before.txid, before.vout)).isSpent).toBe(true);
        carolCoin = successor;
    });
});
