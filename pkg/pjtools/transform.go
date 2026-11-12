package pjtools

// pj_* transform/patch tools: crypto utilities (hash/base64/xor), string
// decoders, a KDF-style key derivation utility, and the guarded binary patcher
// (mandatory orig_hex verification + .bak rollback; never patches silently).

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf16"

	actool "github.com/Autumn-27/norma/tool"
)

func (s *Service) cryptoTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_crypto",
		Description: "pj_crypto: 哈希/编码工具。action=hash（sha256|sha1|md5）/b64_encode/b64_decode/" +
			"xor（key 十六进制或单字节）。分析用工具，不是破解器。",
		Schema: obj(map[string]any{
			"action": enum("hash | b64_encode | b64_decode | xor", "hash", "b64_encode", "b64_decode", "xor"),
			"input":  str("输入（文本；xor/b64_decode 也接受 0x 前缀十六进制）"),
			"algo":   enum("hash 算法（默认 sha256）", "sha256", "sha1", "md5"),
			"key":    str("xor 密钥（十六进制，如 5a 或 5a6b7c）"),
		}, "action", "input"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action string `json:"action"`
				Input  string `json:"input"`
				Algo   string `json:"algo"`
				Key    string `json:"key"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_crypto: bad input: %v", err), nil
			}
			data := decodeMaybeHex(input.Input)
			switch input.Action {
			case "hash":
				switch input.Algo {
				case "", "sha256":
					sum := sha256.Sum256(data)
					return actool.Text("sha256=" + hex.EncodeToString(sum[:])), nil
				case "sha1":
					sum := sha1.Sum(data)
					return actool.Text("sha1=" + hex.EncodeToString(sum[:])), nil
				case "md5":
					sum := md5.Sum(data)
					return actool.Text("md5=" + hex.EncodeToString(sum[:])), nil
				default:
					return errf("pj_crypto: unknown algo %q (sha256|sha1|md5)", input.Algo), nil
				}
			case "b64_encode":
				return actool.Text("b64=" + base64.StdEncoding.EncodeToString(data)), nil
			case "b64_decode":
				raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
				if err != nil {
					return errf("pj_crypto: b64_decode: %v", err), nil
				}
				return actool.Text("hex=" + hex.EncodeToString(raw) + "\nascii=" + printable(raw)), nil
			case "xor":
				key, err := parseKey(input.Key)
				if err != nil {
					return errf("pj_crypto: %v", err), nil
				}
				out := make([]byte, len(data))
				for i, b := range data {
					out[i] = b ^ key[i%len(key)]
				}
				return actool.Text("hex=" + hex.EncodeToString(out) + "\nascii=" + printable(out)), nil
			default:
				return errf("pj_crypto: unknown action %q", input.Action), nil
			}
		},
	})
}

// decodeMaybeHex accepts raw text or 0x-prefixed hex.
func decodeMaybeHex(s string) []byte {
	t := strings.TrimSpace(s)
	if strings.HasPrefix(t, "0x") {
		if raw, err := hex.DecodeString(t[2:]); err == nil {
			return raw
		}
	}
	return []byte(s)
}

func parseKey(key string) ([]byte, error) {
	t := strings.TrimSpace(key)
	if t == "" {
		return nil, fmt.Errorf("key is required for xor")
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(t, "0x"))
	if err != nil || len(raw) == 0 {
		return nil, fmt.Errorf("key must be hex (e.g. 5a or 5a6b7c)")
	}
	return raw, nil
}

// printable renders bytes as ASCII where possible, dots otherwise.
func printable(b []byte) string {
	out := make([]rune, 0, len(b))
	for _, c := range b {
		if c >= 0x20 && c < 0x7f {
			out = append(out, rune(c))
		} else {
			out = append(out, '.')
		}
	}
	return string(out)
}

func (s *Service) decodeTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_decode",
		Description: "pj_decode: 解码字符串。action=auto（试探 hex/base64/utf-16le）/hex/base64/unicode，" +
			"外加 hexdump 视图。回执给 hex + ascii。",
		Schema: obj(map[string]any{
			"action": enum("auto | hex | base64 | unicode | hexdump", "auto", "hex", "base64", "unicode", "hexdump"),
			"input":  str("输入字符串（hex/base64/hexdump 可用 0x 前缀十六进制）"),
		}, "action", "input"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action string `json:"action"`
				Input  string `json:"input"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_decode: bad input: %v", err), nil
			}
			raw := decodeMaybeHex(input.Input)
			switch input.Action {
			case "hexdump":
				return actool.Text(hexdump(raw)), nil
			case "hex":
				decoded, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(input.Input), "0x"))
				if err != nil {
					return errf("pj_decode: hex: %v", err), nil
				}
				return actool.Text("ascii=" + printable(decoded)), nil
			case "base64":
				decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.Input))
				if err != nil {
					return errf("pj_decode: base64: %v", err), nil
				}
				return actool.Text("ascii=" + printable(decoded)), nil
			case "unicode":
				return actool.Text("ascii=" + decodeUTF16LE(raw)), nil
			case "auto":
				var attempts []string
				if decoded, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(input.Input), "0x")); err == nil {
					attempts = append(attempts, "hex: "+printable(decoded))
				}
				if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.Input)); err == nil && len(decoded) > 0 {
					attempts = append(attempts, "base64: "+printable(decoded))
				}
				if u := decodeUTF16LE(raw); u != printable(raw) {
					attempts = append(attempts, "utf-16le: "+u)
				}
				if len(attempts) == 0 {
					return actool.Text("auto: no decoding matched"), nil
				}
				return actool.Text(strings.Join(attempts, "\n")), nil
			default:
				return errf("pj_decode: unknown action %q", input.Action), nil
			}
		},
	})
}

