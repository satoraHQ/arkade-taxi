// Executes contracts/carrier_account.json in the emulator's arkade engine, with
// scripts assembled straight from the compiled artifact. Run via run.mjs.
package carrier_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/arkd/pkg/ark-lib/intent"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/btcutil/psbt"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/btcsuite/btcd/txscript"
	"github.com/btcsuite/btcd/wire"
	"github.com/stretchr/testify/require"
)

const (
	loan        = int64(330)
	exitDelay   = int64(144)
	assetIndex  = uint16(0)
	cosignerKey = "02ab7c1f5e4d3b2a19087766554433221100ffeeddccbbaa99887766554433221100"
)

type artifact struct {
	ConstructorInputs []struct{ Name, Type string } `json:"constructorInputs"`
	Functions         []struct {
		Name   string `json:"name"`
		Arkade *struct {
			Asm []string `json:"asm"`
		} `json:"arkade"`
		Leaves []struct {
			Asm []string `json:"asm"`
		} `json:"leaves"`
	} `json:"functions"`
}

func key(seed byte) *btcec.PublicKey {
	priv, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{seed}, 32))
	return priv.PubKey()
}

func p2tr(k *btcec.PublicKey) []byte {
	return append([]byte{txscript.OP_1, txscript.OP_DATA_32}, schnorr.SerializePubKey(k)...)
}

var (
	serverKey   = key(1)
	emulatorKey = key(2)
	ownerKey    = key(3)
	lenderKey   = key(4)
	assetTxid   = chainhash.Hash{0xa5, 0x5e, 0x70}
	// The account's own address; the covenant only ever compares it to itself.
	accountScript = p2tr(key(5))
	senderScript  = p2tr(key(6))
)

type contract struct {
	arkade map[string][]byte
	leaf   map[string][]byte
}

func assemble(t *testing.T, asm []string, params map[string]any) []byte {
	t.Helper()
	b := txscript.NewScriptBuilder()
	for _, tok := range asm {
		switch {
		case strings.HasPrefix(tok, "<"):
			v, ok := params[strings.Trim(tok, "<>")]
			require.True(t, ok, "unbound placeholder %s", tok)
			switch v := v.(type) {
			case int64:
				b.AddInt64(v)
			case []byte:
				b.AddData(v)
			default:
				t.Fatalf("placeholder %s has type %T", tok, v)
			}
		case strings.HasPrefix(tok, "0x"):
			d, err := hex.DecodeString(tok[2:])
			require.NoError(t, err)
			b.AddData(d)
		case strings.HasPrefix(tok, "OP_"):
			op, ok := arkade.OpcodeByName[tok]
			require.True(t, ok, "unknown opcode %s", tok)
			b.AddOp(op)
		default:
			n, err := strconv.ParseInt(tok, 10, 64)
			require.NoError(t, err, "token %q", tok)
			b.AddInt64(n)
		}
	}
	s, err := b.Script()
	require.NoError(t, err)
	return s
}

func load(t *testing.T) contract {
	t.Helper()
	raw, err := os.ReadFile(os.Getenv("CARRIER_ARTIFACT"))
	require.NoError(t, err)
	var a artifact
	require.NoError(t, json.Unmarshal(raw, &a))

	params := map[string]any{
		"ownerKey":   schnorr.SerializePubKey(ownerKey),
		"lenderKey":  schnorr.SerializePubKey(lenderKey),
		"loan":       loan,
		"exitDelay":  exitDelay,
		"assetTxid":  assetTxid[:],
		"assetGidx":  int64(assetIndex),
		"SERVER_KEY": schnorr.SerializePubKey(serverKey),
	}
	require.Len(t, a.ConstructorInputs, 6, "constructor changed: update the params above")

	c := contract{arkade: map[string][]byte{}, leaf: map[string][]byte{}}
	for _, fn := range a.Functions {
		if fn.Arkade == nil {
			continue
		}
		script := assemble(t, fn.Arkade.Asm, params)
		c.arkade[fn.Name] = script
		params["EMULATOR_KEY:"+fn.Name] = schnorr.SerializePubKey(
			arkade.ComputeArkadeScriptPublicKey(emulatorKey, arkade.ArkadeScriptHash(script)),
		)
	}
	for _, fn := range a.Functions {
		require.Len(t, fn.Leaves, 1)
		c.leaf[fn.Name] = assemble(t, fn.Leaves[0].Asm, params)
	}
	for _, name := range []string{"deposit", "send", "close", "renew"} {
		require.Contains(t, c.arkade, name)
	}
	requireVectors(t, c)
	return c
}

