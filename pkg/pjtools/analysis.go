package pjtools

// pj_* analysis tools: sample inspection, string/IOC scanning, AOB pattern
// search, VA→offset translation, decompilation (objdump with strings
// fallback), and byte-level diffing. All pure Go except the optional objdump
// degradation path in pj_decompile.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"debug/elf"
	"debug/pe"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	actool "github.com/Autumn-27/norma/tool"
)

// maxReadBytes caps how much of a sample the analysis tools will slurp.
const maxReadBytes = 64 << 20 // 64 MiB

func readFileCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := io.LimitReader(f, maxReadBytes)
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// shannon computes byte entropy in bits per byte (0..8).
func shannon(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	var counts [256]int
	for _, b := range data {
		counts[b]++
	}
	n := float64(len(data))
	e := 0.0
	for _, c := range counts {
		if c == 0 {
			continue
		}
		p := float64(c) / n
		e -= p * math.Log2(p)
	}
	return e
}

// detectPacker applies section-name and entropy heuristics (UPX, ASPack,
// generic high-entropy sections).
func detectPacker(sections []string, entropies []float64) []string {
	var hits []string
	packNames := []string{"UPX", "aspack", "MPRESS", "themida", "vmprotect", ".themida", "petite", "nspack"}
	for _, name := range sections {
		lower := strings.ToLower(name)
		for _, p := range packNames {
			if strings.Contains(lower, p) {
				hits = append(hits, "section "+name+" matches "+p)
			}
		}
	}
	for i, e := range entropies {
		if e > 7.2 {
			name := fmt.Sprintf("#%d", i)
			if i < len(sections) {
				name = sections[i]
			}
			hits = append(hits, fmt.Sprintf("section %s entropy %.2f (packed?)", name, e))
		}
	}
	return hits
}

func (s *Service) sampleTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_sample",
		Description: "pj_sample: 样本体检。sha256/md5、大小、整体熵、文件类型（PE/ELF/MachO/原始）、" +
			"PE/ELF 节表（名称/大小/熵）、壳检测启发（UPX 等节名 + 高熵节）。文本回执，样本取自给定路径。",
		Schema: obj(map[string]any{
			"path": str("样本文件路径"),
		}, "path"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_sample: bad input: %v", err), nil
			}
			data, err := readFileCapped(input.Path)
			if err != nil {
				return errf("pj_sample: %v", err), nil
			}
			sum := sha256.Sum256(data)
			var b strings.Builder
			fmt.Fprintf(&b, "path=%s size=%d sha256=%s", filepath.Base(input.Path), len(data), hex.EncodeToString(sum[:]))
			kind := detectKind(data)
			fmt.Fprintf(&b, "\nkind=%s entropy=%.2f", kind, shannon(data))
			sections, entropies := sectionTable(data)
			if len(sections) > 0 {
				b.WriteString("\nsections:")
				for i, sec := range sections {
					fmt.Fprintf(&b, "\n  %s entropy=%.2f", sec, entropies[i])
				}
			}
			if hits := detectPacker(sections, entropies); len(hits) > 0 {
				b.WriteString("\npacker:")
				for _, h := range hits {
					b.WriteString("\n  " + h)
				}
			} else {
				b.WriteString("\npacker=none-detected")
			}
			return actool.Text(b.String()), nil
		},
	})
}

// detectKind sniffs the container format from magic bytes.
func detectKind(data []byte) string {
	if len(data) >= 2 && data[0] == 'M' && data[1] == 'Z' {
		return "PE (MZ)"
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return "ELF"
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0xcf, 0xfa, 0xed, 0xfe}) {
		return "MachO"
	}
	if len(data) >= 2 && bytes.Equal(data[:2], []byte{0x1f, 0x8b}) {
		return "gzip"
	}
	if len(data) >= 4 && bytes.Equal(data[:4], []byte("PK\x03\x04")) {
		return "zip"
	}
	return "raw"
}

// sectionTable extracts section names + per-section entropy for PE and ELF.
func sectionTable(data []byte) ([]string, []float64) {
	var names []string
	var ents []float64
	if f, err := pe.NewFile(bytes.NewReader(data)); err == nil {
		for _, sec := range f.Sections {
			names = append(names, sec.Name)
			if body, err := sec.Data(); err == nil {
				ents = append(ents, shannon(body))
			} else {
				ents = append(ents, -1)
			}
		}
		return names, ents
	}
	if f, err := elf.NewFile(bytes.NewReader(data)); err == nil {
		for _, sec := range f.Sections {
			names = append(names, sec.Name)
			if body, err := sec.Data(); err == nil {
				ents = append(ents, shannon(body))
			} else {
				ents = append(ents, -1)
			}
		}
		return names, ents
	}
	return nil, nil
}

