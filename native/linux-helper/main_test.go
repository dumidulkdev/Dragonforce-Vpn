package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fakeRunner struct {
	calls  [][]string
	ipv6   bool
	tun    bool
	alias  string
	failOn string
}

func (f *fakeRunner) Run(args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string(nil), args...))
	joined := strings.Join(args, " ")
	if f.failOn != "" && strings.Contains(joined, f.failOn) {
		return nil, errors.New("simulated command failure")
	}
	switch {
	case joined == "-6 -json route show default":
		if f.ipv6 {
			return []byte(`[{"dst":"default","dev":"eth0"}]`), nil
		}
		return []byte(`[]`), nil
	case strings.HasPrefix(joined, "-4 -json route get "):
		return []byte(`[{"gateway":"192.0.2.1","dev":"eth0","type":"unicast"}]`), nil
	case joined == "-json link show dev eth0":
		return []byte(`[{"ifindex":2,"ifname":"eth0"}]`), nil
	case joined == "-json link show dev dfvpn0":
		if f.tun {
			return []byte(`[{"ifindex":10,"ifname":"dfvpn0"}]`), nil
		}
		return nil, errors.New("Cannot find device")
	case joined == "-details -json link show dev dfvpn0":
		if f.tun {
			return []byte(`[{"ifalias":"` + f.alias + `"}]`), nil
		}
		return nil, errors.New("Cannot find device")
	case strings.Contains(joined, "-json route show exact"):
		return []byte(`[]`), nil
	case strings.Contains(joined, "-json rule show"):
		return []byte(`[{"priority":0},{"priority":32766},{"priority":32767}]`), nil
	case strings.Contains(joined, "-json route show table 51888"):
		return []byte(`[]`), nil
	default:
		if strings.HasPrefix(joined, "tuntap add dev dfvpn0") {
			f.tun = true
		}
		if strings.HasPrefix(joined, "link set dev dfvpn0 alias ") {
			f.alias = strings.TrimPrefix(joined, "link set dev dfvpn0 alias ")
		}
		if joined == "link delete dev dfvpn0" {
			f.tun = false
		}
		return []byte{}, nil
	}
}

func testRequest() request {
	return request{
		Action: "prepare", SessionID: "12345678-1234-1234-1234-123456789abc",
		Endpoint: "203.0.113.7", Gateway: "192.0.2.1", Interface: "eth0",
	}
}

func TestPrepareActivateAndIdempotentCleanup(t *testing.T) {
	dir := t.TempDir()
	runner := &fakeRunner{}
	h := &helper{runner: runner, stateDir: dir}
	if err := h.prepare(testRequest(), 1000); err != nil {
		t.Fatal(err)
	}
	if err := h.activate(); err != nil {
		t.Fatal(err)
	}
	roles := make([]string, len(h.state.Mutations))
	for i, mutation := range h.state.Mutations {
		roles[i] = mutation.Role
	}
	if !reflect.DeepEqual(roles, []string{"endpoint", "capture", "capture", "capture", "capture", "capture", "capture"}) {
		t.Fatalf("unexpected mutation journal: %#v", h.state.Mutations)
	}
	if err := h.deactivate(); err != nil {
		t.Fatal(err)
	}
	if err := h.cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := h.cleanup(); err != nil {
		t.Fatalf("second cleanup was not idempotent: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "session.json")); !os.IsNotExist(err) {
		t.Fatalf("journal remains after cleanup: %v", err)
	}
	joined := make([]string, len(runner.calls))
	for i, call := range runner.calls {
		joined[i] = strings.Join(call, " ")
	}
	for _, expected := range []string{
		"tuntap add dev dfvpn0 mode tun user 1000",
		"-4 route add 203.0.113.7/32 via 192.0.2.1 dev eth0 proto static metric 5",
		"-6 route add unreachable default table 51888 proto static",
		"-4 route add default dev dfvpn0 table 51888 proto static",
		"-4 rule add priority 100 table 51888",
		"link delete dev dfvpn0",
	} {
		if !contains(joined, expected) {
			t.Fatalf("missing command %q in %#v", expected, joined)
		}
	}
}

func TestPrepareRefusesIPv6Default(t *testing.T) {
	runner := &fakeRunner{ipv6: true}
	h := &helper{runner: runner, stateDir: t.TempDir()}
	err := h.prepare(testRequest(), 1000)
	if err == nil || !strings.Contains(err.Error(), "IPv6 default route") {
		t.Fatalf("expected IPv6 refusal, got %v", err)
	}
	if h.state != nil {
		t.Fatal("state was created despite IPv6 refusal")
	}
}

func TestRequestValidation(t *testing.T) {
	req := testRequest()
	req.Interface = "bad interface"
	if err := validateSession(req, 1000); err == nil {
		t.Fatal("invalid interface was accepted")
	}
	req = testRequest()
	req.Endpoint = "2001:db8::1"
	if err := validateSession(req, 1000); err == nil {
		t.Fatal("IPv6 endpoint was accepted")
	}
	if err := validateSession(testRequest(), 0); err == nil {
		t.Fatal("root desktop user was accepted")
	}
}

func TestPartialActivationRollsBackCaptureJournal(t *testing.T) {
	runner := &fakeRunner{}
	h := &helper{runner: runner, stateDir: t.TempDir()}
	if err := h.prepare(testRequest(), 1000); err != nil {
		t.Fatal(err)
	}
	runner.failOn = "-4 rule add priority 100 table 51888"
	if err := h.activate(); err == nil {
		t.Fatal("expected activation failure")
	}
	for _, mutation := range h.state.Mutations {
		if mutation.Role == "capture" {
			t.Fatalf("capture journal was not rolled back: %#v", h.state.Mutations)
		}
	}
	runner.failOn = ""
	if err := h.cleanup(); err != nil {
		t.Fatal(err)
	}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