// The TS builder writes carrier-vectors.json from the same keys; equal bytes
// mean what runs here is what the client derives its address from.
func requireVectors(t *testing.T, c contract) {
	t.Helper()
	path := os.Getenv("CARRIER_VECTORS")
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var v struct {
		ServerKey, EmulatorKey string
		Arkade, Leaves         map[string]string
	}
	require.NoError(t, json.Unmarshal(raw, &v))
	require.Equal(t, hex.EncodeToString(schnorr.SerializePubKey(serverKey)), v.ServerKey)
	require.Equal(t, hex.EncodeToString(schnorr.SerializePubKey(emulatorKey)), v.EmulatorKey)
	require.Len(t, v.Arkade, len(c.arkade))
	require.Len(t, v.Leaves, len(c.leaf))
	for name, script := range c.arkade {
		require.Equal(t, v.Arkade[name], hex.EncodeToString(script), "arkade %s", name)
	}
	for name, leaf := range c.leaf {
		require.Equal(t, v.Leaves[name], hex.EncodeToString(leaf), "leaf %s", name)
	}
}

// assetIn[i], assetOut[i]: units of the carried asset at that index; zero is
// absent. foreign puts a different asset at that output instead.
type spend struct {
	ins, outs         []*wire.TxOut
	assetIn, assetOut []uint64
	foreignOut        map[int]uint64
	vin               uint16
	intent            string
}

func (s spend) clone() spend {
	c := spend{
		assetIn:    append([]uint64(nil), s.assetIn...),
		assetOut:   append([]uint64(nil), s.assetOut...),
		foreignOut: map[int]uint64{},
		vin:        s.vin,
		intent:     s.intent,
	}
	for k, v := range s.foreignOut {
		c.foreignOut[k] = v
	}
	for _, o := range s.ins {
		cp := *o
		c.ins = append(c.ins, &cp)
	}
	for _, o := range s.outs {
		cp := *o
		c.outs = append(c.outs, &cp)
	}
	return c
}

func group(t *testing.T, id asset.AssetId, in, out map[int]uint64) asset.AssetGroup {
	t.Helper()
	var ins []asset.AssetInput
	for i, units := range in {
		a, err := asset.NewAssetInput(uint16(i), units)
		require.NoError(t, err)
		ins = append(ins, *a)
	}
	var outs []asset.AssetOutput
	for i, units := range out {
		a, err := asset.NewAssetOutput(uint16(i), units)
		require.NoError(t, err)
		outs = append(outs, *a)
	}
	g, err := asset.NewAssetGroup(&id, nil, ins, outs, []asset.Metadata{})
	require.NoError(t, err)
	return *g
}

func nonzero(units []uint64) map[int]uint64 {
	m := map[int]uint64{}
	for i, u := range units {
		if u > 0 {
			m[i] = u
		}
	}
	return m
}

func run(t *testing.T, c contract, fn string, s spend) error {
	t.Helper()
	tx := wire.NewMsgTx(2)
	prevouts := make(map[wire.OutPoint]*wire.TxOut, len(s.ins))
	for i, in := range s.ins {
		op := wire.OutPoint{Hash: chainhash.Hash{byte(i + 1)}}
		tx.AddTxIn(wire.NewTxIn(&op, nil, nil))
		prevouts[op] = in
	}
	for _, out := range s.outs {
		tx.AddTxOut(out)
	}

	groups := []asset.AssetGroup{}
	if in, out := nonzero(s.assetIn), nonzero(s.assetOut); len(in)+len(out) > 0 {
		groups = append(groups, group(t, asset.AssetId{Txid: assetTxid, Index: assetIndex}, in, out))
	}
	if len(s.foreignOut) > 0 {
		groups = append(groups, group(t,
			asset.AssetId{Txid: chainhash.Hash{0xf0}, Index: 0}, nil, s.foreignOut))
	}
	entry := arkade.EmulatorEntry{Vin: s.vin, Script: c.arkade[fn]}
	ext := extension.Extension{arkade.EmulatorPacket{entry}}
	if len(groups) > 0 {
		packet, err := asset.NewPacket(groups)
		require.NoError(t, err)
		ext = append(extension.Extension{packet}, ext...)
	}
	extOut, err := ext.TxOut()
	require.NoError(t, err)
	tx.AddTxOut(extOut)

	ptx, err := psbt.NewFromUnsignedTx(tx)
	require.NoError(t, err)
	ptx.Inputs[s.vin].TaprootLeafScript = []*psbt.TaprootTapLeafScript{
		{Script: c.leaf[fn], LeafVersion: txscript.BaseLeafVersion},
	}
	program, err := arkade.ReadArkadeScript(ptx, emulatorKey, entry)
	if err != nil {
		return err
	}
	var opts []arkade.ExecuteOption
	if s.intent != "" {
		opts = append(opts, arkade.WithIntentMessage(s.intent))
	}
	return program.Execute(tx, fetcher{txscript.NewMultiPrevOutFetcher(prevouts)}, int(s.vin), opts...)
}