// sectionEntry is a flat section record for VA→offset math.
type sectionEntry struct {
	name    string
	va      uint64 // virtual address (PE: image base + RVA)
	size    uint64 // virtual size
	rawOff  uint64 // file offset of raw data
	rawSize uint64
}

func peSections(data []byte) ([]sectionEntry, error) {
	f, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	base := uint64(0)
	if oh, ok := f.OptionalHeader.(*pe.OptionalHeader64); ok {
		base = oh.ImageBase
	} else if oh, ok := f.OptionalHeader.(*pe.OptionalHeader32); ok {
		base = uint64(oh.ImageBase)
	}
	var out []sectionEntry
	for _, sec := range f.Sections {
		out = append(out, sectionEntry{
			name:    sec.Name,
			va:      base + uint64(sec.VirtualAddress),
			size:    uint64(sec.VirtualSize),
			rawOff:  uint64(sec.Offset),
			rawSize: uint64(sec.Size),
		})
	}
	return out, nil
}

func elfSections(data []byte) ([]sectionEntry, error) {
	f, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out []sectionEntry
	for _, sec := range f.Sections {
		if sec.Type == elf.SHT_NOBITS {
			continue
		}
		out = append(out, sectionEntry{
			name:    sec.Name,
			va:      sec.Addr,
			size:    sec.Size,
			rawOff:  sec.Offset,
			rawSize: sec.Size,
		})
	}
	return out, nil
}

// vaToOffset translates a virtual address to a file offset via the section
// table; unknown VA → error.
func vaToOffset(data []byte, va uint64) (uint64, string, error) {
	sections, err := peSections(data)
	if err != nil {
		sections, err = elfSections(data)
		if err != nil {
			return 0, "", fmt.Errorf("neither PE nor ELF: %v", err)
		}
	}
	for _, sec := range sections {
		if va >= sec.va && va < sec.va+sec.size {
			if va-sec.va >= sec.rawSize {
				return 0, sec.name, fmt.Errorf("VA %#x in %s but beyond raw data", va, sec.name)
			}
			return sec.rawOff + (va - sec.va), sec.name, nil
		}
	}
	return 0, "", fmt.Errorf("VA %#x not in any section", va)
}

func (s *Service) va2offTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_va2off",
		Description: "pj_va2off: 虚拟地址 → 文件偏移（PE 节表 / ELF 节表，纯 Go 解析）。回执带所在节名。",
		Schema: obj(map[string]any{
			"path": str("样本文件路径"),
			"va":   str("虚拟地址（0x 前缀十六进制或十进制）"),
		}, "path", "va"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Path string `json:"path"`
				VA   string `json:"va"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_va2off: bad input: %v", err), nil
			}
			data, err := readFileCapped(input.Path)
			if err != nil {
				return errf("pj_va2off: %v", err), nil
			}
			va, err := parseUint(input.VA)
			if err != nil {
				return errf("pj_va2off: bad va %q: %v", input.VA, err), nil
			}
			off, section, err := vaToOffset(data, va)
			if err != nil {
				return errf("pj_va2off: %v", err), nil
			}
			return actool.Text(fmt.Sprintf("va=%#x → offset=%#x (section %s)", va, off, section)), nil
		},
	})
}

func parseUint(s string) (uint64, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		return strconv.ParseUint(s[2:], 16, 64)
	}
	return strconv.ParseUint(s, 10, 64)
}

// aobMatch finds all occurrences of a hex pattern with ?? wildcards.
func aobMatch(data []byte, pattern []byte, mask []bool) []int {
	var hits []int
	if len(pattern) == 0 || len(pattern) > len(data) {
		return nil
	}
	for i := 0; i+len(pattern) <= len(data); i++ {
		ok := true
		for j, p := range pattern {
			if mask[j] && data[i+j] != p {
				ok = false
				break
			}
		}
		if ok {
			hits = append(hits, i)
			if len(hits) >= 256 {
				break // cap: enough for any manual workflow
			}
		}
	}
	return hits
}

// parseAOB turns "AA BB ?? DD" into pattern bytes + mask.
func parseAOB(s string) ([]byte, []bool, error) {
	fields := strings.Fields(strings.Join(strings.Fields(s), " "))
	if len(fields) == 0 {
		return nil, nil, fmt.Errorf("empty pattern")
	}
	var pattern []byte
	var mask []bool
	for _, f := range fields {
		if f == "??" || f == "?" {
			pattern = append(pattern, 0)
			mask = append(mask, false)
			continue
		}
		v, err := strconv.ParseUint(f, 16, 8)
		if err != nil {
			return nil, nil, fmt.Errorf("bad hex byte %q", f)
		}
		pattern = append(pattern, byte(v))
		mask = append(mask, true)
	}
	return pattern, mask, nil
}

func (s *Service) aobTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_aob",
		Description: "pj_aob: 字节模式搜索（AOB，?? 通配），回执列出全部命中偏移（上限 256）。",
		Schema: obj(map[string]any{
			"path":    str("样本文件路径"),
			"pattern": str("十六进制字节模式，空格分隔，?? 通配（如 \"55 8B EC ?? ??\"）"),
		}, "path", "pattern"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Path    string `json:"path"`
				Pattern string `json:"pattern"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_aob: bad input: %v", err), nil
			}
			data, err := readFileCapped(input.Path)
			if err != nil {
				return errf("pj_aob: %v", err), nil
			}
			pattern, mask, err := parseAOB(input.Pattern)
			if err != nil {
				return errf("pj_aob: %v", err), nil
			}
			hits := aobMatch(data, pattern, mask)
			if len(hits) == 0 {
				return actool.Text("no hits"), nil
			}
			var b strings.Builder
			fmt.Fprintf(&b, "hits=%d", len(hits))
			for _, h := range hits {
				fmt.Fprintf(&b, "\n  offset=%#x", h)
			}
			return actool.Text(b.String()), nil
		},
	})
}

