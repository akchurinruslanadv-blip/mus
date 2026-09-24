package apitest

import (
	"encoding/json"
	"testing"

	"github.com/torwin-job/musik/player/internal/auth"
)

func TestAuthDisabledLoginAndMe(t *testing.T) {
	server := openTestServer(t)

	rec := serve(server, jsonReq("POST", "/api/auth/login", `{"password":"x"}`))
	if rec.Code != 200 {
		t.Fatalf("login status=%d", rec.Code)
	}
	var login map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &login); err != nil {
		t.Fatal(err)
	}
	if login["auth"] != false {
		t.Fatalf("expected auth=false when disabled: %#v", login)
	}

	rec = serve(server, jsonReq("GET", "/api/auth/me", ""))
	var me struct {
		OK          bool `json:"ok"`
		AuthEnabled bool `json:"auth_enabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.OK || me.AuthEnabled {
		t.Fatalf("me=%+v", me)
	}

	rec = serve(server, jsonReq("POST", "/api/auth/logout", ""))
	if rec.Code != 200 {
		t.Fatalf("logout status=%d", rec.Code)
	}
}

func TestAuthPasswordLoginCookieAndReject(t *testing.T) {
	server := openTestServer(t)
	server.Cfg.AuthDisabled = false
	server.Cfg.Password = "secret"
	server.Auth = auth.New(auth.Config{
		Password: "secret", APIToken: "tok", Disabled: false,
	})

	bad := jsonReq("POST", "/api/auth/login", `{"password":"nope"}`)
	bad.RemoteAddr = "10.0.0.1:1234"
	rec := serve(server, bad)
	if rec.Code != 401 {
		t.Fatalf("bad password status=%d", rec.Code)
	}

	okReq := jsonReq("POST", "/api/auth/login", `{"password":"secret"}`)
	okReq.RemoteAddr = "10.0.0.2:1234"
	rec = serve(server, okReq)
	if rec.Code != 200 {
		t.Fatalf("good password status=%d body=%s", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()
	if len(cookie) == 0 || cookie[0].Name != auth.CookieName {
		t.Fatalf("expected session cookie, got %#v", cookie)
	}

	meReq := jsonReq("GET", "/api/auth/me", "")
	meReq.AddCookie(cookie[0])
	rec = serve(server, meReq)
	var me struct {
		OK          bool `json:"ok"`
		AuthEnabled bool `json:"auth_enabled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.OK || !me.AuthEnabled {
		t.Fatalf("authorized me=%+v", me)
	}

	bearer := jsonReq("GET", "/api/auth/me", "")
	bearer.Header.Set("Authorization", "Bearer tok")
	rec = serve(server, bearer)
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if !me.OK {
		t.Fatal("bearer token should authorize /me")
	}
}

func TestAuthLoginRateLimit(t *testing.T) {
	server := openTestServer(t)
	server.Auth = auth.New(auth.Config{Password: "secret"})

	for i := 0; i < 5; i++ {
		req := jsonReq("POST", "/api/auth/login", `{"password":"x"}`)
		req.RemoteAddr = "10.9.9.9:1"
		rec := serve(server, req)
		if rec.Code != 401 {
			t.Fatalf("attempt %d status=%d", i, rec.Code)
		}
	}
	req := jsonReq("POST", "/api/auth/login", `{"password":"secret"}`)
	req.RemoteAddr = "10.9.9.9:1"
	rec := serve(server, req)
	if rec.Code != 429 {
		t.Fatalf("rate limit status=%d, want 429", rec.Code)
	}
}
