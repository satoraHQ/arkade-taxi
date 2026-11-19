import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArkadec } from "../../../../scripts/get-arkadec.mjs";

// Each mutant removes or weakens one clause; a surviving mutant is a clause no
// test depends on. Run run.mjs first so the engine checkout exists.
const MUTANTS = [
    ["deposit", "require(tx.outputs[i].witnessVersion == 1);", ""],
    ["deposit", "require(tx.outputs[i].scriptPubKey == tx.inputs[i].scriptPubKey);", ""],
    ["deposit", "require(tx.outputs[i].value >= tx.inputs[i].value);", ""],
    ["deposit", "lookup(assetTxid, assetGidx) > held", "lookup(assetTxid, assetGidx) >= held"],
    ["deposit", "tx.outputs[i]", "tx.outputs[0]", { all: true }],
    ["send", "require(tx.outputs[i].witnessVersion == 1);", ""],
    ["send", "require(tx.outputs[i].scriptPubKey == tx.inputs[i].scriptPubKey);", ""],
    ["send", "require(tx.outputs[i].value >= loan);", ""],
    ["close", "require(tx.outputs[i].witnessVersion == 1);", ""],
    ["close", "require(tx.outputs[i].scriptPubKey == lenderKey);", ""],
    ["close", "require(tx.outputs[i].value == loan);", "require(tx.outputs[i].value >= loan);"],
    ["close", "require(tx.outputs[i].value == loan);", "require(tx.outputs[i].value <= loan);"],
    ["renew", 'require(tx.intent.field("type") == "register");', ""],
    ["renew", 'require(tx.intent.field("onchain_output_indexes") == "[]");', ""],
    ["renew", "require(this.tunnel(this.activeInputIndex - 1));", ""],
];

const here = fileURLToPath(new URL(".", import.meta.url));
const source = readFileSync(resolve(here, "../../contracts/carrier_account.ark"), "utf8");
const engine = resolve(".reference/emulator-engine");
const bin = await fetchArkadec();
const scratch = mkdtempSync(join(tmpdir(), "carrier-mutants-"));

function mutate(fn, from, to, { all = false } = {}) {
    const start = source.indexOf(`function ${fn}()`);
    const end = source.indexOf("\n  }\n", start);
    const body = source.slice(start, end);
    if (!body.includes(from)) throw new Error(`${fn}: clause not found: ${from}`);
    return (
        source.slice(0, start) +
        (all ? body.replaceAll(from, to) : body.replace(from, to)) +
        source.slice(end)
    );
}

let survived = 0;
try {
    MUTANTS.forEach(([fn, from, to, opts], n) => {
        const ark = join(scratch, `m${n}.ark`);
        const json = join(scratch, `m${n}.json`);
        writeFileSync(ark, mutate(fn, from, to, opts));
        execFileSync(bin, [ark, "-o", json], { stdio: "ignore" });
        const label = `${fn}: ${from} -> ${to || "(removed)"}`;
        try {
            execFileSync("go", ["test", "-count=1", "./taxicarrier"], {
                cwd: engine,
                stdio: "ignore",
                env: { ...process.env, CARRIER_ARTIFACT: json },
            });
            survived++;
            console.log(`SURVIVED ${label}`);
        } catch {
            console.log(`killed   ${label}`);
        }
    });
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
if (survived) {
    console.error(`${survived} mutant(s) survived`);
    process.exit(1);
}