// asciiStrings extracts printable ASCII runs of at least minLen bytes.
func asciiStrings(data []byte, minLen int) []string {
	var out []string
	start := -1
	for i, b := range data {
		if b >= 0x20 && b < 0x7f {
			if start < 0 {
				start = i
			}
		} else {
			if start >= 0 && i-start >= minLen {
				out = append(out, string(data[start:i]))
			}
			start = -1
		}
	}
	if start >= 0 && len(data)-start >= minLen {
		out = append(out, string(data[start:]))
	}
	return out
}

var (
	iocURL     = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>]{4,}`)
	iocIP      = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	iocReg     = regexp.MustCompile(`(?i)\bHKEY_[A-Z_]+\\[^\s"]{2,}`)
	iocPath    = regexp.MustCompile(`(?i)\b[A-Z]:\\[^\s"]{3,}`)
	iocEmail   = regexp.MustCompile(`\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b`)
)

// dedupe keeps the first n unique strings.
func dedupe(in []string, n int) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
			if len(out) >= n {
				break
			}
		}
	}
	return out
}

func (s *Service) scanTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_scan",
		Description: "pj_scan: 样本 IOC 扫描（URL/IP/注册表/文件路径/邮箱）+ 字符串统计 + 高熵提示。文本回执。",
		Schema: obj(map[string]any{
			"path": str("样本文件路径"),
		}, "path"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_scan: bad input: %v", err), nil
			}
			data, err := readFileCapped(input.Path)
			if err != nil {
				return errf("pj_scan: %v", err), nil
			}
			strs := asciiStrings(data, 6)
			var b strings.Builder
			fmt.Fprintf(&b, "strings=%d entropy=%.2f kind=%s", len(strs), shannon(data), detectKind(data))
			collect := func(label string, re *regexp.Regexp, cap int) {
				var hits []string
				for _, s := range strs {
					for _, m := range re.FindAllString(s, -1) {
						hits = append(hits, m)
					}
				}
				uniq := dedupe(hits, cap)
				fmt.Fprintf(&b, "\n%s=%d", label, len(hits))
				for _, h := range uniq {
					fmt.Fprintf(&b, "\n  %s", h)
				}
			}
			collect("urls", iocURL, 20)
			collect("ips", iocIP, 20)
			collect("registry", iocReg, 10)
			collect("paths", iocPath, 10)
			collect("emails", iocEmail, 10)
			return actool.Text(b.String()), nil
		},
	})
}

// objdumpAvailable reports whether objdump is on PATH (degradation probe).
func objdumpAvailable() bool {
	_, err := exec.LookPath("objdump")
	return err == nil
}

