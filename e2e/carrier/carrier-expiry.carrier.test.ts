import { beforeAll, describe, expect, it } from "vitest";
import type { VirtualCoin } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { CarrierLeaf, type CarrierAccountScript } from "../../packages/covenant/src/index.js";
import { LOAN, accountInput, connect, poll, walletInput, type Actor } from "./stack.js";

// Block-denominated stack: the batch expires and is swept when we mine past it.
const s = connect("carrier-expiry.env");

describe("a carrier account nobody renews", () => {
    let bob: Actor, dave: Actor, lender: Actor;
    let account: CarrierAccountScript;
    let coin: VirtualCoin;

    beforeAll(async () => {
        // A previous run mined past expiry and swept the CLI's own funding too;
        // settling recovers it. On a fresh stack there may be nothing to settle.
        try {
            s.regtest("ark", "settle", "--password", "secret");
        } catch {}
        [bob, dave, lender] = await Promise.all([s.actor(), s.actor(), s.actor()]);
        await s.fund(bob, 100_000);
        await s.fund(lender, 10_000);
        await s.setup(bob);
        account = s.account(dave, lender);
        const opened = await s.open(account, lender);
        const from = (
            await poll(
                "bob's asset coin",
                () => bob.wallet.getSpendableVtxos(),
                (cs) => cs.some((c) => s.units(c) > 0n),
            )
        ).find((c) => s.units(c) > 0n)!;
        const txid = await s.submit({
            inputs: [walletInput(from), accountInput(account, CarrierLeaf.Deposit, opened)],
            outputs: [
                { script: hex.decode(from.script), amount: BigInt(from.value) },
                { script: account.pkScript, amount: LOAN },
            ],
            assetIn: [s.units(from), 0n],
            assetOut: [s.units(from) - 100n, 100n],
            covenants: [{ vin: 1, script: account.covenant.deposit }],
            signers: [{ actor: bob, vins: [0] }],
        });
        coin = await s.coinAt(txid, 1);
        expect(s.units(coin)).toBe(100n);
    }, 300_000);

    it("is swept, not lost, when its batch expires", async () => {
        coin = await poll(
            "account swept",
            async () => {
                s.regtest("mine", "5");
                return s.coinAt(coin.txid, coin.vout);
            },
            (c) => c.isSwept === true,
            240_000,
        );
        expect(coin.isSpent).toBe(false);
        expect(s.units(coin)).toBe(100n);
    });

    it("can no longer be spent off-chain once swept", async () => {
        await expect(
            s.submit({
                inputs: [accountInput(account, CarrierLeaf.Send, coin)],
                outputs: [{ script: account.pkScript, amount: LOAN }],
                assetIn: [100n],
                assetOut: [100n],
                covenants: [{ vin: 0, script: account.covenant.send }],
                signers: [{ actor: dave, vins: [0] }],
            }),
        ).rejects.toThrow(/recoverable|swept|expired/i);
        expect((await s.coinAt(coin.txid, coin.vout)).isSpent).toBe(false);
    });

    // The "we disappear and nobody renews" case: the owner comes back after
    // the sweep and recovers through the same permissionless renew leaf.
    //
    // A swept coin needs no forfeit, yet the SDK's batch handler still sends the
    // emulator an empty finalization, which v0.0.10-rc.0 rejects. The client sees
    // that error, but arkd needs nothing from it and finalizes the batch anyway.
    it("is recovered through the renew leaf, though the client reports an error", async () => {
        await expect(s.renew(account, coin, dave)).rejects.toThrow(
            /submit finalization to emulator.*failed to find any valid input\/entry pairs/,
        );
        const successor = await poll(
            "recovered account",
            async () =>
                (await s.indexer.getVtxos({ scripts: [hex.encode(account.pkScript)] })).vtxos,
            (cs) => cs.some((c) => !c.isSpent && !c.isSwept && c.txid !== coin.txid),
        ).then((cs) => cs.find((c) => !c.isSpent && !c.isSwept && c.txid !== coin.txid)!);
        expect(successor.isPreconfirmed).toBe(false);
        expect(BigInt(successor.value)).toBe(LOAN);
        expect(s.units(successor)).toBe(100n);
        const consumed = await s.coinAt(coin.txid, coin.vout);
        expect(consumed.isSpent).toBe(true);
    });
});
