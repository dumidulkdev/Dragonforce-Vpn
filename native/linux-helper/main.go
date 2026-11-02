// DragonForce Linux network helper. This binary must be installed root-owned
// and invoked through the matching polkit action; it never accepts shell text.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const (
	ipBinary    = "/usr/bin/ip"
	runtimeDir  = "/run/dragonforce-vpn"
	tunName     = "dfvpn0"
	tunCIDR     = "198.18.0.1/15"
	routeMetric = "5"
	routeTable  = "51888"
)

var (
	sessionPattern   = regexp.MustCompile(`^[a-f0-9-]{16,64}$`)
	interfacePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)
)

type request struct {
	Action    string `json:"action"`
	SessionID string `json:"sessionId,omitempty"`
	Endpoint  string `json:"endpoint,omitempty"`
	Gateway   string `json:"gateway,omitempty"`
	Interface string `json:"interface,omitempty"`
}

type response struct {
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

type sessionState struct {
	SessionID   string            `json:"sessionId"`
	OwnerUID    int               `json:"ownerUid"`
	Endpoint    string            `json:"endpoint"`
	Gateway     string            `json:"gateway"`
	Interface   string            `json:"interface"`
	TunOwned    bool              `json:"tunOwned"`
	TunAliasSet bool              `json:"tunAliasSet"`
	Mutations   []networkMutation `json:"mutations"`
}

type networkMutation struct {
	Role       string   `json:"role"`
	DeleteArgs []string `json:"deleteArgs"`
}

type commandRunner interface {
	Run(args ...string) ([]byte, error)
}

type realRunner struct{}

func (realRunner) Run(args ...string) ([]byte, error) {
	cmd := exec.Command(ipBinary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", ipBinary, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

type helper struct {
	mu       sync.Mutex
	runner   commandRunner
	stateDir string
	state    *sessionState
}

type routeRecord struct {
	Gateway string `json:"gateway"`
	Dev     string `json:"dev"`
	Type    string `json:"type"`
	Table   any    `json:"table"`
}

type linkRecord struct {
	Alias string `json:"ifalias"`
}

type ruleRecord struct {
	Priority int `json:"priority"`
}

func ipv4(value string) bool {
	ip := net.ParseIP(value)
	return ip != nil && ip.To4() != nil
}

func validateSession(req request, ownerUID int) error {
	if !sessionPattern.MatchString(req.SessionID) {
		return errors.New("invalid session identifier")
	}
	if ownerUID <= 0 {
		return errors.New("the invoking desktop user must be unprivileged")
	}
	if !ipv4(req.Endpoint) || !ipv4(req.Gateway) {
		return errors.New("Linux TUN MVP requires IPv4 endpoint and gateway addresses")
	}
	if !interfacePattern.MatchString(req.Interface) || req.Interface == tunName {
		return errors.New("invalid physical interface")
	}
	return nil
}

func (h *helper) statePath() string { return filepath.Join(h.stateDir, "session.json") }

func (h *helper) saveLocked() error {
	if h.state == nil {
		if err := os.Remove(h.statePath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	bytes, err := json.Marshal(h.state)
	if err != nil {
		return err
	}
	temporary := h.statePath() + ".tmp"
	if err := os.WriteFile(temporary, append(bytes, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, h.statePath())
}

func (h *helper) loadStale() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	bytes, err := os.ReadFile(h.statePath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var stale sessionState
	if err := json.Unmarshal(bytes, &stale); err != nil {
		return fmt.Errorf("invalid stale network journal: %w", err)
	}
	h.state = &stale
	return h.cleanupLocked()
}

func (h *helper) hasIPv6Default() (bool, error) {
	out, err := h.runner.Run("-6", "-json", "route", "show", "default")
	if err != nil {
		return false, err
	}
	var routes []json.RawMessage
	if err := json.Unmarshal(out, &routes); err != nil {
		return false, fmt.Errorf("could not parse IPv6 routes: %w", err)
	}
	return len(routes) > 0, nil
}

func (h *helper) validateEgress(endpoint, gateway, interfaceName string) error {
	out, err := h.runner.Run("-4", "-json", "route", "get", endpoint)
	if err != nil {
		return err
	}
	var routes []routeRecord
	if err := json.Unmarshal(out, &routes); err != nil || len(routes) != 1 {
		return errors.New("endpoint route must resolve to exactly one IPv4 egress")
	}
	route := routes[0]
	if route.Type != "" && route.Type != "unicast" {
		return fmt.Errorf("unsupported endpoint route type %q", route.Type)
	}
	if !mainRouteTable(route.Table) {
		return errors.New("policy-routing and non-main endpoint tables are not supported by the Linux TUN MVP")
	}
	if route.Dev != interfaceName || route.Gateway != gateway {
		return errors.New("physical route changed during authorization")
	}
	if _, err := h.runner.Run("-json", "link", "show", "dev", interfaceName); err != nil {
		return fmt.Errorf("physical interface is unavailable: %w", err)
	}
	return nil
}

func mainRouteTable(value any) bool {
	switch table := value.(type) {
	case nil:
		return true
	case string:
		return table == "main" || table == "254"
	case float64:
		return table == 254
	default:
		return false
	}
}

func (h *helper) routeExists(prefix string) (bool, error) {
	out, err := h.runner.Run("-4", "-json", "route", "show", "exact", prefix)
	if err != nil {
		return false, err
	}
	var routes []json.RawMessage
	if err := json.Unmarshal(out, &routes); err != nil {
		return false, fmt.Errorf("could not parse route %s: %w", prefix, err)
	}
	return len(routes) > 0, nil
}

func (h *helper) tunExists() bool {
	out, err := h.runner.Run("-json", "link", "show", "dev", tunName)
	return err == nil && len(strings.TrimSpace(string(out))) > 2
}

func (h *helper) tunOwnedBySession() (bool, bool, error) {
	out, err := h.runner.Run("-details", "-json", "link", "show", "dev", tunName)
	if err != nil {
		if missingMutation(err) {
			return false, false, nil
		}
		return false, false, err
	}
	var links []linkRecord
	if err := json.Unmarshal(out, &links); err != nil || len(links) != 1 {
		return false, true, errors.New("could not verify DragonForce TUN ownership")
	}
	alias := links[0].Alias
	return alias == "dragonforce-vpn:"+h.state.SessionID || (!h.state.TunAliasSet && alias == ""), true, nil
}

func (h *helper) prepare(req request, ownerUID int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state != nil {
		return errors.New("a network session is already prepared")
	}
	if err := validateSession(req, ownerUID); err != nil {
		return err
	}
	activeIPv6, err := h.hasIPv6Default()
	if err != nil {
		return err
	}
	if activeIPv6 {
		return errors.New("an active IPv6 default route is present; IPv4-only TUN mode was refused to prevent leaks")
	}
	if err := h.validateEgress(req.Endpoint, req.Gateway, req.Interface); err != nil {
		return err
	}
	if h.tunExists() {
		return fmt.Errorf("interface %s already exists and is not owned by this session", tunName)
	}
	endpointPrefix := req.Endpoint + "/32"
	exists, err := h.routeExists(endpointPrefix)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("endpoint route %s already exists; refusing to replace it", endpointPrefix)
	}

	h.state = &sessionState{
		SessionID: req.SessionID, OwnerUID: ownerUID, Endpoint: req.Endpoint,
		Gateway: req.Gateway, Interface: req.Interface,
	}
	if err := h.saveLocked(); err != nil {
		h.state = nil
		return err
	}
	h.state.TunOwned = true
	if err := h.saveLocked(); err != nil {
		h.state = nil
		return err
	}
	if _, err := h.runner.Run("tuntap", "add", "dev", tunName, "mode", "tun", "user", strconv.Itoa(ownerUID)); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	if _, err := h.runner.Run("link", "set", "dev", tunName, "alias", "dragonforce-vpn:"+req.SessionID); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	h.state.TunAliasSet = true
	if err := h.saveLocked(); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	if _, err := h.runner.Run("addr", "add", tunCIDR, "dev", tunName); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	if _, err := h.runner.Run("link", "set", "dev", tunName, "mtu", "1420", "up"); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	if err := h.addMutationLocked("endpoint",
		[]string{"-4", "route", "add", endpointPrefix, "via", req.Gateway, "dev", req.Interface, "proto", "static", "metric", routeMetric},
		[]string{"-4", "route", "del", endpointPrefix, "via", req.Gateway, "dev", req.Interface, "proto", "static", "metric", routeMetric},
	); err != nil {
		_ = h.cleanupLocked()
		return err
	}
	return h.saveLocked()
}

func (h *helper) activate() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state == nil || !h.state.TunOwned || !h.hasMutationRole("endpoint") {
		return errors.New("network session is not prepared")
	}
	if err := h.validatePolicyRoutingLocked(); err != nil {
		return err
	}
	endpointPrefix := h.state.Endpoint + "/32"
	mutations := []struct {
		add []string
		del []string
	}{
		{[]string{"-6", "route", "add", "unreachable", "default", "table", routeTable, "proto", "static"}, []string{"-6", "route", "del", "unreachable", "default", "table", routeTable, "proto", "static"}},
		{[]string{"-6", "rule", "add", "priority", "100", "table", routeTable}, []string{"-6", "rule", "del", "priority", "100", "table", routeTable}},
		{[]string{"-4", "route", "add", "default", "dev", tunName, "table", routeTable, "proto", "static"}, []string{"-4", "route", "del", "default", "dev", tunName, "table", routeTable, "proto", "static"}},
		{[]string{"-4", "rule", "add", "priority", "90", "to", endpointPrefix, "table", "main"}, []string{"-4", "rule", "del", "priority", "90", "to", endpointPrefix, "table", "main"}},
		{[]string{"-4", "rule", "add", "priority", "95", "oif", h.state.Interface, "table", "main"}, []string{"-4", "rule", "del", "priority", "95", "oif", h.state.Interface, "table", "main"}},
		{[]string{"-4", "rule", "add", "priority", "100", "table", routeTable}, []string{"-4", "rule", "del", "priority", "100", "table", routeTable}},
	}
	for _, mutation := range mutations {
		if err := h.addMutationLocked("capture", mutation.add, mutation.del); err != nil {
			_ = h.deactivateLocked()
			return err
		}
	}
	return nil
}

func (h *helper) hasMutationRole(role string) bool {
	for _, mutation := range h.state.Mutations {
		if mutation.Role == role {
			return true
		}
	}
	return false
}

func (h *helper) addMutationLocked(role string, addArgs, deleteArgs []string) error {
	h.state.Mutations = append(h.state.Mutations, networkMutation{Role: role, DeleteArgs: deleteArgs})
	if err := h.saveLocked(); err != nil {
		h.state.Mutations = h.state.Mutations[:len(h.state.Mutations)-1]
		return err
	}
	if _, err := h.runner.Run(addArgs...); err != nil {
		h.state.Mutations = h.state.Mutations[:len(h.state.Mutations)-1]
		_ = h.saveLocked()
		return err
	}
	return nil
}

func (h *helper) validatePolicyRoutingLocked() error {
	for _, family := range []string{"-4", "-6"} {
		out, err := h.runner.Run(family, "-json", "rule", "show")
		if err != nil {
			return err
		}
		var rules []ruleRecord
		if err := json.Unmarshal(out, &rules); err != nil {
			return fmt.Errorf("could not parse %s policy rules: %w", family, err)
		}
		for _, rule := range rules {
			if rule.Priority > 0 && rule.Priority <= 100 {
				return fmt.Errorf("existing %s policy rule priority %d conflicts with secure TUN capture", family, rule.Priority)
			}
		}
		out, err = h.runner.Run(family, "-json", "route", "show", "table", routeTable)
		if err != nil {
			// iproute2 reports a missing, therefore unused, table as an error.
			if strings.Contains(strings.ToLower(err.Error()), "fib table does not exist") {
				continue
			}
			return err
		}
		var routes []json.RawMessage
		if err := json.Unmarshal(out, &routes); err != nil || len(routes) != 0 {
			return fmt.Errorf("routing table %s is already in use", routeTable)
		}
	}
	return nil
}

func missingMutation(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "no such process") || strings.Contains(text, "cannot find device") ||
		strings.Contains(text, "does not exist") || strings.Contains(text, "no such device")
}

func (h *helper) deleteMutation(args ...string) error {
	_, err := h.runner.Run(args...)
	if missingMutation(err) {
		return nil
	}
	return err
}

func (h *helper) deactivateLocked() error {
	if h.state == nil {
		return nil
	}
	for i := len(h.state.Mutations) - 1; i >= 0; i-- {
		mutation := h.state.Mutations[i]
		if mutation.Role != "capture" {
			continue
		}
		if err := h.deleteMutation(mutation.DeleteArgs...); err != nil {
			return err
		}
		h.state.Mutations = append(h.state.Mutations[:i], h.state.Mutations[i+1:]...)
		if err := h.saveLocked(); err != nil {
			return err
		}
	}
	return nil
}

func (h *helper) deactivate() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.deactivateLocked()
}

func (h *helper) cleanupLocked() error {
	if h.state == nil {
		return nil
	}
	if err := h.deactivateLocked(); err != nil {
		// Keep endpoint bypass and the TUN in place while capture cleanup is unresolved.
		return err
	}
	for i := len(h.state.Mutations) - 1; i >= 0; i-- {
		mutation := h.state.Mutations[i]
		if err := h.deleteMutation(mutation.DeleteArgs...); err != nil {
			return err
		}
		h.state.Mutations = append(h.state.Mutations[:i], h.state.Mutations[i+1:]...)
		if err := h.saveLocked(); err != nil {
			return err
		}
	}
	var failures []string
	if h.state.TunOwned {
		owned, exists, ownershipError := h.tunOwnedBySession()
		if ownershipError != nil {
			failures = append(failures, ownershipError.Error())
		} else if exists && !owned {
			failures = append(failures, "refusing to delete a TUN interface not owned by this DragonForce session")
		} else if !exists {
			h.state.TunOwned = false
			_ = h.saveLocked()
		} else if _, err := h.runner.Run("link", "delete", "dev", tunName); err != nil && !missingMutation(err) {
			failures = append(failures, err.Error())
		} else {
			h.state.TunOwned = false
			_ = h.saveLocked()
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	h.state = nil
	return h.saveLocked()
}

func (h *helper) cleanup() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cleanupLocked()
}

func (h *helper) handle(req request, ownerUID int) error {
	switch req.Action {
	case "prepare":
		return h.prepare(req, ownerUID)
	case "activate":
		return h.activate()
	case "deactivate":
		return h.deactivate()
	case "cleanup":
		return h.cleanup()
	default:
		return errors.New("unsupported helper action")
	}
}

func writeResponse(encoder *json.Encoder, action string, err error) {
	result := response{Action: action, OK: err == nil}
	if err != nil {
		result.Error = err.Error()
	}
	_ = encoder.Encode(result)
}

func invokingUID() (int, error) {
	raw := os.Getenv("PKEXEC_UID")
	uid, err := strconv.Atoi(raw)
	if err != nil || uid <= 0 {
		return 0, errors.New("PKEXEC_UID must identify an unprivileged desktop user")
	}
	return uid, nil
}

func acquireLock(directory string) (*os.File, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(directory, "helper.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, errors.New("another DragonForce network helper is active")
	}
	return file, nil
}

func main() {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "dragonforce-net-helper must run through polkit")
		os.Exit(1)
	}
	uid, err := invokingUID()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	lock, err := acquireLock(runtimeDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer lock.Close()

	h := &helper{runner: realRunner{}, stateDir: runtimeDir}
	encoder := json.NewEncoder(os.Stdout)
	if err := h.loadStale(); err != nil {
		writeResponse(encoder, "ready", fmt.Errorf("stale network cleanup failed: %w", err))
		return
	}
	writeResponse(encoder, "ready", nil)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		if err := h.cleanup(); err != nil {
			fmt.Fprintln(os.Stderr, "network cleanup failed:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), 16*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			writeResponse(encoder, "invalid", errors.New("invalid helper request"))
			continue
		}
		err := h.handle(req, uid)
		writeResponse(encoder, req.Action, err)
		if req.Action == "cleanup" && err == nil {
			return
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "helper protocol failed:", err)
	}
	if err := h.cleanup(); err != nil {
		fmt.Fprintln(os.Stderr, "network cleanup failed:", err)
		os.Exit(1)
	}
}