func (s *Service) decompileTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_decompile",
		Description: "pj_decompile: 反汇编/反编译，带降级路径。有 objdump → 反汇编节（cap 行数）；" +
			"无 objdump → 字符串头部 + 节表摘要（降级）。有 idalib/frida 的环境可在上层另行挂 pj_engine。" +
			"回执注明使用的引擎。",
		Schema: obj(map[string]any{
			"path":    str("样本文件路径"),
			"lines":   map[string]any{"type": "integer", "description": "反汇编输出行数上限（可选，默认 80）"},
			"strings": map[string]any{"type": "integer", "description": "降级模式下字符串条数（可选，默认 30）"},
		}, "path"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Path    string `json:"path"`
				Lines   int    `json:"lines"`
				Strings int    `json:"strings"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_decompile: bad input: %v", err), nil
			}
			if input.Lines <= 0 {
				input.Lines = 80
			}
			if input.Strings <= 0 {
				input.Strings = 30
			}
			if input.Lines > 400 {
				input.Lines = 400
			}
			data, err := readFileCapped(input.Path)
			if err != nil {
				return errf("pj_decompile: %v", err), nil
			}
			kind := detectKind(data)
			if objdumpAvailable() && (strings.HasPrefix(kind, "PE") || kind == "ELF") {
				out, err := exec.Command("objdump", "-d", input.Path).Output()
				if err == nil && len(out) > 0 {
					lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
					if len(lines) > input.Lines {
						lines = lines[:input.Lines]
					}
					var b strings.Builder
					fmt.Fprintf(&b, "engine=objdump kind=%s lines_shown=%d\n", kind, len(lines))
					b.WriteString(strings.Join(lines, "\n"))
					return actool.Text(b.String()), nil
				}
			}
			// Degradation: strings + section summary.
			strs := dedupe(asciiStrings(data, 8), input.Strings)
			sections, _ := sectionTable(data)
			var b strings.Builder
			fmt.Fprintf(&b, "engine=strings-degraded kind=%s objdump_available=%v\n", kind, objdumpAvailable())
			if len(sections) > 0 {
				fmt.Fprintf(&b, "sections=%s\n", strings.Join(sections, ","))
			}
			b.WriteString("strings:")
			for _, s := range strs {
				b.WriteString("\n  " + s)
			}
			return actool.Text(b.String()), nil
		},
	})
}

func (s *Service) bindiffTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_bindiff",
		Description: "pj_bindiff: 两个文件的字节级差异（同长度逐字节 diff，不同长度给出公共前缀/后缀与差异比例）。文本回执。",
		Schema: obj(map[string]any{
			"a": str("文件 A 路径"),
			"b": str("文件 B 路径"),
		}, "a", "b"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				A string `json:"a"`
				B string `json:"b"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_bindiff: bad input: %v", err), nil
			}
			da, err := readFileCapped(input.A)
			if err != nil {
				return errf("pj_bindiff: a: %v", err), nil
			}
			db, err := readFileCapped(input.B)
			if err != nil {
				return errf("pj_bindiff: b: %v", err), nil
			}
			var b strings.Builder
			fmt.Fprintf(&b, "a_size=%d b_size=%d", len(da), len(db))
			if len(da) != len(db) {
				prefix := commonPrefix(da, db)
				suffix := commonSuffix(da, db)
				fmt.Fprintf(&b, "\ndifferent sizes; common prefix=%d suffix=%d", prefix, suffix)
				return actool.Text(b.String()), nil
			}
			diffs := 0
			var first []string
			for i := range da {
				if da[i] != db[i] {
					diffs++
					if len(first) < 16 {
						first = append(first, fmt.Sprintf("offset=%#x %02x→%02x", i, da[i], db[i]))
					}
				}
			}
			pct := 0.0
			if len(da) > 0 {
				pct = float64(diffs) / float64(len(da)) * 100
			}
			fmt.Fprintf(&b, "\nchanged_bytes=%d (%.2f%%)", diffs, pct)
			for _, d := range first {
				b.WriteString("\n  " + d)
			}
			return actool.Text(b.String()), nil
		},
	})
}

func commonPrefix(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

func commonSuffix(a, b []byte) int {
	i, j := len(a)-1, len(b)-1
	n := 0
	for i >= 0 && j >= 0 && a[i] == b[j] {
		i--
		j--
		n++
	}
	return n
}
