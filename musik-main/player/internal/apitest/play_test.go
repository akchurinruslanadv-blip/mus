package apitest

import (
	"encoding/json"
	"sync"
	"testing"
)

func TestIndependentRadioSessionsRunConcurrently(t *testing.T) {
	server := openTestServer(t)
	const clients = 8
	start := make(chan struct{})
	errs := make(chan string, clients)
	ids := make(chan string, clients)
	var wg sync.WaitGroup
	wg.Add(clients)
	for i := 0; i < clients; i++ {
		go func() {
			defer wg.Done()
			<-start
			rec := serve(server, jsonReq("POST", "/api/radio/start", `{}`))
			if rec.Code != 200 {
				errs <- rec.Body.String()
				return
			}
			var body struct {
				SessionID string `json:"session_id"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				errs <- err.Error()
				return
			}
			ids <- body.SessionID
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		t.Error(err)
	}
	seen := map[string]bool{}
	for id := range ids {
		if id == "" || seen[id] {
			t.Fatalf("bad or duplicate session id %q", id)
		}
		seen[id] = true
	}
	if len(seen) != clients {
		t.Fatalf("sessions=%d, want %d", len(seen), clients)
	}
	flush(server)
}