func decodeUTF16LE(b []byte) string {
	if len(b)%2 != 0 {
		return printable(b)
	}
	units := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		units = append(units, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(units))
}

// hexdump renders a classic 16-bytes-per-line dump.
func hexdump(b []byte) string {
	var sb strings.Builder
	for off := 0; off < len(b); off += 16 {
		end := off + 16
		if end > len(b) {
			end = len(b)
		}
		row := b[off:end]
		hexPart := make([]string, 0, 16)
		for _, c := range row {
			hexPart = append(hexPart, fmt.Sprintf("%02x", c))
		}
		fmt.Fprintf(&sb, "%08x  %-47s  |%s|\n", off, strings.Join(hexPart, " "), printable(row))
	}
	return strings.TrimRight(sb.String(), "\n")
}

func (s *Service) keygenTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_keygen",
		Description: "pj_keygen: HMAC-SHA256 迭代 KDF（密钥派生工具，用于测试向量与协议重建；" +
			"从 seed + salt + iterations 确定性派生指定位数的密钥）。",
		Schema: obj(map[string]any{
			"seed":       str("种子材料（文本或 0x 十六进制）"),
			"salt":       str("盐（可选）"),
			"iterations": map[string]any{"type": "integer", "description": "迭代次数（默认 10000，上限 1_000_000）"},
			"length":     map[string]any{"type": "integer", "description": "派生字节数（默认 32）"},
		}, "seed"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Seed       string `json:"seed"`
				Salt       string `json:"salt"`
				Iterations int    `json:"iterations"`
				Length     int    `json:"length"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_keygen: bad input: %v", err), nil
			}
			if input.Iterations <= 0 {
				input.Iterations = 10000
			}
			if input.Iterations > 1_000_000 {
				return errf("pj_keygen: iterations cap 1000000"), nil
			}
			if input.Length <= 0 {
				input.Length = 32
			}
			if input.Length > 256 {
				return errf("pj_keygen: length cap 256"), nil
			}
			key := kdfHMACSHA256(decodeMaybeHex(input.Seed), []byte(input.Salt), input.Iterations, input.Length)
			return actool.Text(fmt.Sprintf("derived(%d bytes)=%s", input.Length, hex.EncodeToString(key))), nil
		},
	})
}

// kdfHMACSHA256: T0 = HMAC(seed, salt||0x00); Tn = HMAC(seed, Tn-1); the output
// block XOR-accumulates every round — deterministic extract-and-expand style.
func kdfHMACSHA256(seed, salt []byte, iterations, length int) []byte {
	out := make([]byte, 0, length)
	var counter byte = 1
	for len(out) < length {
		block := append(append([]byte{}, salt...), counter)
		u := hmac.New(sha256.New, seed)
		u.Write(block)
		t := u.Sum(nil)
		acc := append([]byte{}, t...)
		for i := 1; i < iterations; i++ {
			u := hmac.New(sha256.New, seed)
			u.Write(t)
			t = u.Sum(nil)
			for j := range acc {
				acc[j] ^= t[j]
			}
		}
		out = append(out, acc...)
		counter++
	}
	return out[:length]
}

func (s *Service) patchTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_patch",
		Description: "pj_patch: 受守卫的二进制补丁。action=verify（只比对当前字节与 orig_hex）/apply/" +
			"restore（从 .bak 回滚）。apply 强制要求：orig_hex 必须与当前字节一致、in_place 必须==true、" +
			"写入前落 .bak 备份。不支持 VA 时先自行用 pj_va2off 换算 offset。不可静默打补丁。",
		Schema: obj(map[string]any{
			"action":   enum("verify | apply | restore", "verify", "apply", "restore"),
			"file":     str("目标文件路径"),
			"offset":   str("文件偏移（0x 前缀十六进制或十进制）"),
			"orig_hex": str("期望的原始字节（十六进制；verify/apply 必填）"),
			"new_hex":  str("替换字节（十六进制；apply 必填）"),
			"in_place": map[string]any{"type": "boolean", "description": "apply 必须显式 true 才会写原文件；false 写 <file>.patched"},
		}, "action", "file"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action  string `json:"action"`
				File    string `json:"file"`
				Offset  string `json:"offset"`
				OrigHex string `json:"orig_hex"`
				NewHex  string `json:"new_hex"`
				InPlace bool   `json:"in_place"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_patch: bad input: %v", err), nil
			}
			switch input.Action {
			case "restore":
				bak := input.File + ".bak"
				if _, err := os.Stat(bak); err != nil {
					return errf("pj_patch: no backup at %s", bak), nil
				}
				data, err := os.ReadFile(bak)
				if err != nil {
					return errf("pj_patch: %v", err), nil
				}
				if err := os.WriteFile(input.File, data, 0o644); err != nil {
					return errf("pj_patch: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("restored %s from %s (%d bytes)", input.File, bak, len(data))), nil
			case "verify", "apply":
			default:
				return errf("pj_patch: unknown action %q (verify|apply|restore)", input.Action), nil
			}
			off, err := parseUint(input.Offset)
			if err != nil {
				return errf("pj_patch: bad offset %q: %v", input.Offset, err), nil
			}
			orig, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(input.OrigHex), "0x"))
			if err != nil || len(orig) == 0 {
				return errf("pj_patch: orig_hex must be non-empty hex"), nil
			}
			data, err := os.ReadFile(input.File)
			if err != nil {
				return errf("pj_patch: %v", err), nil
			}
			if off+uint64(len(orig)) > uint64(len(data)) {
				return errf("pj_patch: offset %#x + %d bytes exceeds file size %d", off, len(orig), len(data)), nil
			}
			if !bytes.Equal(data[off:off+uint64(len(orig))], orig) {
				return errf("pj_patch: MISMATCH at %#x: expected %s, found %s — refusing to patch",
					off, hex.EncodeToString(orig), hex.EncodeToString(data[off:off+uint64(len(orig))])), nil
			}
			if input.Action == "verify" {
				return actool.Text(fmt.Sprintf("verify ok: %d bytes at %#x match %s", len(orig), off, hex.EncodeToString(orig))), nil
			}
			fresh, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(input.NewHex), "0x"))
			if err != nil || len(fresh) != len(orig) {
				return errf("pj_patch: new_hex must be hex of the SAME length as orig_hex (%d bytes)", len(orig)), nil
			}
			if input.InPlace {
				if err := os.WriteFile(input.File+".bak", data, 0o644); err != nil {
					return errf("pj_patch: backup: %v", err), nil
				}
				copy(data[off:], fresh)
				if err := os.WriteFile(input.File, data, 0o644); err != nil {
					return errf("pj_patch: write: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("patched %s at %#x (%d bytes, .bak written; restore with action=restore)", input.File, off, len(fresh))), nil
			}
			copy(data[off:], fresh)
			out := input.File + ".patched"
			if err := os.WriteFile(out, data, 0o644); err != nil {
				return errf("pj_patch: write: %v", err), nil
			}
			return actool.Text(fmt.Sprintf("patched copy written: %s (original untouched)", out)), nil
		},
	})
}