type fetcher struct{ txscript.PrevOutputFetcher }

func (fetcher) FetchPrevOutArkTx(wire.OutPoint) *wire.MsgTx { return nil }

func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	if prev := f.FetchPrevOutput(op); prev != nil {
		return prev.PkScript
	}
	return nil
}

// Rejections must evaluate the clause under test, not abort on a stack or index
// error before reaching it.
func requireRejected(t *testing.T, err error) {
	t.Helper()
	var scriptErr txscript.Error
	require.ErrorAs(t, err, &scriptErr, "expected a script error, got %v", err)
	require.Contains(t, []txscript.ErrorCode{
		txscript.ErrEvalFalse, txscript.ErrVerify, txscript.ErrEqualVerify, txscript.ErrNumEqualVerify,
	}, scriptErr.ErrorCode, "aborted instead of evaluating false: %v", err)
}

type rejection struct {
	name   string
	mutate func(*spend)
}

func check(t *testing.T, c contract, fn string, valid spend, rejections []rejection) {
	t.Helper()
	require.NoError(t, run(t, c, fn, valid))
	for _, r := range rejections {
		t.Run(r.name, func(t *testing.T) {
			s := valid.clone()
			r.mutate(&s)
			requireRejected(t, run(t, c, fn, s))
		})
	}
}

// A same-program script under witness v0: identical 32 bytes, unspendable.
func v0Lookalike(script []byte) []byte {
	return append([]byte{txscript.OP_0, txscript.OP_DATA_32}, script[2:]...)
}

// The sender spends its own coin at in[0] and pays 20 units into the account at
// in[1]; out[1] is the recreated account.
func deposit(held uint64) spend {
	return spend{
		vin: 1,
		ins: []*wire.TxOut{
			{Value: 1000, PkScript: senderScript},
			{Value: loan, PkScript: accountScript},
		},
		outs: []*wire.TxOut{
			{Value: 1000, PkScript: senderScript},
			{Value: loan, PkScript: accountScript},
		},
		assetIn:  []uint64{50, held},
		assetOut: []uint64{30, held + 20},
	}
}

func TestDeposit(t *testing.T) {
	c := load(t)
	rejections := []rejection{
		{"no_op", func(s *spend) { s.assetOut = []uint64{50, s.assetIn[1]} }},
		{"asset_taken", func(s *spend) { s.assetOut = []uint64{51 + s.assetIn[1] - 1, 0}; s.assetOut[1] = 0 }},
		{"sats_drained", func(s *spend) { s.outs[1].Value--; s.outs[0].Value++ }},
		{"script_changed", func(s *spend) { s.outs[1].PkScript = senderScript }},
		{"v0_lookalike", func(s *spend) { s.outs[1].PkScript = v0Lookalike(accountScript) }},
		{"wrong_position", func(s *spend) { s.outs[0], s.outs[1] = s.outs[1], s.outs[0] }},
	}
	t.Run("into_empty_account", func(t *testing.T) { check(t, c, "deposit", deposit(0), rejections[1:]) })
	t.Run("into_funded_account", func(t *testing.T) { check(t, c, "deposit", deposit(100), rejections) })

	t.Run("sats_may_grow", func(t *testing.T) {
		s := deposit(100)
		s.outs[0].Value -= 500
		s.outs[1].Value += 500
		require.NoError(t, run(t, c, "deposit", s))
	})

	// Two coins of one owner, both spent through deposit, folded into out[0].
	// in[0]'s check passes on its own; in[1]'s must refuse, or the attacker
	// walks off with a whole coin.
	t.Run("fold_two_coins", func(t *testing.T) {
		s := spend{
			vin: 1,
			ins: []*wire.TxOut{
				{Value: loan, PkScript: accountScript},
				{Value: loan, PkScript: accountScript},
			},
			outs: []*wire.TxOut{
				{Value: loan, PkScript: accountScript},
				{Value: loan, PkScript: senderScript},
			},
			assetIn:  []uint64{100, 100},
			assetOut: []uint64{101, 99},
		}
		first := s.clone()
		first.vin = 0
		require.NoError(t, run(t, c, "deposit", first))
		requireRejected(t, run(t, c, "deposit", s))
	})

	// The carried asset's lookup must be found: a foreign asset at out[1]
	// cannot stand in for it.
	t.Run("foreign_asset", func(t *testing.T) {
		s := deposit(0)
		s.assetOut = []uint64{50, 0}
		s.foreignOut = map[int]uint64{1: 20}
		requireRejected(t, run(t, c, "deposit", s))
	})
}

// The owner pays 40 units out of the account at in[0] to out[1].
func send() spend {
	return spend{
		ins:      []*wire.TxOut{{Value: loan, PkScript: accountScript}, {Value: 1000, PkScript: senderScript}},
		outs:     []*wire.TxOut{{Value: loan, PkScript: accountScript}, {Value: 1000, PkScript: senderScript}},
		assetIn:  []uint64{100, 0},
		assetOut: []uint64{60, 40},
	}
}

func TestSend(t *testing.T) {
	c := load(t)
	check(t, c, "send", send(), []rejection{
		{"loan_taken", func(s *spend) { s.outs[0].Value--; s.outs[1].Value++ }},
		{"script_changed", func(s *spend) { s.outs[0].PkScript = senderScript }},
		{"v0_lookalike", func(s *spend) { s.outs[0].PkScript = v0Lookalike(accountScript) }},
		{"wrong_position", func(s *spend) {
			s.outs[0], s.outs[1] = s.outs[1], s.outs[0]
			s.assetOut = []uint64{40, 60}
		}},
	})
	t.Run("empties_asset", func(t *testing.T) {
		s := send()
		s.assetOut = []uint64{0, 100}
		require.NoError(t, run(t, c, "send", s))
	})
}

func TestClose(t *testing.T) {
	c := load(t)
	valid := spend{
		ins:      []*wire.TxOut{{Value: loan, PkScript: accountScript}, {Value: 1000, PkScript: senderScript}},
		outs:     []*wire.TxOut{{Value: loan, PkScript: p2tr(lenderKey)}, {Value: 1000, PkScript: senderScript}},
		assetIn:  []uint64{100, 0},
		assetOut: []uint64{0, 100},
	}
	check(t, c, "close", valid, []rejection{
		{"loan_short", func(s *spend) { s.outs[0].Value--; s.outs[1].Value++ }},
		{"loan_over", func(s *spend) { s.outs[0].Value++; s.outs[1].Value-- }},
		{"not_lender", func(s *spend) { s.outs[0].PkScript = senderScript }},
		{"v0_lookalike", func(s *spend) { s.outs[0].PkScript = v0Lookalike(p2tr(lenderKey)) }},
	})
}

func registerMessage(t *testing.T, kind intent.IntentMessageType, onchain []int, cosigners ...string) string {
	t.Helper()
	m, err := intent.RegisterMessage{
		BaseMessage:          intent.BaseMessage{Type: kind},
		OnchainOutputIndexes: onchain,
		CosignersPublicKeys:  cosigners,
	}.Encode()
	require.NoError(t, err)
	return m
}

// in[0] stands for the intent proof's message input; OP_TUNNEL pins out[0].
func TestRenew(t *testing.T) {
	c := load(t)
	valid := spend{
		vin:      1,
		intent:   registerMessage(t, intent.IntentMessageTypeRegister, []int{}, cosignerKey),
		ins:      []*wire.TxOut{{Value: 1000, PkScript: senderScript}, {Value: loan, PkScript: accountScript}},
		outs:     []*wire.TxOut{{Value: loan, PkScript: accountScript}},
		assetIn:  []uint64{0, 100},
		assetOut: []uint64{100},
	}
	require.NoError(t, run(t, c, "renew", valid))
	for name, mutate := range map[string]func(*spend){
		"value_short":    func(s *spend) { s.outs[0].Value-- },
		"script_changed": func(s *spend) { s.outs[0].PkScript = senderScript },
		"asset_changed":  func(s *spend) { s.assetOut = []uint64{99} },
		"offchain_spend": func(s *spend) { s.intent = "" },
		"not_register": func(s *spend) {
			s.intent = registerMessage(t, intent.IntentMessageTypeDelete, []int{}, cosignerKey)
		},
		"onchain_output": func(s *spend) {
			s.intent = registerMessage(t, intent.IntentMessageTypeRegister, []int{0}, cosignerKey)
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := valid.clone()
			mutate(&s)
			// OP_TUNNEL rejects with the stack-operation code, so any script
			// error counts here; the valid run above proves the path executes.
			var scriptErr txscript.Error
			err := run(t, c, "renew", s)
			require.ErrorAs(t, err, &scriptErr, fmt.Sprintf("%s: %v", name, err))
		})
	}
}
